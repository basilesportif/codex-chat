import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import WebSocket from "ws";
import type { Logger } from "pino";
import { resolveConfigPath, type AppConfig } from "./config.js";
import { sanitizeChildProcessEnv } from "./env.js";
import type { ServiceTier, SubagentBackendKind, SubagentJob } from "./types.js";
import { ensureDir, killProcessTree, nowIso } from "./util.js";

type JsonRpcMessage = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface ChildAgentFinish {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface StartChildAgentInput {
  job: SubagentJob;
  assembledPrompt: string;
  lastMessagePath: string;
  stdoutPath: string;
  stderrPath: string;
  appServerLogPath: string;
  model: string;
  effort: string;
  serviceTier: ServiceTier;
  images: string[];
  onJobUpdated(job: SubagentJob): Promise<void>;
}

export interface StartedChildAgent {
  readonly kind: SubagentBackendKind;
  readonly finished: Promise<ChildAgentFinish>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  isAlive(): boolean;
}

export interface ChildAgentBackend {
  readonly kind: SubagentBackendKind;
  start(input: StartChildAgentInput): Promise<StartedChildAgent>;
  steer(jobId: string, text: string): Promise<void>;
  interrupt(jobId: string, reason?: string): Promise<void>;
  kill(jobId: string, signal?: NodeJS.Signals): Promise<void>;
  shutdown(): Promise<void>;
}

export class CodexExecChildAgentBackend implements ChildAgentBackend {
  readonly kind = "codex_exec" as const;
  private readonly children = new Map<string, ChildProcess>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async start(input: StartChildAgentInput): Promise<StartedChildAgent> {
    const args = this.buildArgs(input.lastMessagePath, input.model, input.effort, input.serviceTier, input.images);
    this.logger.info(
      { component: "subagents", event: "start", backend: this.kind, jobId: input.job.id, profile: input.job.profile, args },
      "starting subagent"
    );
    const safeEnv = sanitizeChildProcessEnv(this.config);
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    this.children.set(input.job.id, child);
    if (child.pid) {
      input.job.pid = child.pid;
      input.job.pgid = child.pid;
      input.job.transport = "stdio";
    }
    child.stdin?.end(input.assembledPrompt);
    child.stdout?.on("data", (chunk) => appendFile(input.stdoutPath, chunk).catch((error) => {
      this.logger.error({ component: "subagents", jobId: input.job.id, error });
    }));
    child.stderr?.on("data", (chunk) => appendFile(input.stderrPath, chunk).catch((error) => {
      this.logger.error({ component: "subagents", jobId: input.job.id, error });
    }));

    const finished = new Promise<ChildAgentFinish>((resolve) => {
      let settled = false;
      const settle = (finish: ChildAgentFinish): void => {
        if (settled) return;
        settled = true;
        this.children.delete(input.job.id);
        resolve(finish);
      };
      child.on("error", (error) => {
        settle({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
      });
      child.on("exit", (code, signal) => {
        settle({ code, signal: signal ?? null });
      });
    });

    return {
      kind: this.kind,
      finished,
      kill: async (signal: NodeJS.Signals = "SIGTERM") => {
        killProcessTree(child, signal);
      },
      isAlive: () => child.exitCode === null && ((child as ChildProcess & { signalCode?: NodeJS.Signals | null }).signalCode ?? null) === null
    };
  }

  async steer(jobId: string): Promise<void> {
    throw new Error(`Subagent ${jobId} was launched with backend=codex_exec and is not steerable.`);
  }

  async interrupt(jobId: string): Promise<void> {
    await this.kill(jobId, "SIGTERM");
  }

  async kill(jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.children.get(jobId);
    if (child) killProcessTree(child, signal);
  }

  async shutdown(): Promise<void> {
    for (const jobId of this.children.keys()) await this.kill(jobId, "SIGTERM");
  }

  private buildArgs(lastMessagePath: string, model?: string, effort?: string, serviceTier: ServiceTier = "fast", images: string[] = []): string[] {
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--skip-git-repo-check",
      "--cd",
      this.config.service.workspace,
      "--sandbox",
      this.config.codex.sandbox,
      "-c",
      `ask_for_approval="${this.config.codex.approvalPolicy}"`
    ];
    for (const item of this.config.codex.extraConfig ?? []) {
      if (/^\s*model_reasoning_effort\s*=/.test(item)) continue;
      args.push("-c", item);
    }
    args.push("-c", `model_reasoning_effort="${effort}"`);
    if (serviceTier === "fast") args.push("-c", "features.fast_mode=true", "-c", `service_tier="fast"`);
    if (model) args.push("--model", model);
    if (this.config.codex.profile) args.push("--profile", this.config.codex.profile);
    for (const image of images) args.push("--image", image);
    args.push("-");
    return args;
  }
}

export class CodexAppServerChildAgentBackend implements ChildAgentBackend {
  readonly kind = "codex_app_server" as const;
  private readonly sessions = new Map<string, ChildAppServerSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async start(input: StartChildAgentInput): Promise<StartedChildAgent> {
    const session = new ChildAppServerSession(this.config, this.logger, input);
    this.sessions.set(input.job.id, session);
    try {
      const started = await session.start();
      void started.finished.finally(() => this.sessions.delete(input.job.id));
      return started;
    } catch (error) {
      this.sessions.delete(input.job.id);
      await session.kill("SIGTERM").catch(() => undefined);
      throw error;
    }
  }

  async steer(jobId: string, text: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) throw new Error(`Subagent ${jobId} has no active app-server child session.`);
    await session.steer(text);
  }

  async interrupt(jobId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    await session.interrupt(reason);
  }

  async kill(jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const session = this.sessions.get(jobId);
    if (session) await session.kill(signal);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.kill("SIGTERM").catch(() => undefined)));
  }
}

class ChildAppServerSession {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private requestId = 1;
  private threadId = "";
  private activeTurnId = "";
  private accumulated = "";
  private pendingOutput = "";
  private connected = false;
  private stopping = false;
  private turnCompleted = false;
  private settled = false;
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private resolveFinished!: (finish: ChildAgentFinish) => void;
  private readonly finishedPromise = new Promise<ChildAgentFinish>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly input: StartChildAgentInput
  ) {}

  async start(): Promise<StartedChildAgent> {
    await ensureDir(resolveConfigPath(this.config, this.config.subagents.childSocketDir));
    const port = await findFreePort();
    const listenUrl = `ws://127.0.0.1:${port}`;
    const args = ["app-server", "--listen", listenUrl];
    for (const item of this.config.codex.extraConfig ?? []) args.push("-c", item);
    if (this.input.serviceTier === "fast") args.push("-c", "features.fast_mode=true", "-c", `service_tier="fast"`);
    this.logger.info(
      { component: "subagents", event: "start", backend: "codex_app_server", jobId: this.input.job.id, profile: this.input.job.profile, listenUrl, args },
      "starting app-server subagent"
    );

    const safeEnv = sanitizeChildProcessEnv(this.config);
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    this.child = child;
    if (child.pid) {
      this.input.job.pid = child.pid;
      this.input.job.pgid = child.pid;
    }
    this.input.job.transport = "ws";
    this.input.job.socketPath = listenUrl;
    child.stdout?.on("data", (chunk) => {
      void appendFile(this.input.appServerLogPath, `[stdout] ${chunk.toString()}`).catch((error) => {
        this.logger.error({ component: "subagents", jobId: this.input.job.id, error });
      });
    });
    child.stderr?.on("data", (chunk) => {
      void appendFile(this.input.stderrPath, chunk).catch((error) => {
        this.logger.error({ component: "subagents", jobId: this.input.job.id, error });
      });
      void appendFile(this.input.appServerLogPath, `[stderr] ${chunk.toString()}`).catch(() => undefined);
    });
    child.on("exit", (code, signal) => {
      this.connected = false;
      const error = this.turnCompleted || this.stopping
        ? undefined
        : `codex app-server child exited before turn completed: code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.rejectAll(new Error(error ?? "codex app-server child exited"));
      this.settle({ code, signal: signal ?? null, error });
    });

    const startupExit = this.rejectOnStartupExit(child);
    const startupSequence = (async () => {
      await this.connectWithRetry(listenUrl);
      await this.request("initialize", {
        clientInfo: { name: "codex-chat-subagent", title: "codex-chat subagent", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      });
      await this.startThreadAndTurn();
      await this.input.onJobUpdated(this.input.job);
    })();
    try {
      await Promise.race([startupSequence, startupExit.promise]);
      if (!this.isAlive()) throw new Error(this.formatStartupExitMessage(child.exitCode, this.childSignalCode(child)));
    } catch (error) {
      startupSequence.catch(() => undefined);
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      startupExit.cleanup();
    }

    return {
      kind: "codex_app_server",
      finished: this.finishedPromise,
      kill: (signal: NodeJS.Signals = "SIGTERM") => this.kill(signal),
      isAlive: () => this.isAlive()
    };
  }

  async steer(text: string): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      throw new Error(`Subagent ${this.input.job.id} is not currently steerable; no active app-server turn is known.`);
    }
    await this.request("turn/steer", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      expectedTurnId: this.activeTurnId
    });
  }

  async interrupt(_reason?: string): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      await this.kill("SIGTERM");
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "interrupt_failed", jobId: this.input.job.id, error }, "app-server subagent interrupt failed; terminating child");
      await this.kill("SIGTERM");
    }
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.stopping = true;
    this.ws?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    const exited = once(child, "exit").then(() => undefined);
    killProcessTree(child, signal);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }

  isAlive(): boolean {
    if (!this.child) return false;
    return this.child.exitCode === null && this.childSignalCode(this.child) === null && !this.child.killed;
  }

  private rejectOnStartupExit(child: ChildProcess): { promise: Promise<never>; cleanup: () => void } {
    let cleanup = (): void => undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child !== child || this.stopping) return;
        reject(new Error(this.formatStartupExitMessage(code, signal)));
      };
      child.once("exit", onExit);
      cleanup = () => child.off("exit", onExit);
    });
    return { promise, cleanup };
  }

  private formatStartupExitMessage(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
    return `Codex app-server subagent child exited during startup: code=${code ?? "null"} signal=${signal ?? "null"}`;
  }

  private childSignalCode(child: ChildProcess): NodeJS.Signals | null {
    return (child as ChildProcess & { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
  }

  private async startThreadAndTurn(): Promise<void> {
    const threadResponse = await this.request<Record<string, unknown>>("thread/start", {
      model: this.input.model,
      serviceTier: this.input.serviceTier,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandbox: this.config.codex.sandbox,
      config: this.threadConfig(),
      serviceName: "codex-chat-subagent",
      baseInstructions: "You are a codex-chat child subagent. Follow the task, context, and output contract supplied in the turn.",
      developerInstructions: "You are a codex-chat child subagent. Return the concise final answer expected by codex-chat.",
      ephemeral: true
    });
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    this.threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!this.threadId) throw new Error("Codex app-server child did not return a thread id");
    this.input.job.backendThreadId = this.threadId;

    const userInput: unknown[] = [{ type: "text", text: this.input.assembledPrompt, text_elements: [] }];
    for (const image of this.input.images) userInput.push({ type: "localImage", path: image });
    const turnResponse = await this.request<Record<string, unknown>>("turn/start", {
      threadId: this.threadId,
      input: userInput,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      model: this.input.model,
      serviceTier: this.input.serviceTier,
      effort: this.input.effort
    });
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    this.activeTurnId = typeof turn?.id === "string" ? turn.id : "";
    if (!this.activeTurnId) throw new Error("Codex app-server child did not return a turn id");
    this.input.job.activeTurnId = this.activeTurnId;
    await this.appendEvent({ event: "turn_started", threadId: this.threadId, turnId: this.activeTurnId, at: nowIso() });
  }

  private threadConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { model_reasoning_effort: this.input.effort };
    const addDirs = this.config.codex.addDirs ?? [];
    if (addDirs.length > 0) cfg.sandbox_workspace_write = { writable_roots: addDirs };
    return cfg;
  }

  private async connectWithRetry(url: string): Promise<void> {
    const deadline = Date.now() + (this.config.subagents.childStartupTimeoutSec ?? 60) * 1000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connect(url);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.handleMessage(data.toString());
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      const wasConnected = this.connected;
      this.connected = false;
      if (!wasConnected) return;
      if (!this.stopping && !this.turnCompleted) {
        const error = new Error("codex app-server child websocket closed before turn completed");
        this.rejectAll(error);
        this.settle({ code: null, signal: null, error: error.message });
      }
    });
    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.logger.debug({ component: "subagents", event: "child_ws_error", jobId: this.input.job.id, error });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 2_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.connected = true;
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "invalid_child_ws_message", jobId: this.input.job.id, raw, error });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending) clearTimeout(pending.timer);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
      return;
    }
    void this.appendEvent(message);
    if (!message.method || typeof message.params !== "object" || message.params === null) return;
    const params = message.params as Record<string, unknown>;
    if (message.method === "item/agentMessage/delta" && params.turnId === this.activeTurnId && typeof params.delta === "string") {
      this.handleAgentMessageDelta(params.delta);
    }
    if (message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null) {
      const turn = params.turn as Record<string, unknown>;
      if (turn.id !== this.activeTurnId) return;
      this.turnCompleted = true;
      this.flushPendingOutput();
      this.input.job.activeTurnId = undefined;
      const status = typeof turn.status === "string" ? turn.status : "completed";
      const turnError = turn.error && typeof turn.error === "object" ? turn.error as Record<string, unknown> : undefined;
      if (status === "failed") {
        this.input.job.error = typeof turnError?.message === "string" ? turnError.message : "Codex app-server child turn failed.";
      }
      const finalMessage = this.accumulated;
      const finishError = status === "failed" ? this.input.job.error : undefined;
      void writeFile(this.input.lastMessagePath, finalMessage, { mode: 0o600 })
        .catch((error) => {
          this.logger.error({ component: "subagents", event: "last_message_write_failed", jobId: this.input.job.id, error });
          this.input.job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          void this.input.onJobUpdated(this.input.job).catch(() => undefined);
          this.settle({ code: 0, signal: null, error: finishError });
          void this.kill("SIGTERM").catch(() => undefined);
        });
    }
    if (message.method === "error") {
      const detail = JSON.stringify(params);
      this.logger.warn({ component: "subagents", event: "child_turn_error", jobId: this.input.job.id, detail }, "app-server subagent emitted error");
    }
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server child is not connected");
    }
    const id = this.requestId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = (this.config.subagents.childStartupTimeoutSec ?? 60) * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server child request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private settle(finish: ChildAgentFinish): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFinished(finish);
  }

  private handleAgentMessageDelta(delta: string): void {
    this.pendingOutput += delta;
    let newlineIndex = this.pendingOutput.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const newlineLength = this.pendingOutput[newlineIndex] === "\r" && this.pendingOutput[newlineIndex + 1] === "\n" ? 2 : 1;
      const lineWithNewline = this.pendingOutput.slice(0, newlineIndex + newlineLength);
      this.pendingOutput = this.pendingOutput.slice(newlineIndex + newlineLength);
      this.handleCompleteOutputLine(lineWithNewline);
      newlineIndex = this.pendingOutput.search(/\r?\n/);
    }
  }

  private flushPendingOutput(): void {
    if (!this.pendingOutput) return;
    const pending = this.pendingOutput;
    this.pendingOutput = "";
    this.handleCompleteOutputLine(pending);
  }

  private handleCompleteOutputLine(line: string): void {
    this.accumulated += line;
  }

  private async appendEvent(value: unknown): Promise<void> {
    await appendFile(this.input.stdoutPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }).catch((error) => {
      this.logger.error({ component: "subagents", event: "child_event_write_failed", jobId: this.input.job.id, error });
    });
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not allocate a local app-server child port");
  return port;
}
