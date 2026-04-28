import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
import type { Logger } from "pino";
import { AppConfig } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { StateStore } from "./state.js";
import { CodexClient, CodexEvent, CodexHealth, CodexTurnInput } from "./types.js";

type JsonRpcMessage = Record<string, unknown> & { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

type QueueResult<T> = { kind: "value"; value: T } | { kind: "done" } | { kind: "error"; error: Error };

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: QueueResult<T>) => void> = [];
  private closed = false;
  private failure?: Error;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ kind: "value", value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ kind: "done" });
  }

  /**
   * Terminate the queue with an error. Any pending waiters and any future
   * iteration calls will throw. Buffered values are dropped — when the
   * underlying transport has died we have no useful partial event to emit.
   */
  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.values = [];
    for (const waiter of this.waiters.splice(0)) waiter({ kind: "error", error });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      const result = await new Promise<QueueResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.kind === "error") throw result.error;
      if (result.kind === "done") return;
      yield result.value;
    }
  }
}

export interface CodexCrashInfo {
  signal: NodeJS.Signals | null;
  code: number | null;
  /** True if the process was SIGKILL'd (typically the OOM killer). */
  wasKilled: boolean;
  source: "process_exit" | "websocket_close";
}

export type CodexCrashHandler = (reason: string, info: CodexCrashInfo) => void;

export class AppServerCodexClient implements CodexClient {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private requestId = 1;
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  private activeQueues = new Set<AsyncQueue<CodexEvent>>();
  private stopping = false;
  private sessionId?: string;
  private connected = false;
  private startupComplete = false;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly behavior: BehaviorPack,
    private readonly logger: Logger,
    private readonly onCrash?: CodexCrashHandler
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    this.startupComplete = false;
    const listenUrl = `ws://${this.config.codex.appServerHost}:${this.config.codex.appServerPort}`;
    const args = ["app-server", "--listen", listenUrl];
    for (const item of this.config.codex.extraConfig) args.push("-c", item);
    this.logger.info({ component: "codex", event: "spawn_app_server", args }, "starting codex app-server");
    const { OPENAI_API_KEY: _omit, ...safeEnv } = process.env;
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => this.logger.debug({ component: "codex", stream: "stdout", data: chunk.toString() }));
    child.stderr?.on("data", (chunk) => this.logger.info({ component: "codex", stream: "stderr", data: chunk.toString() }));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.connected = false;
      if (!this.stopping && this.startupComplete) {
        const wasKilled = signal === "SIGKILL";
        const reason = wasKilled
          ? `codex app-server was SIGKILL'd (likely OOM kill) code=${code ?? "null"}`
          : `codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`;
        this.logger.warn({ component: "codex", event: "app_server_exit", code, signal, wasKilled }, reason);
        const error = new Error(reason);
        if (this.pending.size > 0) this.rejectAll(error);
        this.failActiveQueues(error);
        this.onCrash?.(reason, { signal: signal ?? null, code: code ?? null, wasKilled, source: "process_exit" });
      }
    });
    await this.connectWithRetry(listenUrl);
    this.startupComplete = true;
    await this.request("initialize", {
      clientInfo: { name: "codex-chat", title: "codex-chat", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    await this.ensureThread({ verifyExisting: true });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    const error = new Error("Codex app-server stopped");
    this.rejectAll(error);
    this.failActiveQueues(error);
    const child = this.child;
    this.ws?.close();
    if (child && child.exitCode === null && !child.killed) {
      const exited = once(child, "exit").then(() => undefined);
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
  }

  async health(): Promise<CodexHealth> {
    return {
      ok: this.connected && !!this.child && this.child.exitCode === null,
      transport: "app-server",
      sessionId: this.sessionId,
      detail: this.connected ? "connected" : "not connected"
    };
  }


  async *sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent> {
    this.assertConnected();
    await this.ensureThread();
    if (!this.sessionId) throw new Error("No Codex app-server thread is available");
    const queue = new AsyncQueue<CodexEvent>();
    const turnText = input.text;
    const userInput: unknown[] = [{ type: "text", text: turnText, text_elements: [] }];
    for (const attachment of input.attachments ?? []) {
      if (attachment.kind === "image") userInput.push({ type: "localImage", path: attachment.localPath });
    }
    let turnId = "";
    let accumulated = "";
    const handler = (message: JsonRpcMessage): void => {
      if (!message.method || typeof message.params !== "object" || message.params === null) return;
      const params = message.params as Record<string, unknown>;
      if (message.method === "item/agentMessage/delta" && params.turnId === turnId && typeof params.delta === "string") {
        accumulated += params.delta;
        queue.push({ type: "delta", text: params.delta });
      }
      if (message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null) {
        const turn = params.turn as Record<string, unknown>;
        if (turn.id === turnId) {
          queue.push({ type: "final", text: accumulated });
          queue.close();
        }
      }
      if (message.method === "error") {
        queue.push({ type: "error", message: JSON.stringify(params), raw: params });
      }
    };
    this.notificationHandlers.add(handler);
    this.activeQueues.add(queue);
    try {
      const response = await this.startTurnRequest(userInput);
      const turn = response.turn as Record<string, unknown> | undefined;
      turnId = typeof turn?.id === "string" ? turn.id : "";
      if (!turnId) throw new Error("Codex app-server did not return a turn id");
      for await (const event of queue.iterate()) yield event;
    } finally {
      this.notificationHandlers.delete(handler);
      this.activeQueues.delete(queue);
      queue.close();
    }
  }

  private async startTurnRequest(userInput: unknown[]): Promise<Record<string, unknown>> {
    if (!this.sessionId) throw new Error("No Codex app-server thread is available");
    try {
      return await this.request<Record<string, unknown>>("turn/start", this.turnStartParams(userInput));
    } catch (error) {
      if (!this.isThreadNotFound(error)) throw error;
      await this.recoverThread("turn_start_thread_not_found", error);
      if (!this.sessionId) throw new Error("No Codex app-server thread is available after recovery");
      return this.request<Record<string, unknown>>("turn/start", this.turnStartParams(userInput));
    }
  }

  private threadConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { model_reasoning_effort: this.config.codex.effort };
    if (this.config.codex.addDirs.length > 0) {
      cfg.sandbox_workspace_write = { writable_roots: this.config.codex.addDirs };
    }
    return cfg;
  }

  private turnStartParams(userInput: unknown[]): Record<string, unknown> {
    return {
      threadId: this.sessionId,
      input: userInput,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      model: this.config.codex.model,
      effort: this.config.codex.effort
    };
  }

  private async ensureThread(options: { forceNew?: boolean; verifyExisting?: boolean } = {}): Promise<void> {
    this.assertConnected();
    if (this.sessionId && !options.forceNew) {
      if (!options.verifyExisting) return;
      try {
        await this.resumeThread(this.sessionId);
        return;
      } catch (error) {
        this.logger.warn({ component: "codex", event: "resume_failed", error }, "in-memory Codex thread resume failed; starting a new thread");
        this.sessionId = undefined;
      }
    }
    if (options.forceNew) this.sessionId = undefined;
    const existing = options.forceNew ? undefined : await this.state.getCodexSession(this.config.codex.mainSessionName);
    if (existing) {
      try {
        await this.resumeThread(existing);
        return;
      } catch (error) {
        this.logger.warn({ component: "codex", event: "resume_failed", error }, "stored Codex thread resume failed; starting a new thread");
      }
    }
    const bootstrap = await this.behavior.loadBootstrapPrompt();
    const hash = await this.behavior.hash();
    const response = await this.request<Record<string, unknown>>("thread/start", {
      model: this.config.codex.model,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandbox: this.config.codex.sandbox,
      config: this.threadConfig(),
      serviceName: "codex-chat",
      baseInstructions: bootstrap,
      developerInstructions: bootstrap,
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: true
    });
    const thread = response.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    this.sessionId = threadId;
    await this.state.setCodexSession(this.config.codex.mainSessionName, {
      sessionId: threadId,
      transport: "app-server",
      model: this.config.codex.model,
      effort: this.config.codex.effort,
      behaviorHash: hash
    });
  }

  private async recoverThread(event: string, error: unknown): Promise<void> {
    this.logger.warn({ component: "codex", event, error, sessionId: this.sessionId }, "Codex thread was missing; starting a new thread");
    this.sessionId = undefined;
    await this.state.clearCodexSession(this.config.codex.mainSessionName);
    await this.ensureThread({ forceNew: true });
  }

  private isThreadNotFound(error: unknown): boolean {
    const text = error instanceof Error ? error.message : JSON.stringify(error);
    return /thread not found|failed to record rollout items/i.test(text);
  }

  private async resumeThread(sessionId: string): Promise<void> {
    const bootstrap = await this.behavior.loadBootstrapPrompt();
    const hash = await this.behavior.hash();
    await this.request("thread/resume", {
      threadId: sessionId,
      model: this.config.codex.model,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandbox: this.config.codex.sandbox,
      config: this.threadConfig(),
      developerInstructions: bootstrap,
      persistExtendedHistory: true
    });
    this.sessionId = sessionId;
    await this.state.setCodexSession(this.config.codex.mainSessionName, {
      sessionId,
      transport: "app-server",
      model: this.config.codex.model,
      effort: this.config.codex.effort,
      behaviorHash: hash
    });
  }

  private async connectWithRetry(url: string): Promise<void> {
    const deadline = Date.now() + this.config.codex.startupTimeoutSec * 1000;
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
      this.connected = false;
      const hadPending = this.pending.size > 0;
      const hadActiveQueues = this.activeQueues.size > 0;
      if (!this.stopping && this.startupComplete) {
        const reason = "codex app-server websocket closed";
        this.logger.warn({ component: "codex", event: "ws_closed", hadPending, activeQueues: this.activeQueues.size }, reason);
        const error = new Error(reason);
        if (hadPending) this.rejectAll(error);
        // Always close any in-flight sendTurn iterators — without this they
        // would hang forever waiting on AsyncQueue waiters that nobody will
        // satisfy, leaving turnRunning permanently true in the supervisor.
        if (hadActiveQueues) this.failActiveQueues(error);
        this.onCrash?.(reason, { signal: null, code: null, wasKilled: false, source: "websocket_close" });
        return;
      }
      if (hadPending) {
        const reason = "codex app-server websocket closed during startup";
        this.logger.debug({ component: "codex", event: "ws_closed_startup", pending: this.pending.size }, reason);
        this.rejectAll(new Error(reason));
      }
      if (hadActiveQueues) this.failActiveQueues(new Error("codex app-server websocket closed"));
    });
    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.logger.debug({ component: "codex", event: "ws_error", error });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 2000);
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
      this.logger.warn({ component: "codex", event: "invalid_ws_message", raw, error });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
      return;
    }
    for (const handler of this.notificationHandlers) handler(message);
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.assertConnected();
    const ws = this.ws as WebSocket;
    const id = this.requestId++;
    const message = { id, method, params };
    ws.send(JSON.stringify(message));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.config.codex.turnTimeoutSec * 1000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private failActiveQueues(error: Error): void {
    if (this.activeQueues.size === 0) return;
    for (const queue of this.activeQueues) queue.fail(error);
    this.activeQueues.clear();
  }

  private assertConnected(): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server is not connected; reconnect is still in progress or failed");
    }
  }
}
