import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { DirectiveAction } from "./directives.js";
import { StateStore } from "./state.js";
import { Route, SubagentJob } from "./types.js";
import { ensureDir, killProcessTree, makeId, nowIso, pathExists } from "./util.js";

const SIGKILL_GRACE_MS = 5_000;
const MAX_QUEUE_DEPTH = 200;

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
  child: ChildProcess;
  timeout: NodeJS.Timeout;
}

export class SubagentManager {
  private queue: DispatchInput[] = [];
  private running = new Map<string, RunningJob>();
  private jobs = new Map<string, SubagentJob>();
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
  ) {}

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
      summary: input.summary,
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
    return [...this.jobs.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
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

  /**
   * Stub for future disk-based job persistence.
   * When disk support is added, this method will read stored jobs and call
   * addJobs() so the in-memory map reflects the full historical record.
   * For now it is a no-op that signals intent via a log line.
   */
  loadJobs(): void {
    this.logger.info({ component: "subagents", event: "load_jobs" }, "loadJobs: in-memory only");
  }

  async cancel(jobId: string): Promise<boolean> {
    const running = this.running.get(jobId);
    if (!running) return false;
    running.job.status = "cancelled";
    running.job.completedAt = nowIso();
    await this.state.saveJob(running.job);
    clearTimeout(running.timeout);
    const child = running.child;
    killProcessTree(child, "SIGTERM");
    // Escalate to SIGKILL if the process ignores SIGTERM. Without this a
    // misbehaving subagent can cling to its slot indefinitely, starving the
    // dispatch queue.
    setTimeout(() => {
      if (child.exitCode !== null || child.killed) return;
      this.logger.warn({ component: "subagents", event: "sigkill_after_grace", jobId, pid: child.pid }, "subagent ignored SIGTERM; sending SIGKILL");
      killProcessTree(child, "SIGKILL");
    }, SIGKILL_GRACE_MS).unref?.();
    this.running.delete(jobId);
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
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
    const timeoutSec = Math.min(input.timeoutSec ?? this.config.subagents.defaultTimeoutSec, this.config.subagents.maxTimeoutSec);
    const model = this.resolveModel(input.model);
    const effort = this.resolveEffort(input.effort);
    const job: SubagentJob = {
      id,
      profile: input.profile,
      route: input.route,
      status: "running",
      promptPath,
      artifactDir,
      startedAt: nowIso(),
      lastMessagePath,
      model,
      effort,
      summary: input.summary,
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    };
    this.jobs.set(id, job);
    await this.state.saveJob(job);

    const args = this.buildArgs(lastMessagePath, model, effort, input.images ?? []);
    this.logger.info({ component: "subagents", event: "start", jobId: id, profile: input.profile, args }, "starting subagent");
    const { OPENAI_API_KEY: _omit, ...safeEnv } = process.env;
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    child.stdin?.end(assembledPrompt);
    child.stdout?.on("data", (chunk) => appendFile(stdoutPath, chunk).catch((error) => this.logger.error({ component: "subagents", jobId: id, error })));
    child.stderr?.on("data", (chunk) => appendFile(stderrPath, chunk).catch((error) => this.logger.error({ component: "subagents", jobId: id, error })));
    const timeout = setTimeout(() => {
      this.logger.warn({ component: "subagents", event: "timeout", jobId: id }, "subagent timed out");
      void this.cancel(id);
    }, timeoutSec * 1000);
    this.running.set(id, { job, child, timeout });
    child.on("exit", (code, signal) => {
      void this.finishJob(id, code, signal);
    });
  }

  private async finishJob(jobId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const running = this.running.get(jobId);
    if (!running) return;
    this.running.delete(jobId);
    clearTimeout(running.timeout);
    const job = running.job;
    if (job.status !== "cancelled") job.status = code === 0 ? "completed" : "failed";
    job.completedAt = nowIso();
    job.exitCode = code;
    job.signal = signal;
    let result = "";
    if (job.lastMessagePath && await pathExists(job.lastMessagePath)) result = await readFile(job.lastMessagePath, "utf8");
    result = this.formatTerminalResult(job, result, code, signal);
    await this.state.saveJob(job);
    await this.deliverTerminalResult(job, result);
    // Clean up artifact directory for completed/cancelled jobs that
    // delivered successfully. We keep failed-job artifacts for postmortem.
    if (this.config.subagents.cleanupArtifacts && (job.status === "completed" || job.status === "cancelled")) {
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
    if (job.status === "completed" && !trimmed) {
      return `Subagent ${job.id} (${job.profile}) completed but produced no final message.`;
    }
    return trimmed;
  }

  private async deliverTerminalResult(job: SubagentJob, result: string): Promise<void> {
    try {
      if ((job.status === "completed" || job.status === "failed") && job.route === "return_to_main") await this.callbacks.onReturnToMain(job, result);
      if ((job.status === "completed" || job.status === "failed") && job.route === "send_to_user") await this.callbacks.onSendToUser(job, result);
    } catch (error) {
      this.logger.error({ component: "subagents", event: "callback_failed", jobId: job.id, route: job.route, error }, "subagent result delivery failed");
    }
  }

  resolveModel(model?: string): string {
    return model || this.config.subagents.defaultModel || this.config.codex.model;
  }

  resolveEffort(effort?: string): string {
    return effort || this.config.subagents.defaultEffort;
  }

  private buildArgs(lastMessagePath: string, model?: string, effort?: string, images: string[] = []): string[] {
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--cd",
      this.config.service.workspace,
      "--sandbox",
      this.config.codex.sandbox,
      "-c",
      `ask_for_approval="${this.config.codex.approvalPolicy}"`
    ];
    for (const item of this.config.codex.extraConfig) {
      if (/^\s*model_reasoning_effort\s*=/.test(item)) continue;
      args.push("-c", item);
    }
    args.push("-c", `model_reasoning_effort="${this.resolveEffort(effort)}"`);
    const selectedModel = this.resolveModel(model);
    if (selectedModel) args.push("--model", selectedModel);
    if (this.config.codex.profile) args.push("--profile", this.config.codex.profile);
    for (const image of images) args.push("--image", image);
    args.push("-");
    return args;
  }
}
