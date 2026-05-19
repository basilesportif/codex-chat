import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { DirectiveAction } from "./directives.js";
import { StateStore } from "./state.js";
import { Route, SubagentBackendKind, SubagentJob } from "./types.js";
import {
  ChildAgentBackend,
  ChildAgentFinish,
  CodexAppServerChildAgentBackend,
  CodexExecChildAgentBackend,
  StartedChildAgent
} from "./subagent-backends.js";
import { ensureDir, makeId, nowIso, pathExists } from "./util.js";

const SIGKILL_GRACE_MS = 5_000;
const MAX_QUEUE_DEPTH = 200;
const REMOTE_REPO_AUTHORITY_RULES = [
  "Remote repo authority:",
  "- When a task mentions repo-registry, a dev server, or a repo path that may be registered remotely, first resolve the authoritative location from `/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml`.",
  "- In that registry, `host: local` or a missing host means local; any other `host` value, such as `tim@89.167.72.52`, is authoritative remote.",
  "- For remote registry entries, verify files and git state over SSH on the registered host and path, for example `ssh <host> \"cd <path> && ...\"`. Do not substitute same-looking local paths such as `/home/tim/...`, and do not treat `.claude/repo-registry/repos/<alias>` as the repo checkout.",
  "- For env files, credentials, and other likely secrets, verify only metadata such as existence, permissions, owner, size, line/key counts, git ignore status, and git tracking state. Do not print or inspect secret values."
].join("\n");

interface DispatchInput {
  id?: string;
  profile: string;
  prompt: string;
  route: Route;
  timeoutSec?: number;
  model?: string;
  effort?: string;
  summary?: string;
  images?: string[];
  originChatId?: number;
  originMessageId?: number;
}

interface SubagentCallbacks {
  onReturnToMain(job: SubagentJob, result: string): Promise<void>;
  onSendToUser(job: SubagentJob, result: string): Promise<void>;
}

interface RunningJob {
  job: SubagentJob;
  child: StartedChildAgent;
  backend: ChildAgentBackend;
  timeout: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

export interface JobRefCandidate {
  id: string;
  ref: string;
  status: SubagentJob["status"];
  profile: string;
  summary?: string;
}

export type JobRefResolution =
  | { status: "matched"; ref: string; job: SubagentJob }
  | { status: "not_found"; ref: string }
  | { status: "ambiguous"; ref: string; candidates: JobRefCandidate[] };

export type CancelJobResultStatus =
  | "success"
  | "not_found"
  | "ambiguous"
  | "already_terminal"
  | "already_cancelling";

export interface CancelJobResult {
  status: CancelJobResultStatus;
  ref: string;
  message: string;
  job?: SubagentJob;
  previousStatus?: SubagentJob["status"];
  candidates?: JobRefCandidate[];
}

export type SteerJobResultStatus =
  | "success"
  | "not_found"
  | "ambiguous"
  | "not_running"
  | "unsupported_backend"
  | "not_steerable"
  | "failed";

export interface SteerJobResult {
  status: SteerJobResultStatus;
  ref: string;
  message: string;
  job?: SubagentJob;
  candidates?: JobRefCandidate[];
}

export interface SubagentBackendStatus {
  configured: SubagentBackendKind;
  override?: SubagentBackendKind;
  effective: SubagentBackendKind;
}

export interface ActiveSubagentJobSnapshot {
  ref: string;
  id: string;
  status: "queued" | "running" | "cancelling";
  profile: string;
  backend: SubagentBackendKind;
  steerable: boolean;
  summary?: string;
  createdAt?: string;
  elapsedSec: number;
  originChatId?: number;
  originMessageId?: number;
  model?: string;
  effort?: string;
}

export interface ActiveSubagentSnapshot {
  jobs: ActiveSubagentJobSnapshot[];
  omitted: number;
}

const ACTIVE_JOB_STATUSES = new Set<SubagentJob["status"]>(["queued", "running", "cancelling"]);
const TERMINAL_JOB_STATUSES = new Set<SubagentJob["status"]>(["completed", "failed", "cancelled", "timed_out", "abandoned"]);

export class SubagentManager {
  private queue: DispatchInput[] = [];
  private running = new Map<string, RunningJob>();
  private jobs = new Map<string, SubagentJob>();
  private readonly backends: Record<SubagentBackendKind, ChildAgentBackend>;
  private backendOverride?: SubagentBackendKind;
  /**
   * Serializes drain() so two concurrent dispatch() calls cannot both
   * observe `running.size < maxConcurrent` and start jobs in parallel,
   * blowing past the configured concurrency cap. Without this guard the
   * subagent pool can balloon under bursty load.
   */
  private draining = false;

  constructor(
    private readonly config: AppConfig,
    private readonly behavior: BehaviorPack,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly callbacks: SubagentCallbacks
  ) {
    this.backends = {
      codex_exec: new CodexExecChildAgentBackend(config, logger),
      codex_app_server: new CodexAppServerChildAgentBackend(config, logger)
    };
  }

  async dispatchFromDirective(action: Extract<DirectiveAction, { type: "dispatch_subagent" }>, origin?: { chatId?: number; messageId?: number }): Promise<string> {
    return this.dispatch({
      profile: action.profile,
      prompt: action.prompt,
      route: action.route,
      timeoutSec: action.timeoutSec,
      model: action.model,
      effort: action.effort,
      summary: action.summary,
      images: action.images,
      originChatId: origin?.chatId,
      originMessageId: origin?.messageId
    });
  }

  async dispatch(input: DispatchInput): Promise<string> {
    if (!this.config.subagents.enabled) throw new Error("Subagents are disabled");
    if (this.config.subagents.allowedProfiles.length > 0 && !this.config.subagents.allowedProfiles.includes(input.profile)) {
      throw new Error(`Subagent profile is not allowed: ${input.profile}`);
    }
    if (Buffer.byteLength(input.prompt, "utf8") > this.config.subagents.maxPromptBytes) {
      throw new Error("Subagent prompt exceeds maxPromptBytes");
    }
    // Bound the dispatch queue. Without this, an upstream loop firing on a
    // fast cron with a slow subagent profile could grow this list without
    // limit until we run out of memory.
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      throw new Error(`Subagent dispatch queue is full (depth=${this.queue.length}); refusing new job for profile=${input.profile}`);
    }
    input.id = makeId("job");
    const artifactDir = resolveConfigPath(this.config, join(this.config.subagents.artifactDir, input.id));
    const model = this.resolveModel(input.model);
    const effort = this.resolveEffort(input.effort);
    const queuedJob: SubagentJob = {
      id: input.id,
      profile: input.profile,
      route: input.route,
      status: "queued",
      promptPath: join(artifactDir, "prompt.md"),
      artifactDir,
      model,
      effort,
      backend: this.effectiveBackend(),
      summary: input.summary,
      enqueuedAt: nowIso(),
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    };
    this.jobs.set(input.id, queuedJob);
    await this.state.saveJob(queuedJob);
    this.queue.push(input);
    void this.drain();
    return input.id;
  }

  listJobs(): SubagentJob[] {
    return [...this.jobs.values()].sort((a, b) => this.jobSortTime(b).localeCompare(this.jobSortTime(a)));
  }

  activeJobSnapshots(limit = 20, nowMs = Date.now()): ActiveSubagentSnapshot {
    const active = this.listJobs().filter((job): job is SubagentJob & { status: "queued" | "running" | "cancelling" } =>
      ACTIVE_JOB_STATUSES.has(job.status)
    );
    return {
      jobs: active.slice(0, limit).map((job) => this.toActiveSnapshot(job, nowMs)),
      omitted: Math.max(0, active.length - limit)
    };
  }

  /**
   * Bulk-add jobs to the in-memory map.
   * Designed for future disk hydration: callers can load persisted jobs on
   * startup and inject them here without touching the dispatch/drain path.
   */
  addJobs(jobs: SubagentJob[]): void {
    for (const job of jobs) {
      this.jobs.set(job.id, job);
    }
  }

  async loadJobs(): Promise<{ loaded: number; abandoned: number }> {
    const persisted = await this.state.listJobs();
    let abandoned = 0;
    for (const job of persisted) {
      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        job.status = "abandoned";
        job.abandonedAt = nowIso();
        job.completedAt ??= job.abandonedAt;
        job.error = job.error ?? "Job was active in persisted state during service startup; not safely recoverable.";
        abandoned++;
        await this.state.saveJob(job);
      }
      this.jobs.set(job.id, job);
    }
    this.logger.info({ component: "subagents", event: "load_jobs", loaded: persisted.length, abandoned }, "loaded persisted subagent jobs");
    return { loaded: persisted.length, abandoned };
  }

  async loadRuntimeBackendOverride(): Promise<SubagentBackendStatus> {
    const getter = (this.state as StateStore & { getSubagentBackendOverride?: () => Promise<SubagentBackendKind | undefined> }).getSubagentBackendOverride;
    this.backendOverride = getter ? await getter.call(this.state) : undefined;
    return this.backendStatus();
  }

  backendStatus(): SubagentBackendStatus {
    const configured = this.configuredBackend();
    return {
      configured,
      override: this.backendOverride,
      effective: this.backendOverride ?? configured
    };
  }

  async setBackendOverride(backend: SubagentBackendKind | undefined, updatedBy?: string): Promise<SubagentBackendStatus> {
    this.backendOverride = backend;
    const setter = (this.state as StateStore & { setSubagentBackendOverride?: (value: SubagentBackendKind | undefined, updatedBy?: string) => Promise<void> }).setSubagentBackendOverride;
    if (setter) await setter.call(this.state, backend, updatedBy);
    const queuedBackend = this.effectiveBackend();
    for (const input of this.queue) {
      if (!input.id) continue;
      const job = this.jobs.get(input.id);
      if (!job || job.status !== "queued") continue;
      job.backend = queuedBackend;
      await this.state.saveJob(job);
    }
    this.logger.warn(
      { component: "subagents", event: "backend_override_set", configured: this.configuredBackend(), override: backend, effective: this.effectiveBackend(), updatedBy },
      "subagent backend override updated"
    );
    return this.backendStatus();
  }

  resolveJobRef(ref: string): JobRefResolution {
    const normalized = this.normalizeJobRef(ref);
    const jobs = [...this.jobs.values()];
    const exact = jobs.find((job) => job.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return { status: "matched", ref, job: exact };

    const isJobPrefix = /^job_[0-9a-f]+$/i.test(normalized);
    const isHexPrefix = /^[0-9a-f]+$/i.test(normalized);
    const candidates = jobs.filter((job) => {
      const id = job.id.toLowerCase();
      const hex = id.startsWith("job_") ? id.slice(4) : id;
      if (isJobPrefix) return id.startsWith(normalized.toLowerCase());
      if (isHexPrefix) return hex.startsWith(normalized.toLowerCase());
      return false;
    });

    if (candidates.length === 0) return { status: "not_found", ref };
    if (candidates.length === 1 && candidates[0]) return { status: "matched", ref, job: candidates[0] };
    return { status: "ambiguous", ref, candidates: this.candidatesFor(candidates) };
  }

  async requestCancel(ref: string, options: { reason?: string } = {}): Promise<CancelJobResult> {
    const resolution = this.resolveJobRef(ref);
    if (resolution.status === "not_found") {
      return { status: "not_found", ref, message: `No subagent job matched "${ref}".` };
    }
    if (resolution.status === "ambiguous") {
      return {
        status: "ambiguous",
        ref,
        candidates: resolution.candidates,
        message: `Ambiguous subagent job ref "${ref}" matches ${resolution.candidates.length} jobs.`
      };
    }

    const job = resolution.job;
    const previousStatus = job.status;
    const reason = options.reason ?? "user";
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      return {
        status: "already_terminal",
        ref,
        job,
        previousStatus,
        message: `Subagent job ${job.id} is already ${job.status}.`
      };
    }
    if (job.status === "cancelling") {
      return {
        status: "already_cancelling",
        ref,
        job,
        previousStatus,
        message: `Subagent job ${job.id} is already cancelling.`
      };
    }
    if (job.status === "queued") {
      this.queue = this.queue.filter((input) => input.id !== job.id);
      job.status = "cancelled";
      job.cancelRequestedAt = nowIso();
      job.cancelReason = reason;
      job.completedAt = job.cancelRequestedAt;
      await this.state.saveJob(job);
      void this.drain();
      return {
        status: "success",
        ref,
        job,
        previousStatus,
        message: `Cancelled queued subagent job ${job.id}.`
      };
    }

    const running = this.running.get(job.id);
    if (!running) {
      job.status = "abandoned";
      job.abandonedAt = nowIso();
      job.completedAt ??= job.abandonedAt;
      job.error = job.error ?? "Job was marked running in memory but no child process was tracked.";
      await this.state.saveJob(job);
      return {
        status: "already_terminal",
        ref,
        job,
        previousStatus,
        message: `Subagent job ${job.id} had no tracked process and was marked abandoned.`
      };
    }

    clearTimeout(running.timeout);
    job.status = "cancelling";
    job.cancelRequestedAt = nowIso();
    job.cancelReason = reason;
    job.interruptRequestedAt = job.cancelRequestedAt;
    job.termSentAt = nowIso();
    await this.state.saveJob(job);
    await running.backend.interrupt(job.id, reason).catch((error) => {
      this.logger.warn({ component: "subagents", event: "interrupt_failed", jobId: job.id, backend: running.backend.kind, error }, "subagent interrupt failed; falling back to terminate");
      return running.backend.kill(job.id, "SIGTERM");
    });
    if (running.killTimer) clearTimeout(running.killTimer);
    running.killTimer = setTimeout(() => {
      if (!this.running.has(job.id)) return;
      job.killSentAt = nowIso();
      void this.state.saveJob(job);
      this.logger.warn({ component: "subagents", event: "sigkill_after_grace", jobId: job.id, pid: job.pid, backend: running.backend.kind }, "subagent ignored graceful cancellation; sending SIGKILL");
      void running.backend.kill(job.id, "SIGKILL");
    }, this.cancelGraceMs(running.backend.kind));
    running.killTimer.unref?.();

    return {
      status: "success",
      ref,
      job,
      previousStatus,
      message: `Cancellation requested for running subagent job ${job.id}.`
    };
  }

  async cancel(jobId: string): Promise<boolean> {
    const result = await this.requestCancel(jobId);
    return result.status === "success";
  }

  async steerJob(ref: string, text: string): Promise<SteerJobResult> {
    const steeringText = text.trim();
    const resolution = this.resolveJobRef(ref);
    if (resolution.status === "not_found") {
      return { status: "not_found", ref, message: `No subagent job matched "${ref}".` };
    }
    if (resolution.status === "ambiguous") {
      return {
        status: "ambiguous",
        ref,
        candidates: resolution.candidates,
        message: `Ambiguous subagent job ref "${ref}" matches ${resolution.candidates.length} jobs.`
      };
    }
    const job = resolution.job;
    if (!steeringText) {
      return { status: "failed", ref, job, message: "Steering text cannot be empty." };
    }
    if (job.status !== "running") {
      return { status: "not_running", ref, job, message: `Subagent job ${job.id} is ${job.status}, not running.` };
    }
    const backendKind = job.backend ?? this.effectiveBackend();
    const backend = this.backends[backendKind];
    try {
      await backend.steer(job.id, steeringText);
      job.lastSteeredAt = nowIso();
      job.steerCount = (job.steerCount ?? 0) + 1;
      await this.state.saveJob(job);
      return { status: "success", ref, job, message: `Steered subagent ${job.id} (${job.profile}).` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status: SteerJobResultStatus = backendKind === "codex_exec"
        ? "unsupported_backend"
        : /not currently steerable|no active/i.test(message) ? "not_steerable" : "failed";
      return { status, ref, job, message };
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.requestCancel(id, { reason: "shutdown" })));
    await Promise.all(Object.values(this.backends).map((backend) => backend.shutdown().catch(() => undefined)));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.running.size < this.config.subagents.maxConcurrent && this.queue.length > 0) {
        const input = this.queue.shift() as DispatchInput;
        try {
          await this.startJob(input);
        } catch (error) {
          const id = input.id ?? makeId("job");
          const failed = this.jobs.get(id);
          if (failed) {
            failed.status = "failed";
            failed.error = error instanceof Error ? error.message : String(error);
            failed.completedAt = nowIso();
            await this.state.saveJob(failed);
            await this.deliverTerminalResult(failed, this.formatTerminalResult(failed, "", undefined, undefined));
          }
          this.logger.error({ component: "subagents", event: "start_failed", jobId: id, error }, "subagent start failed");
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async startJob(input: DispatchInput): Promise<void> {
    const id = input.id ?? makeId("job");
    const artifactDir = resolveConfigPath(this.config, join(this.config.subagents.artifactDir, id));
    await ensureDir(artifactDir);
    const promptPath = join(artifactDir, "prompt.md");
    const profileContents = await this.behavior.readSubagentProfile(input.profile);
    const assembledPrompt = [
      profileContents.trim(),
      "",
      REMOTE_REPO_AUTHORITY_RULES,
      "",
      "Task:",
      input.prompt,
      "",
      "Context:",
      `- Workspace: ${this.config.service.workspace}`,
      `- Artifact directory: ${artifactDir}`,
      "",
      "Output contract:",
      "Return a concise final answer. Include changed files if you edited anything."
    ].join("\n");
    await writeFile(promptPath, assembledPrompt, { mode: 0o600 });
    const lastMessagePath = join(artifactDir, "last-message.md");
    const stdoutPath = join(artifactDir, "events.jsonl");
    const stderrPath = join(artifactDir, "stderr.log");
    const appServerLogPath = join(artifactDir, "app-server.log");
    const timeoutSec = Math.min(input.timeoutSec ?? this.config.subagents.defaultTimeoutSec, this.config.subagents.maxTimeoutSec);
    const model = this.resolveModel(input.model);
    const effort = this.resolveEffort(input.effort);
    const backendKind = this.backendForJob(id);
    const job: SubagentJob = this.jobs.get(id) ?? {
      id,
      profile: input.profile,
      route: input.route,
      status: "queued",
      promptPath,
      artifactDir,
      model,
      effort,
      backend: backendKind,
      summary: input.summary,
      enqueuedAt: nowIso(),
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    };
    Object.assign(job, {
      profile: input.profile,
      route: input.route,
      status: "running" as const,
      promptPath,
      artifactDir,
      startedAt: nowIso(),
      lastMessagePath,
      model,
      effort,
      backend: backendKind,
      summary: input.summary,
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    });
    this.jobs.set(id, job);
    await this.state.saveJob(job);
    const backend = this.backends[backendKind];
    const child = await backend.start({
      job,
      assembledPrompt,
      lastMessagePath,
      stdoutPath,
      stderrPath,
      appServerLogPath,
      model,
      effort,
      images: input.images ?? [],
      onJobUpdated: (updatedJob) => this.state.saveJob(updatedJob)
    });
    const timeout = setTimeout(() => {
      this.logger.warn({ component: "subagents", event: "timeout", jobId: id }, "subagent timed out");
      void this.requestCancel(id, { reason: "timeout" });
    }, timeoutSec * 1000);
    this.running.set(id, { job, child, backend, timeout });
    void child.finished.then((finish) => this.finishJob(id, finish));
    if (job.pid || job.activeTurnId || job.backendThreadId) void this.state.saveJob(job);
  }

  private async finishJob(jobId: string, finish: ChildAgentFinish): Promise<void> {
    const running = this.running.get(jobId);
    if (!running) return;
    this.running.delete(jobId);
    clearTimeout(running.timeout);
    if (running.killTimer) clearTimeout(running.killTimer);
    const job = running.job;
    if (job.status === "cancelling") job.status = job.cancelReason === "timeout" ? "timed_out" : "cancelled";
    else job.status = finish.code === 0 && !finish.error ? "completed" : "failed";
    job.completedAt = nowIso();
    job.exitCode = finish.code;
    job.signal = finish.signal;
    job.activeTurnId = undefined;
    if (finish.error) job.error = finish.error;
    let result = "";
    if (job.lastMessagePath && await pathExists(job.lastMessagePath)) result = await readFile(job.lastMessagePath, "utf8");
    result = this.formatTerminalResult(job, result, finish.code, finish.signal);
    await this.state.saveJob(job);
    await this.deliverTerminalResult(job, result);
    // Clean up artifact directory for completed/cancelled/timed_out jobs that
    // delivered successfully. We keep failed-job artifacts for postmortem.
    if (this.config.subagents.cleanupArtifacts && (job.status === "completed" || job.status === "cancelled" || job.status === "timed_out")) {
      void rm(job.artifactDir ?? "", { recursive: true, force: true }).catch((error) => {
        this.logger.warn({ component: "subagents", event: "artifact_cleanup_failed", jobId, error }, "subagent artifact cleanup failed");
      });
    }
    void this.drain();
  }

  private formatTerminalResult(job: SubagentJob, result: string, code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
    const trimmed = result.trim();
    if (job.status === "failed") {
      const detail = job.error ?? `exit code ${code ?? "null"} signal ${signal ?? "null"}`;
      const header = `Subagent ${job.id} (${job.profile}) failed: ${detail}.`;
      return trimmed ? `${header}\n\n${trimmed}` : header;
    }
    if (job.status === "timed_out") {
      const header = `Subagent ${job.id} (${job.profile}) timed out: exit code ${code ?? "null"} signal ${signal ?? "null"}.`;
      return trimmed ? `${header}\n\n${trimmed}` : header;
    }
    if (job.status === "cancelled") {
      const header = `Subagent ${job.id} (${job.profile}) was cancelled: exit code ${code ?? "null"} signal ${signal ?? "null"}.`;
      return trimmed ? `${header}\n\n${trimmed}` : header;
    }
    if (job.status === "completed" && !trimmed) {
      return `Subagent ${job.id} (${job.profile}) completed but produced no final message.`;
    }
    return trimmed;
  }

  private async deliverTerminalResult(job: SubagentJob, result: string): Promise<void> {
    try {
      if (!["completed", "failed", "cancelled", "timed_out"].includes(job.status)) return;
      if (job.route === "return_to_main") await this.callbacks.onReturnToMain(job, result);
      if (job.route === "send_to_user") await this.callbacks.onSendToUser(job, result);
    } catch (error) {
      this.logger.error({ component: "subagents", event: "callback_failed", jobId: job.id, route: job.route, error }, "subagent result delivery failed");
    }
  }

  private jobSortTime(job: SubagentJob): string {
    return job.startedAt ?? job.enqueuedAt ?? job.completedAt ?? job.abandonedAt ?? "";
  }

  private toActiveSnapshot(job: SubagentJob & { status: "queued" | "running" | "cancelling" }, nowMs: number): ActiveSubagentJobSnapshot {
    const createdAt = job.enqueuedAt ?? job.startedAt ?? job.cancelRequestedAt;
    const elapsedSince = job.status === "queued" ? job.enqueuedAt : job.startedAt ?? job.enqueuedAt ?? job.cancelRequestedAt;
    const elapsedMs = elapsedSince ? nowMs - new Date(elapsedSince).getTime() : 0;
    return {
      ref: this.shortRef(job.id),
      id: job.id,
      status: job.status,
      profile: job.profile,
      backend: this.normalizeBackend(job.backend ?? this.effectiveBackend()),
      steerable: this.isJobCurrentlySteerable(job),
      summary: job.summary,
      createdAt,
      elapsedSec: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs / 1000)) : 0,
      originChatId: job.originChatId,
      originMessageId: job.originMessageId,
      model: job.model,
      effort: job.effort
    };
  }

  private isJobCurrentlySteerable(job: SubagentJob): boolean {
    if (job.status !== "running") return false;
    if (this.normalizeBackend(job.backend ?? this.effectiveBackend()) !== "codex_app_server") return false;
    if (!job.activeTurnId) return false;
    return this.running.get(job.id)?.child.isAlive() === true;
  }

  private normalizeJobRef(ref: string): string {
    return ref.trim().replace(/^[[(<]+/, "").replace(/[\])>.,;:]+$/, "");
  }

  private candidatesFor(jobs: SubagentJob[]): JobRefCandidate[] {
    return jobs.map((job) => ({
      id: job.id,
      ref: this.shortRef(job.id),
      status: job.status,
      profile: job.profile,
      summary: job.summary
    }));
  }

  shortRef(id: string, minHexLength = 8): string {
    const hex = id.startsWith("job_") ? id.slice(4) : id;
    const jobs = [...this.jobs.values()];
    for (let length = Math.min(minHexLength, hex.length); length <= hex.length; length++) {
      const candidate = hex.slice(0, length);
      const matches = jobs.filter((job) => {
        const other = job.id.startsWith("job_") ? job.id.slice(4) : job.id;
        return other.startsWith(candidate);
      });
      if (matches.length <= 1) return candidate;
    }
    return hex;
  }

  resolveModel(model?: string): string {
    return model || this.config.subagents.defaultModel || this.config.codex.model;
  }

  resolveEffort(effort?: string): string {
    return effort || this.config.subagents.defaultEffort;
  }

  private configuredBackend(): SubagentBackendKind {
    return this.normalizeBackend(this.config.subagents.backend);
  }

  private effectiveBackend(): SubagentBackendKind {
    return this.backendOverride ?? this.configuredBackend();
  }

  private backendForJob(id: string): SubagentBackendKind {
    const existing = this.jobs.get(id)?.backend;
    return this.normalizeBackend(existing ?? this.effectiveBackend());
  }

  private normalizeBackend(value: unknown): SubagentBackendKind {
    return value === "codex_app_server" ? "codex_app_server" : "codex_exec";
  }

  private cancelGraceMs(kind: SubagentBackendKind): number {
    return kind === "codex_app_server" ? this.config.subagents.childInterruptGraceMs ?? SIGKILL_GRACE_MS : SIGKILL_GRACE_MS;
  }
}
