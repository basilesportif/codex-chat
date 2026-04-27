import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { StateStore } from "./state.js";
import { Attachment, CodexClient, CodexEvent, CodexHealth, CodexTurnInput } from "./types.js";
import { makeId, pathExists } from "./util.js";

type JsonRpcMessage = Record<string, unknown> & { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: unknown };

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

export class AppServerCodexClient implements CodexClient {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private requestId = 1;
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  private stopping = false;
  private sessionId?: string;
  private connected = false;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly behavior: BehaviorPack,
    private readonly logger: Logger,
    private readonly onCrash?: (reason: string) => void
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    const listenUrl = `ws://${this.config.codex.appServerHost}:${this.config.codex.appServerPort}`;
    const args = ["app-server", "--listen", listenUrl];
    for (const item of this.config.codex.extraConfig) args.push("-c", item);
    this.logger.info({ component: "codex", event: "spawn_app_server", args }, "starting codex app-server");
    this.child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child.stdout?.on("data", (chunk) => this.logger.debug({ component: "codex", stream: "stdout", data: chunk.toString() }));
    this.child.stderr?.on("data", (chunk) => this.logger.info({ component: "codex", stream: "stderr", data: chunk.toString() }));
    this.child.on("exit", (code, signal) => {
      this.connected = false;
      if (!this.stopping) {
        const reason = `codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`;
        this.logger.error({ component: "codex", event: "app_server_exit", code, signal }, reason);
        this.rejectAll(new Error(reason));
        this.onCrash?.(reason);
      }
    });
    await this.connectWithRetry(listenUrl);
    await this.request("initialize", {
      clientInfo: { name: "codex-chat", title: "codex-chat", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    await this.ensureThread();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    this.ws?.close();
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
  }

  async health(): Promise<CodexHealth> {
    return {
      ok: this.connected && !!this.child && this.child.exitCode === null,
      transport: "app-server",
      sessionId: this.sessionId,
      detail: this.connected ? "connected" : "not connected"
    };
  }

  async resume(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    if (this.connected) await this.resumeThread(sessionId);
  }

  async *sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent> {
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
    try {
      const response = await this.request<Record<string, unknown>>("turn/start", {
        threadId: this.sessionId,
        input: userInput,
        cwd: this.config.service.workspace,
        approvalPolicy: this.config.codex.approvalPolicy,
        model: this.config.codex.model,
        effort: this.config.codex.effort
      });
      const turn = response.turn as Record<string, unknown> | undefined;
      turnId = typeof turn?.id === "string" ? turn.id : "";
      if (!turnId) throw new Error("Codex app-server did not return a turn id");
      for await (const event of queue.iterate()) yield event;
    } finally {
      this.notificationHandlers.delete(handler);
      queue.close();
    }
  }

  private async ensureThread(): Promise<void> {
    if (this.sessionId) return;
    const existing = await this.state.getCodexSession(this.config.codex.mainSessionName);
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
      config: { model_reasoning_effort: this.config.codex.effort },
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

  private async resumeThread(sessionId: string): Promise<void> {
    const bootstrap = await this.behavior.loadBootstrapPrompt();
    const hash = await this.behavior.hash();
    await this.request("thread/resume", {
      threadId: sessionId,
      model: this.config.codex.model,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandbox: this.config.codex.sandbox,
      config: { model_reasoning_effort: this.config.codex.effort },
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
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => {
      this.connected = false;
      if (!this.stopping) {
        const reason = "codex app-server websocket closed";
        this.rejectAll(new Error(reason));
        this.onCrash?.(reason);
      }
    });
    ws.on("error", (error) => {
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Codex app-server websocket is not open");
    const id = this.requestId++;
    const message = { id, method, params };
    this.ws.send(JSON.stringify(message));
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
}

export class ExecResumeCodexClient implements CodexClient {
  private sessionId?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly behavior: BehaviorPack,
    private readonly logger: Logger
  ) {}

  async start(): Promise<void> {
    this.sessionId = await this.state.getCodexSession(this.config.codex.mainSessionName);
  }

  async stop(): Promise<void> {}

  async health(): Promise<CodexHealth> {
    return { ok: true, transport: "exec-resume", sessionId: this.sessionId, detail: "exec fallback available" };
  }

  async resume(sessionId: string): Promise<void> {
    this.sessionId = sessionId;
    await this.state.setCodexSession(this.config.codex.mainSessionName, { sessionId, transport: "exec-resume" });
  }

  async *sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent> {
    const artifactDir = resolveConfigPath(this.config, join("data", "exec-fallback", makeId("turn")));
    await mkdir(artifactDir, { recursive: true });
    const lastMessage = join(artifactDir, "last-message.md");
    const prompt = await this.assemblePrompt(input);
    const args = this.sessionId
      ? this.resumeArgs(this.sessionId, lastMessage, input.attachments ?? [])
      : this.execArgs(lastMessage, input.attachments ?? []);
    this.logger.info({ component: "codex", event: "exec_fallback_start", args: args.filter((arg) => arg !== prompt) });
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    child.stdin?.end(prompt);
    let stderr = "";
    let stdoutBuffer = "";
    const queue = new AsyncQueue<CodexEvent>();
    const yieldEvent = (event: CodexEvent): void => queue.push(event);
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          const event = this.parseExecEvent(line);
          if (event) yieldEvent(event);
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.on("exit", async (code, signal) => {
      if (code !== 0) queue.push({ type: "error", message: `codex exec failed code=${code} signal=${signal ?? "null"} ${stderr}`.trim() });
      const final = (await pathExists(lastMessage)) ? await readFile(lastMessage, "utf8") : "";
      if (final.trim()) queue.push({ type: "final", text: final });
      queue.close();
    });
    for await (const event of queue.iterate()) yield event;
  }

  private async assemblePrompt(input: CodexTurnInput): Promise<string> {
    const bootstrap = await this.behavior.loadBootstrapPrompt();
    const attachments = (input.attachments ?? [])
      .map((attachment) => `- ${attachment.kind}: ${attachment.localPath}${attachment.mimeType ? ` (${attachment.mimeType})` : ""}`)
      .join("\n");
    return [
      bootstrap,
      "",
      "Incoming codex-chat turn:",
      input.text,
      attachments ? `\nAttachments:\n${attachments}` : ""
    ].join("\n");
  }

  private execArgs(lastMessage: string, attachments: Attachment[]): string[] {
    const args = ["exec", "--json", "--output-last-message", lastMessage, "--model", this.config.codex.model, "--cd", this.config.service.workspace, "--sandbox", this.config.codex.sandbox];
    if (this.config.codex.profile) args.push("--profile", this.config.codex.profile);
    args.push("-c", `ask_for_approval="${this.config.codex.approvalPolicy}"`, "-c", `model_reasoning_effort="${this.config.codex.effort}"`);
    for (const item of this.config.codex.extraConfig) args.push("-c", item);
    for (const attachment of attachments) if (attachment.kind === "image") args.push("--image", attachment.localPath);
    args.push("-");
    return args;
  }

  private resumeArgs(sessionId: string, lastMessage: string, attachments: Attachment[]): string[] {
    const args = ["exec", "resume", "--json", "--output-last-message", lastMessage, "--model", this.config.codex.model];
    args.push("-c", `ask_for_approval="${this.config.codex.approvalPolicy}"`, "-c", `model_reasoning_effort="${this.config.codex.effort}"`);
    for (const attachment of attachments) if (attachment.kind === "image") args.push("--image", attachment.localPath);
    args.push(sessionId, "-");
    return args;
  }

  private parseExecEvent(line: string): CodexEvent | undefined {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const type = String(parsed.type ?? parsed.event ?? "");
      const text = typeof parsed.delta === "string" ? parsed.delta : typeof parsed.text === "string" ? parsed.text : "";
      if (type.includes("agent_message_delta") || type.includes("message_delta")) return { type: "delta", text };
      if (type.includes("error")) return { type: "error", message: JSON.stringify(parsed), raw: parsed };
      return { type: "status", message: type || "event", raw: parsed };
    } catch {
      return undefined;
    }
  }
}

export class HybridCodexClient implements CodexClient {
  private active: CodexClient;
  private readonly fallback: ExecResumeCodexClient;

  constructor(
    private readonly primary: AppServerCodexClient,
    fallback: ExecResumeCodexClient,
    private readonly logger: Logger
  ) {
    this.active = primary;
    this.fallback = fallback;
  }

  async start(): Promise<void> {
    try {
      await this.primary.start();
      this.active = this.primary;
    } catch (error) {
      this.logger.error({ component: "codex", event: "app_server_start_failed", error }, "app-server start failed; using exec fallback");
      await this.fallback.start();
      this.active = this.fallback;
    }
  }

  async stop(): Promise<void> {
    await this.active.stop();
  }

  async health(): Promise<CodexHealth> {
    return this.active.health();
  }

  async resume(sessionId: string): Promise<void> {
    await this.active.resume(sessionId);
  }

  async *sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent> {
    try {
      for await (const event of this.active.sendTurn(input)) yield event;
    } catch (error) {
      if (this.active === this.primary) {
        this.logger.error({ component: "codex", event: "primary_turn_failed", error }, "primary Codex turn failed; retrying through exec fallback");
        await this.fallback.start();
        this.active = this.fallback;
        for await (const event of this.active.sendTurn(input)) yield event;
      } else {
        throw error;
      }
    }
  }
}
