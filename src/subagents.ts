import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { DirectiveAction } from "./directives.js";
import { StateStore } from "./state.js";
import { Route, SubagentJob } from "./types.js";
import { ensureDir, makeId, nowIso, pathExists } from "./util.js";

interface DispatchInput {
  id?: string;
  profile: string;
  prompt: string;
  route: Route;
  timeoutSec?: number;
  model?: string;
  effort?: string;
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
    input.id = makeId("job");
    const artifactDir = resolveConfigPath(this.config, join(this.config.subagents.artifactDir, input.id));
    const queuedJob: SubagentJob = {
      id: input.id,
      profile: input.profile,
      route: input.route,
      status: "queued",
      promptPath: join(artifactDir, "prompt.md"),
      artifactDir,
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

  async cancel(jobId: string): Promise<boolean> {
    const running = this.running.get(jobId);
    if (!running) return false;
    running.job.status = "cancelled";
    running.job.completedAt = nowIso();
    await this.state.saveJob(running.job);
    clearTimeout(running.timeout);
    try {
      if (running.child.pid) process.kill(-running.child.pid, "SIGTERM");
    } catch {
      running.child.kill("SIGTERM");
    }
    this.running.delete(jobId);
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.cancel(id)));
  }

  private async drain(): Promise<void> {
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
        }
        this.logger.error({ component: "subagents", event: "start_failed", jobId: id, error }, "subagent start failed");
      }
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
    const job: SubagentJob = {
      id,
      profile: input.profile,
      route: input.route,
      status: "running",
      promptPath,
      artifactDir,
      startedAt: nowIso(),
      lastMessagePath,
      originChatId: input.originChatId,
      originMessageId: input.originMessageId
    };
    this.jobs.set(id, job);
    await this.state.saveJob(job);

    const args = this.buildArgs(lastMessagePath, input.model, input.effort, input.images ?? []);
    this.logger.info({ component: "subagents", event: "start", jobId: id, profile: input.profile, args }, "starting subagent");
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: process.env,
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
    if (!result && job.status === "failed") result = `Subagent ${job.id} failed with exit code ${code ?? "null"} signal ${signal ?? "null"}.`;
    await this.state.saveJob(job);
    if (job.status === "completed" && job.route === "return_to_main") await this.callbacks.onReturnToMain(job, result);
    if (job.status === "completed" && job.route === "send_to_user") await this.callbacks.onSendToUser(job, result);
    void this.drain();
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
      `ask_for_approval="${this.config.codex.approvalPolicy}"`,
      "-c",
      `model_reasoning_effort="${effort || this.config.subagents.defaultEffort}"`
    ];
    const selectedModel = model || this.config.subagents.defaultModel || this.config.codex.model;
    if (selectedModel) args.push("--model", selectedModel);
    if (this.config.codex.profile) args.push("--profile", this.config.codex.profile);
    for (const item of this.config.codex.extraConfig) args.push("-c", item);
    for (const image of images) args.push("--image", image);
    args.push("-");
    return args;
  }
}
