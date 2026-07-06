import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { classifyBackendLimitError, type BackendLimitErrorKind } from "./backend-errors.js";
import { AppConfig, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { DirectiveAction } from "./directives.js";
import { StateStore } from "./state.js";
import { OutputTarget, Route, ServiceTier, ServiceTierMode, SubagentBackendKind, SubagentJob, SubagentOwnerType, SubagentResultTarget } from "./types.js";
import {
  ChildAgentBackend,
  ChildAgentFinish,
  ClaudeAgentSdkChildAgentBackend,
  CodexAppServerChildAgentBackend,
  CodexExecChildAgentBackend,
  StartedChildAgent
} from "./subagent-backends.js";
import { ensureDir, makeId, normalizeRef, nowIso, pathExists } from "./util.js";

const SIGKILL_GRACE_MS = 5_000;
const MAX_QUEUE_DEPTH = 200;
const remoteRepoAuthorityRules = (assistantWorkspace: string): string => [
  "Remote repo authority:",
  `- When a task mentions repo-registry, a dev server, or a repo path that may be registered remotely, first resolve the authoritative location from \`${assistantWorkspace}/.claude/repo-registry/index.yaml\`.`,
  "- In that registry, `host: local` or a missing host means local; any other `host` value, such as `tim@89.167.72.52`, is authoritative remote.",
  "- For remote registry entries, verify files and git state over SSH on the registered host and path, for example `ssh <host> \"cd <path> && ...\"`. Do not substitute same-looking local paths such as `/home/tim/...`, and do not treat `.claude/repo-registry/repos/<alias>` as the repo checkout.",
  "- For env files, credentials, and other likely secrets, verify only metadata such as existence, permissions, owner, size, line/key counts, git ignore status, and git tracking state. Do not print or inspect secret values."
].join("\n");

const SELF_RESTART_SAFETY_RULES = [
  "Self-restart safety:",
  "- You are running as a child of the codex-chat service. Do not restart, stop, or redeploy codex-chat.service from inside a subagent turn; that kills the parent service and closes this child websocket before your final answer can be delivered.",
  "- If codex-chat itself must be restarted or redeployed, finish code/test/commit/push work first and return the exact restart/deploy command for the main service or user to run after your final answer.",
  "- Avoid commands such as `systemctl --user restart codex-chat.service`, `systemctl --user stop codex-chat.service`, or deploy scripts that restart this service unless the task explicitly accepts losing the subagent result."
].join("\n");

interface DispatchInput {
  id?: string;
  profile: string;
  prompt: string;
  route: Route;
  ownerType?: SubagentOwnerType;
  ownerId?: string;
  ownerRequestId?: string;
  parentTurnId?: string;
  conversationSessionId?: string;
  correlationId?: string;
  originTarget?: OutputTarget;
  defaultOutputTarget?: OutputTarget;
  resultTarget?: SubagentResultTarget;
  timeoutSec?: number;
  backend?: SubagentBackendKind;
  model?: string;
  effort?: string;
  serviceTier?: ServiceTier;
  serviceTierMode?: ServiceTierMode;
  codexProfile?: string;
  modelProvider?: string;
  summary?: string;
  images?: string[];
  originChatId?: number;
  originMessageId?: number;
}

/**
 * Structured terminal result handed to delivery callbacks. The delivery
 * layer formats the user/main-facing message once from these parts instead
 * of reverse-parsing a pre-joined string.
 */
export interface SubagentTerminalResult {
  /** The terminal job (the same object the manager tracks). */
  job: SubagentJob;
  /** Trimmed final message body from the child; may be empty. */
  body: string;
  /** Status header for failed/timed_out/cancelled or empty-completed jobs. */
  header?: string;
  /** Header and body joined with a blank line — the legacy single-string form. */
  text: string;
}

interface SubagentCallbacks {
  onReturnToMain(result: SubagentTerminalResult): Promise<void>;
  onSendToUser(result: SubagentTerminalResult): Promise<void>;
  onReturnToEmployee?(result: SubagentTerminalResult): Promise<void>;
  onSendToAdmins?(result: SubagentTerminalResult): Promise<void>;
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
  | "forbidden"
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
  | "forbidden"
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
  serviceTier?: ServiceTier;
  serviceTierMode?: ServiceTierMode;
  codexProfile?: string;
  modelProvider?: string;
  ownerType: SubagentOwnerType;
  ownerId?: string;
  ownerRequestId?: string;
  parentTurnId?: string;
  conversationSessionId?: string;
  correlationId?: string;
  resultTarget: SubagentResultTarget;
}

export interface SubagentControlActor {
  ownerType?: SubagentOwnerType | "admin";
  ownerId?: string;
  allowCrossOwner?: boolean;
}

export interface ActiveSubagentSnapshot {
  jobs: ActiveSubagentJobSnapshot[];
  omitted: number;
}

const CLAUDE_MODEL_ALIASES = new Set(["opus", "fable", "sonnet", "haiku"]);

/** True when a model slug can only run on the Claude Agent SDK backend. */
export function isClaudeModelSlug(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith("claude") || CLAUDE_MODEL_ALIASES.has(normalized);
}

const ACTIVE_JOB_STATUSES = new Set<SubagentJob["status"]>(["queued", "running", "cancelling"]);
const TERMINAL_JOB_STATUSES = new Set<SubagentJob["status"]>(["completed", "failed", "cancelled", "timed_out", "abandoned"]);

/** True when a job status is terminal (completed/failed/cancelled/timed_out/abandoned). */
export function isTerminalSubagentStatus(status: SubagentJob["status"]): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function normalizeSubagentOwnerType(value: unknown): SubagentOwnerType {
  if (value === "loop" || value === "monitor" || value === "employee") return value;
  return "main";
}

export function jobOwnerType(job: SubagentJob): SubagentOwnerType {
  return normalizeSubagentOwnerType(job.ownerType);
}

export function resultTargetForRoute(route: Route): SubagentResultTarget {
  if (route === "send_to_user") return "user";
  if (route === "send_to_admins") return "admins";
  if (route === "store_only") return "store_only";
  if (route === "silent") return "silent";
  return "main";
}

export function jobResultTarget(job: SubagentJob): SubagentResultTarget {
  return job.resultTarget ?? resultTargetForRoute(job.route);
}

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
    private readonly callbacks: SubagentCallbacks,
    backends?: Partial<Record<SubagentBackendKind, ChildAgentBackend>>
  ) {
    this.backends = {
      codex_exec: backends?.codex_exec ?? new CodexExecChildAgentBackend(config, logger),
      codex_app_server: backends?.codex_app_server ?? new CodexAppServerChildAgentBackend(config, logger),
      claude_agent_sdk: backends?.claude_agent_sdk ?? new ClaudeAgentSdkChildAgentBackend(config, logger)
    };
  }

  async dispatchFromDirective(
    action: Extract<DirectiveAction, { type: "dispatch_subagent" }>,
    origin?: {
      chatId?: number;
      messageId?: number;
      parentTurnId?: string;
      conversationSessionId?: string;
      correlationId?: string;
      originTarget?: OutputTarget;
      defaultOutputTarget?: OutputTarget;
    }
  ): Promise<string> {
    return this.dispatch({
      profile: action.profile,
      prompt: action.prompt,
      route: action.route,
      ownerType: "main",
      ownerId: "main",
      ownerRequestId: action.idempotencyKey,
      parentTurnId: origin?.parentTurnId,
      conversationSessionId: origin?.conversationSessionId,
      correlationId: origin?.correlationId,
      originTarget: origin?.originTarget,
      defaultOutputTarget: origin?.defaultOutputTarget,
      resultTarget: resultTargetForRoute(action.route),
      timeoutSec: action.timeoutSec,
      backend: action.backend,
      model: action.model,
      effort: action.effort,
      serviceTier: action.serviceTier,
      serviceTierMode: action.serviceTierMode,
      codexProfile: action.codexProfile,
      modelProvider: action.modelProvider,
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
    const { backend: backendKind, explicit: backendExplicit } = this.resolveDispatchBackend(input);
    const modelSpec = this.resolveSubagentModelSpec(input, backendKind);
    const { model, effort, serviceTier, serviceTierMode, codexProfile, modelProvider } = modelSpec;
    const ownerType = normalizeSubagentOwnerType(input.ownerType);
    const ownerId = input.ownerId ?? this.defaultOwnerId(ownerType);
    const resultTarget = input.resultTarget ?? resultTargetForRoute(input.route);
    const queuedJob: SubagentJob = {
      id: input.id,
      profile: input.profile,
      route: input.route,
      ownerType,
      ownerId,
      ownerRequestId: input.ownerRequestId,
      parentTurnId: input.parentTurnId,
      conversationSessionId: input.conversationSessionId,
      correlationId: input.correlationId,
      originTarget: input.originTarget,
      defaultOutputTarget: input.defaultOutputTarget,
      resultTarget,
      status: "queued",
      promptPath: join(artifactDir, "prompt.md"),
      artifactDir,
      model,
      effort,
      serviceTier,
      serviceTierMode,
      codexProfile,
      modelProvider,
      backend: backendKind,
      backendExplicit: backendExplicit || undefined,
      summary: input.summary,
      enqueuedAt: nowIso(),
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    };
    this.jobs.set(input.id, queuedJob);
    await this.state.saveJob(queuedJob);
    this.queue.push(input);
    await this.drain();
    return input.id;
  }

  listJobs(): SubagentJob[] {
    return [...this.jobs.values()].sort((a, b) => this.jobSortTime(b).localeCompare(this.jobSortTime(a)));
  }

  listJobsForOwner(ownerType: SubagentOwnerType, ownerId: string): SubagentJob[] {
    return this.listJobs().filter((job) => jobOwnerType(job) === ownerType && job.ownerId === ownerId);
  }

  async cancelActiveJobsForOwner(ownerType: SubagentOwnerType, ownerId: string, reason: string): Promise<CancelJobResult[]> {
    const jobs = this.listJobsForOwner(ownerType, ownerId).filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
    const results: CancelJobResult[] = [];
    for (const job of jobs) {
      results.push(await this.requestCancel(job.id, {
        reason,
        actor: { ownerType, ownerId }
      }));
    }
    return results;
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
   * Test-only seeding helper today (no production callers). Designed for
   * future disk hydration: callers can load persisted jobs on startup and
   * inject them here without touching the dispatch/drain path.
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
    this.backendOverride = await this.state.getSubagentBackendOverride();
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
    await this.state.setSubagentBackendOverride(backend, updatedBy);
    const queuedBackend = this.effectiveBackend();
    // Snapshot: drain() shifts entries off this.queue during the awaits below.
    for (const input of [...this.queue]) {
      if (!input.id) continue;
      const job = this.jobs.get(input.id);
      if (!job || job.status !== "queued") continue;
      // Jobs that explicitly requested a backend in their dispatch directive
      // keep it; the runtime override only re-stamps default-routed jobs.
      if (job.backendExplicit) continue;
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
    const normalized = normalizeRef(ref);
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

  async requestCancel(ref: string, options: { reason?: string; actor?: SubagentControlActor } = {}): Promise<CancelJobResult> {
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
    const authorization = this.authorizeJobControl(job, options.actor);
    if (!authorization.allowed) {
      return {
        status: "forbidden",
        ref,
        job,
        message: authorization.message
      };
    }
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

  async steerJob(ref: string, text: string, options: { actor?: SubagentControlActor } = {}): Promise<SteerJobResult> {
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
    const authorization = this.authorizeJobControl(job, options.actor);
    if (!authorization.allowed) return { status: "forbidden", ref, job, message: authorization.message };
    if (!steeringText) {
      return { status: "failed", ref, job, message: "Steering text cannot be empty." };
    }
    if (job.status !== "running") {
      return { status: "not_running", ref, job, message: `Subagent job ${job.id} is ${job.status}, not running.` };
    }
    const backendKind = this.normalizeBackend(job.backend ?? this.effectiveBackend());
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
    this.prepareForServiceShutdown("shutdown");
    await Promise.all([...this.running.entries()].map(async ([id, running]) => {
      await running.backend.interrupt(id, "shutdown").catch((error) => {
        this.logger.warn({ component: "subagents", event: "interrupt_failed", jobId: id, backend: running.backend.kind, error }, "subagent interrupt failed during shutdown; falling back to terminate");
        return running.backend.kill(id, "SIGTERM");
      });
    }));
    await Promise.all(Object.values(this.backends).map((backend) => backend.shutdown().catch(() => undefined)));
  }

  prepareForServiceShutdown(reason = "shutdown"): void {
    const at = nowIso();
    for (const input of this.queue) {
      const job = input.id ? this.jobs.get(input.id) : undefined;
      if (!job || job.status !== "queued") continue;
      job.status = "cancelled";
      job.cancelRequestedAt = at;
      job.cancelReason = reason;
      job.completedAt = at;
      void this.state.saveJob(job);
    }
    this.queue = [];

    for (const [jobId, running] of this.running) {
      clearTimeout(running.timeout);
      if (running.killTimer) clearTimeout(running.killTimer);
      const job = running.job;
      if (job.status === "running") {
        job.status = "cancelling";
        job.cancelRequestedAt = at;
        job.cancelReason = reason;
        job.interruptRequestedAt = at;
        job.termSentAt = at;
        void this.state.saveJob(job);
      }
      this.logger.warn(
        { component: "subagents", event: "service_shutdown_prepare", jobId, backend: running.backend.kind, reason },
        "marking running subagent as cancelling before service shutdown"
      );
    }
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
          this.logger.error({ component: "subagents", event: "start_failed", jobId: id, error }, "subagent start failed");
          try {
            const failed = this.jobs.get(id);
            if (failed) {
              failed.status = "failed";
              failed.error = error instanceof Error ? error.message : String(error);
              failed.completedAt = nowIso();
              await this.state.saveJob(failed);
              await this.deliverTerminalResult(this.formatTerminalResult(failed, "", undefined, undefined));
            }
          } catch (cleanupError) {
            // The failure-bookkeeping path must not throw out of drain() —
            // callers fire it with `void this.drain()`.
            this.logger.error({ component: "subagents", event: "start_failure_cleanup_failed", jobId: id, error: cleanupError }, "failed to record subagent start failure");
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async startJob(input: DispatchInput): Promise<void> {
    const id = input.id ?? makeId("job");
    // dispatch() creates and persists the queued job (with backend, model
    // spec, owner and routing fields all resolved) before queueing it, so the
    // tracked job is the source of truth; startJob only applies the fields
    // that transition on start.
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Subagent job ${id} was queued but is not tracked; refusing to start.`);
    const artifactDir = job.artifactDir;
    await ensureDir(artifactDir);
    const promptPath = job.promptPath;
    const profileContents = await this.behavior.readSubagentProfile(job.profile);
    const assembledPrompt = [
      profileContents.trim(),
      "",
      remoteRepoAuthorityRules(this.config.paths.assistantWorkspace),
      "",
      SELF_RESTART_SAFETY_RULES,
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
    // dispatch() stamped the backend and model spec on the queued job;
    // setBackendOverride may have re-stamped backend on non-explicit jobs.
    const backendKind = this.normalizeBackend(job.backend ?? this.effectiveBackend());
    const model = job.model ?? "";
    const effort = job.effort ?? this.resolveEffort();
    const serviceTier = job.serviceTier ?? this.resolveServiceTier();
    const serviceTierMode = job.serviceTierMode ?? this.resolveServiceTierMode(undefined, job.modelProvider);
    const codexProfile = job.codexProfile ?? "";
    const modelProvider = job.modelProvider ?? "";
    // A cancel may have landed while the awaits above (ensureDir, profile
    // read, prompt write) were in flight. Starting anyway would overwrite the
    // terminal status below and run a job the user was told was cancelled.
    if (job.status !== "queued") {
      this.logger.info(
        { component: "subagents", event: "start_aborted", jobId: id, status: job.status },
        "subagent start aborted; job left queued state during startup"
      );
      return;
    }
    Object.assign(job, {
      status: "running" as const,
      startedAt: nowIso(),
      lastMessagePath,
      promptPath,
      artifactDir
    });
    await this.state.saveJob(job);
    await appendFile(stdoutPath, `${JSON.stringify({
      event: "subagent_launch_config",
      at: nowIso(),
      backend: backendKind,
      profile: job.profile,
      codexProfile: job.codexProfile || undefined,
      modelProvider: job.modelProvider || undefined,
      model: job.model,
      effort: job.effort,
      serviceTier: job.serviceTier,
      serviceTierMode: job.serviceTierMode
    })}\n`, { mode: 0o600 });
    // Same hazard for the awaits just above (saveJob, launch-config append):
    // a cancel seeing status="running" with no running-map entry takes the
    // abandoned fallback — don't launch a child for a job already terminal.
    // (Re-read defeats TS narrowing: a concurrent cancel mutates the shared
    // job object during the awaits.)
    const statusBeforeLaunch = job.status as SubagentJob["status"];
    if (statusBeforeLaunch !== "running") {
      this.logger.info(
        { component: "subagents", event: "start_aborted", jobId: id, status: statusBeforeLaunch },
        "subagent start aborted before backend launch; job reached terminal state during startup"
      );
      return;
    }
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
      serviceTier,
      serviceTierMode,
      codexProfile,
      modelProvider,
      images: input.images ?? [],
      onJobUpdated: (updatedJob) => this.state.saveJob(updatedJob)
    });
    const timeout = setTimeout(() => {
      this.logger.warn({ component: "subagents", event: "timeout", jobId: id }, "subagent timed out");
      void this.requestCancel(id, { reason: "timeout" });
    }, timeoutSec * 1000);
    this.running.set(id, { job, child, backend, timeout });
    // Never let a finishJob failure (e.g. transient FS error in saveJob)
    // become an unhandled rejection — that would take down the whole service.
    void child.finished
      .then((finish) => this.finishJob(id, finish, nowIso()))
      .catch((error) => {
        this.logger.error({ component: "subagents", event: "finish_job_failed", jobId: id, error }, "finishJob failed after child settled");
      });
    if (job.pid || job.activeTurnId || job.backendThreadId) void this.state.saveJob(job);
  }

  private async finishJob(jobId: string, finish: ChildAgentFinish, settledAt?: string): Promise<void> {
    const running = this.running.get(jobId);
    if (!running) return;
    this.running.delete(jobId);
    clearTimeout(running.timeout);
    if (running.killTimer) clearTimeout(running.killTimer);
    const job = running.job;
    // A cancel that raced in AFTER the child had already settled must not
    // relabel a natural finish as cancelled.
    const cancelledBeforeSettle = job.status === "cancelling"
      && (!settledAt || !job.cancelRequestedAt || job.cancelRequestedAt <= settledAt);
    if (cancelledBeforeSettle) job.status = job.cancelReason === "timeout" ? "timed_out" : "cancelled";
    else job.status = finish.code === 0 && !finish.error ? "completed" : "failed";
    job.completedAt = nowIso();
    job.exitCode = finish.code;
    job.signal = finish.signal;
    job.activeTurnId = undefined;
    if (finish.error) job.error = finish.error;
    let result = "";
    if (job.lastMessagePath && await pathExists(job.lastMessagePath)) {
      result = await readFile(job.lastMessagePath, "utf8").catch((error) => {
        this.logger.warn({ component: "subagents", event: "last_message_read_failed", jobId, error }, "could not read subagent last message; delivering without it");
        return "";
      });
    }
    await this.classifyCodexExecStderrIfNeeded(job, finish);
    const terminalResult = this.formatTerminalResult(job, result, finish.code, finish.signal);
    await this.state.saveJob(job);
    await this.deliverTerminalResult(terminalResult);
    this.scheduleArtifactCleanup(job);
    void this.drain();
  }

  private formatTerminalResult(job: SubagentJob, result: string, code: number | null | undefined, signal: NodeJS.Signals | null | undefined): SubagentTerminalResult {
    const body = result.trim();
    let header: string | undefined;
    if (job.status === "failed") {
      const detail = this.backendLimitFailureDetail(job, `${job.error ?? ""}\n${body}`) ?? job.error ?? `exit code ${code ?? "null"} signal ${signal ?? "null"}`;
      header = `Subagent ${job.id} (${job.profile}) failed: ${detail}.`;
    } else if (job.status === "timed_out") {
      header = `Subagent ${job.id} (${job.profile}) timed out: exit code ${code ?? "null"} signal ${signal ?? "null"}.`;
    } else if (job.status === "cancelled") {
      header = `Subagent ${job.id} (${job.profile}) was cancelled: exit code ${code ?? "null"} signal ${signal ?? "null"}.`;
    } else if (job.status === "completed" && !body) {
      header = `Subagent ${job.id} (${job.profile}) completed but produced no final message.`;
    }
    const text = header ? (body ? `${header}\n\n${body}` : header) : body;
    return { job, body, header, text };
  }

  private async classifyCodexExecStderrIfNeeded(job: SubagentJob, finish: ChildAgentFinish): Promise<void> {
    if (job.backend !== "codex_exec" || job.error || finish.error || finish.code === 0 || finish.code === null) return;
    const stderrPath = join(job.artifactDir, "stderr.log");
    const stderr = await readFile(stderrPath, "utf8").catch(() => "");
    const kind = classifyBackendLimitError(stderr.slice(-2048));
    if (kind) job.error = this.backendLimitFailureDetail(job, kind);
  }

  private backendLimitFailureDetail(job: SubagentJob, value: string | BackendLimitErrorKind): string | undefined {
    const kind = value === "usage-limit" || value === "rate-limit" || value === "auth"
      ? value
      : classifyBackendLimitError(value);
    if (!kind) return undefined;
    const backend = job.backend === "claude_agent_sdk" ? "Claude" : "Codex";
    if (kind === "usage-limit") return `${backend} backend hit a usage limit; try again later`;
    if (kind === "rate-limit") return `${backend} backend hit a rate limit or overloaded condition; try again shortly`;
    return `${backend} backend authentication failed or expired`;
  }

  private async deliverTerminalResult(result: SubagentTerminalResult): Promise<void> {
    const job = result.job;
    try {
      if (!["completed", "failed", "cancelled", "timed_out"].includes(job.status)) return;
      const target = jobResultTarget(job);
      if (target === "main") await this.callbacks.onReturnToMain(result);
      if (target === "user") await this.callbacks.onSendToUser(result);
      if (target === "employee") await this.callbacks.onReturnToEmployee?.(result);
      if (target === "admins") await this.callbacks.onSendToAdmins?.(result);
    } catch (error) {
      this.logger.error({ component: "subagents", event: "callback_failed", jobId: job.id, route: job.route, resultTarget: jobResultTarget(job), error }, "subagent result delivery failed");
    }
  }

  private scheduleArtifactCleanup(job: SubagentJob): void {
    // Clean up artifact directories for completed/cancelled/timed_out jobs
    // that delivered successfully. Failed-job artifacts are still retained
    // indefinitely for postmortem.
    if (!this.config.subagents.cleanupArtifacts) {
      this.logger.info({ component: "subagents", event: "artifact_cleanup_skipped", jobId: job.id, reason: "disabled" }, "subagent artifact cleanup disabled");
      return;
    }
    if (!(job.status === "completed" || job.status === "cancelled" || job.status === "timed_out")) {
      this.logger.info({ component: "subagents", event: "artifact_cleanup_skipped", jobId: job.id, reason: "terminal_status", status: job.status }, "subagent artifact cleanup skipped");
      return;
    }
    const artifactDir = job.artifactDir;
    if (!artifactDir) {
      this.logger.info({ component: "subagents", event: "artifact_cleanup_skipped", jobId: job.id, reason: "missing_artifact_dir" }, "subagent artifact cleanup skipped");
      return;
    }
    void this.removeArtifactDir(job.id, artifactDir, "immediate");
  }

  private async removeArtifactDir(jobId: string, artifactDir: string, reason: string): Promise<void> {
    try {
      await rm(artifactDir, { recursive: true, force: true });
      this.logger.info({ component: "subagents", event: "artifact_cleanup_completed", jobId, artifactDir, reason }, "subagent artifact cleanup completed");
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "artifact_cleanup_failed", jobId, artifactDir, reason, error }, "subagent artifact cleanup failed");
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
      effort: job.effort,
      serviceTier: job.serviceTier,
      serviceTierMode: job.serviceTierMode,
      codexProfile: job.codexProfile,
      modelProvider: job.modelProvider,
      ownerType: jobOwnerType(job),
      ownerId: job.ownerId,
      ownerRequestId: job.ownerRequestId,
      parentTurnId: job.parentTurnId,
      conversationSessionId: job.conversationSessionId,
      correlationId: job.correlationId,
      resultTarget: jobResultTarget(job)
    };
  }

  private isJobCurrentlySteerable(job: SubagentJob): boolean {
    if (job.status !== "running") return false;
    const backend = this.normalizeBackend(job.backend ?? this.effectiveBackend());
    if (backend !== "codex_app_server" && backend !== "claude_agent_sdk") return false;
    if (!job.activeTurnId) return false;
    return this.running.get(job.id)?.child.isAlive() === true;
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

  resolveServiceTier(serviceTier?: ServiceTier): ServiceTier {
    return serviceTier ?? this.config.subagents.defaultServiceTier ?? "fast";
  }

  resolveServiceTierMode(serviceTierMode?: ServiceTierMode, modelProvider?: string): ServiceTierMode {
    const requested = serviceTierMode ?? this.config.subagents.serviceTierMode ?? "auto";
    if (requested !== "auto") return requested;
    const provider = (modelProvider ?? "").trim().toLowerCase();
    if (provider && provider !== "openai") return "omit";
    return "auto";
  }

  resolveCodexProfile(codexProfile?: string): string {
    return codexProfile || this.config.subagents.defaultCodexProfile || this.config.codex.profile || "";
  }

  resolveModelProvider(modelProvider?: string): string {
    return modelProvider || this.config.subagents.defaultModelProvider || this.config.codex.modelProvider || "";
  }

  private resolveSubagentModelSpec(input: Pick<DispatchInput, "model" | "effort" | "serviceTier" | "serviceTierMode" | "codexProfile" | "modelProvider">, backendKind?: SubagentBackendKind): { model: string; effort: string; serviceTier: ServiceTier; serviceTierMode: ServiceTierMode; codexProfile: string; modelProvider: string } {
    if (backendKind === "claude_agent_sdk") {
      // Codex provider machinery does not apply to Claude-backed jobs.
      if (input.codexProfile) throw new Error("Subagent codexProfile is not supported with backend=claude_agent_sdk; omit it for Claude-backed dispatches.");
      if (input.modelProvider) throw new Error("Subagent modelProvider is not supported with backend=claude_agent_sdk; omit it for Claude-backed dispatches.");
      return {
        // Empty model lets the Claude Agent SDK use its default model instead
        // of inheriting a Codex model slug from config.
        model: input.model || "",
        effort: input.effort || this.resolveEffort(),
        serviceTier: input.serviceTier ?? this.resolveServiceTier(),
        serviceTierMode: this.resolveServiceTierMode(input.serviceTierMode, ""),
        codexProfile: "",
        modelProvider: ""
      };
    }
    const resolvedModel = input.model || this.resolveModel();
    if (isClaudeModelSlug(resolvedModel)) {
      throw new Error(`Subagent model '${resolvedModel}' is a Claude model and cannot run on backend=${backendKind ?? this.effectiveBackend()}; dispatch with backend=claude_agent_sdk.`);
    }
    const defaultCodexProfile = this.config.subagents.defaultCodexProfile || this.config.codex.profile || "";
    const defaultModelProvider = this.config.subagents.defaultModelProvider || this.config.codex.modelProvider || "";
    const codexProfile = input.codexProfile || defaultCodexProfile;
    const modelProvider = input.modelProvider || defaultModelProvider;

    if (input.codexProfile && input.codexProfile !== defaultCodexProfile) this.assertProviderOverrideAllowed("codexProfile", input.codexProfile, this.config.subagents.allowedCodexProfiles);
    if (input.modelProvider && input.modelProvider !== defaultModelProvider) this.assertProviderOverrideAllowed("modelProvider", input.modelProvider, this.config.subagents.allowedModelProviders);

    return {
      model: resolvedModel,
      effort: input.effort || this.resolveEffort(),
      serviceTier: input.serviceTier ?? this.resolveServiceTier(),
      serviceTierMode: this.resolveServiceTierMode(input.serviceTierMode, modelProvider),
      codexProfile,
      modelProvider
    };
  }

  private assertProviderOverrideAllowed(kind: "codexProfile" | "modelProvider", value: string, allowedValues: readonly string[]): void {
    if (!this.config.subagents.allowProviderOverride) throw new Error(`Subagent ${kind} override is not enabled`);
    if (allowedValues.length > 0 && !allowedValues.includes(value)) throw new Error(`Subagent ${kind} is not allowed: ${value}`);
  }

  private configuredBackend(): SubagentBackendKind {
    return this.normalizeBackend(this.config.subagents.backend);
  }

  private effectiveBackend(): SubagentBackendKind {
    return this.backendOverride ?? this.configuredBackend();
  }

  /**
   * Resolve the backend for a new dispatch. A Claude model slug with no
   * explicit backend auto-routes to claude_agent_sdk (a dispatch naming a
   * Claude model but omitting the backend field would otherwise land on a
   * Codex backend and fail with an opaque 400); a Claude model with an
   * explicitly-requested Codex backend is rejected loudly so the error goes
   * back to the dispatching loop instead of to Codex.
   */
  private resolveDispatchBackend(input: DispatchInput): { backend: SubagentBackendKind; explicit: boolean } {
    const requested = input.backend !== undefined ? this.normalizeBackend(input.backend) : undefined;
    const claudeModel = isClaudeModelSlug(input.model);
    if (requested !== undefined) {
      if (claudeModel && requested !== "claude_agent_sdk") {
        throw new Error(`Subagent model '${input.model}' is a Claude model but backend=${requested} was requested; use backend=claude_agent_sdk (or omit backend) for Claude models.`);
      }
      return { backend: requested, explicit: true };
    }
    if (claudeModel && this.effectiveBackend() !== "claude_agent_sdk") {
      this.logger.info(
        { component: "subagents", event: "backend_auto_routed", model: input.model, profile: input.profile },
        "Claude model requested without backend field; auto-routing dispatch to claude_agent_sdk"
      );
      return { backend: "claude_agent_sdk", explicit: true };
    }
    return { backend: this.effectiveBackend(), explicit: false };
  }

  private normalizeBackend(value: unknown): SubagentBackendKind {
    if (value === "codex_app_server" || value === "claude_agent_sdk") return value;
    return "codex_exec";
  }

  private cancelGraceMs(kind: SubagentBackendKind): number {
    return kind === "codex_app_server" || kind === "claude_agent_sdk" ? this.config.subagents.childInterruptGraceMs ?? SIGKILL_GRACE_MS : SIGKILL_GRACE_MS;
  }

  private defaultOwnerId(ownerType: SubagentOwnerType): string {
    return ownerType;
  }

  private authorizeJobControl(job: SubagentJob, actor?: SubagentControlActor): { allowed: true } | { allowed: false; message: string } {
    if (!actor || actor.allowCrossOwner || actor.ownerType === "admin" || actor.ownerType === "main" || actor.ownerType === undefined) {
      return { allowed: true };
    }
    if (actor.ownerType === "employee") {
      const ownerType = jobOwnerType(job);
      if (ownerType === "employee" && job.ownerId === actor.ownerId) return { allowed: true };
      return {
        allowed: false,
        message: `Employee ${actor.ownerId ?? "unknown"} cannot control subagent job ${job.id}; owner=${ownerType}:${job.ownerId ?? this.defaultOwnerId(ownerType)}.`
      };
    }
    const ownerType = jobOwnerType(job);
    if (ownerType === actor.ownerType && job.ownerId === actor.ownerId) return { allowed: true };
    return {
      allowed: false,
      message: `Owner ${actor.ownerType}:${actor.ownerId ?? "unknown"} cannot control subagent job ${job.id}; owner=${ownerType}:${job.ownerId ?? this.defaultOwnerId(ownerType)}.`
    };
  }
}
