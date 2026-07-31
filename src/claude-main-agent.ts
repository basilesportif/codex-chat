import { appendFile, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  query as queryClaudeAgentSdk,
  type EffortLevel as ClaudeEffortLevel,
  type Options as ClaudeAgentSdkOptions,
  type Query as ClaudeAgentSdkQuery,
  type SDKMessage as ClaudeSdkMessage,
  type SDKUserMessage as ClaudeSdkUserMessage
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";
import type { BehaviorPack } from "./behavior.js";
import {
  ClaudeOAuthReadinessError,
  checkClaudeOAuthReadiness,
  redactClaudeSecrets,
  verifyClaudeOAuthInitialization,
  type ChildEnvSource
} from "./claude-auth.js";
import { resolveConfigPath, type AppConfig } from "./config.js";
import type { CodexCrashHandler } from "./codex.js";
import { LogBuffer } from "./log-buffer.js";
import type { StateStore } from "./state.js";
import type { Attachment, MainAgentClient, MainAgentEvent, MainAgentHealth, MainAgentTurnInput } from "./types.js";
import { nowIso } from "./util.js";

type ClaudeErrorKind = "auth" | "rate_limit" | "closed" | "other";
type ClaudeMainErrorEvent = Extract<MainAgentEvent, { type: "error" }> & { kind: ClaudeErrorKind };

interface ActiveTurn {
  readonly queue: AsyncEventQueue<MainAgentEvent>;
  assistantText: string;
  partialText: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

class AsyncUserMessageQueue implements AsyncIterable<ClaudeSdkUserMessage> {
  private readonly values: ClaudeSdkUserMessage[] = [];
  private waiter?: {
    resolve: (value: IteratorResult<ClaudeSdkUserMessage>) => void;
    reject: (error: Error) => void;
  };
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
    return { next: () => this.next() };
  }

  push(value: ClaudeSdkUserMessage): void {
    if (this.closed) throw new Error("Claude Agent SDK input stream is closed.");
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ done: true, value: undefined });
    }
  }

  private next(): Promise<IteratorResult<ClaudeSdkUserMessage>> {
    if (this.values.length > 0) {
      return Promise.resolve({ done: false, value: this.values.shift() as ClaudeSdkUserMessage });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<ClaudeSdkUserMessage>>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

export class ClaudeMainAgentClient implements MainAgentClient {
  private query?: ClaudeAgentSdkQuery;
  private inputQueue?: AsyncUserMessageQueue;
  private activeTurn?: ActiveTurn;
  private startupFailure?: Deferred<never>;
  private sessionId?: string;
  private currentBehaviorHash?: string;
  private safeEnv: ChildEnvSource = {};
  private pendingBehaviorRefresh?: string;
  private alive = false;
  private starting = false;
  private stopping = false;
  private detail = "not initialized";
  private generation = 0;
  private endedGeneration?: number;
  private readonly logBuffer = new LogBuffer(300);

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly behavior: BehaviorPack,
    private readonly logger: Logger,
    private readonly onCrash?: CodexCrashHandler
  ) {}

  async start(): Promise<void> {
    if (this.alive && this.query) return;
    this.starting = true;
    this.stopping = false;
    this.detail = "starting";
    this.pendingBehaviorRefresh = undefined;
    const cfg = this.config.mainAgent.claude;
    const timeoutMs = cfg.startupTimeoutSec * 1000;

    try {
      let readiness;
      try {
        readiness = await checkClaudeOAuthReadiness(this.config, {
          overrides: {
            BRAIN_IPC_SOCKET: resolveConfigPath(this.config, this.config.service.ipcSocket)
          }
        });
      } catch (error) {
        if (error instanceof ClaudeOAuthReadinessError) {
          this.logger.error(
            {
              component: "claude-main-agent",
              event: "readiness_failed",
              oauthEnvPresent: error.readiness.oauthEnvPresent,
              credentialFiles: error.readiness.credentialFiles,
              strippedNonOAuthEnv: error.readiness.strippedNonOAuthEnv
            },
            error.message
          );
        }
        throw error;
      }
      this.safeEnv = readiness.safeEnv;
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "readiness",
          oauthEnvPresent: readiness.oauthEnvPresent,
          credentialFiles: readiness.credentialFiles,
          strippedNonOAuthEnv: readiness.strippedNonOAuthEnv
        },
        "Claude Agent SDK main-loop OAuth readiness passed"
      );

      const [bootstrap, behaviorHash, storedSessionId, storedBehaviorHash] = await Promise.all([
        this.behavior.loadBootstrapPrompt(),
        this.behavior.hash(),
        this.state.getCodexSession(cfg.mainSessionName),
        this.state.getCodexSessionBehaviorHash(cfg.mainSessionName)
      ]);
      this.currentBehaviorHash = behaviorHash;
      this.sessionId = storedSessionId;

      let resumed = false;
      if (storedSessionId) {
        try {
          await this.launchQuery(bootstrap, timeoutMs, storedSessionId);
          resumed = true;
        } catch (error) {
          this.logger.warn(
            {
              component: "claude-main-agent",
              event: "resume_failed",
              sessionId: storedSessionId,
              error: this.redactError(error)
            },
            "stored Claude Agent SDK session resume failed; starting a fresh session"
          );
          await this.disposeQuery(false);
          await this.state.clearCodexSession(cfg.mainSessionName);
          this.sessionId = undefined;
          await this.launchQuery(bootstrap, timeoutMs);
        }
      } else {
        await this.launchQuery(bootstrap, timeoutMs);
      }

      if (resumed && storedBehaviorHash && storedBehaviorHash !== behaviorHash) {
        this.pendingBehaviorRefresh = bootstrap;
        this.logger.info(
          { component: "claude-main-agent", event: "behavior_refresh_pending", sessionId: this.sessionId },
          "behavior pack changed since the Claude session last saw it; queueing behavior-refresh turn"
        );
      }
      // A resumed session id is already known, so refresh its metadata now.
      // A fresh streaming-input query does not emit system/init until the
      // first user turn; persist fresh sessions lazily when that message arrives.
      if (resumed && this.sessionId) await this.persistSession(this.sessionId, behaviorHash);
      if (this.endedGeneration === this.generation || !this.query) {
        throw new Error("Claude Agent SDK query ended during startup.");
      }
      this.alive = true;
      this.detail = resumed
        ? "connected (resumed)"
        : this.sessionId
          ? "connected"
          : "connected (awaiting first turn)";
      this.logBuffer.append(
        "event",
        `[SESSION] ${resumed ? "resumed" : "started"} session_id=${this.sessionId ?? "awaiting-first-turn"}`
      );
    } catch (error) {
      this.alive = false;
      this.detail = this.redactError(error);
      await this.disposeQuery(false);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.alive = false;
    this.detail = "stopped";
    this.activeTurn?.queue.close();
    this.activeTurn = undefined;
    await this.disposeQuery(true);
  }

  async health(): Promise<MainAgentHealth> {
    return {
      ok: this.alive && Boolean(this.query),
      transport: "claude-agent-sdk",
      provider: "claude_agent_sdk",
      sessionId: this.sessionId,
      detail: this.detail
    };
  }

  async *sendTurn(input: MainAgentTurnInput): AsyncIterable<MainAgentEvent> {
    if (!this.alive || !this.query || !this.inputQueue) {
      throw new Error("Claude Agent SDK main session is closed or uninitialized.");
    }
    if (this.activeTurn) {
      throw new Error("Claude Agent SDK main session already has an active turn.");
    }

    const turn: ActiveTurn = {
      queue: new AsyncEventQueue<MainAgentEvent>(),
      assistantText: "",
      partialText: ""
    };
    this.activeTurn = turn;
    this.logBuffer.append("event", `[TURN START] session_id=${this.sessionId ?? "?"}`);
    try {
      this.inputQueue.push(await this.buildUserMessage(input.text, input.attachments ?? []));
      for await (const event of turn.queue.iterate()) yield event;
    } catch (error) {
      if (this.activeTurn === turn) {
        turn.queue.push(this.errorEvent(error));
        turn.queue.close();
      }
      throw error;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
      turn.queue.close();
    }
  }

  async resetSession(reason = "manual_reset"): Promise<MainAgentHealth> {
    const previousSessionId = this.sessionId;
    this.logger.warn(
      { component: "claude-main-agent", event: "reset_session", reason, previousSessionId },
      "resetting Claude Agent SDK main session"
    );
    await this.stop();
    await this.state.clearCodexSession(this.config.mainAgent.claude.mainSessionName);
    this.sessionId = undefined;
    this.pendingBehaviorRefresh = undefined;
    await this.start();
    return this.health();
  }

  getRecentLogs(n = 100, includeRaw = false): string[] {
    return this.logBuffer.recent(n, includeRaw).map((entry) => `[${entry.ts}] ${entry.stream.padEnd(6)} ${entry.line}`);
  }

  consumePendingBehaviorRefresh(): string | undefined {
    const refresh = this.pendingBehaviorRefresh;
    this.pendingBehaviorRefresh = undefined;
    return refresh;
  }

  private async launchQuery(bootstrap: string, timeoutMs: number, resume?: string): Promise<void> {
    const generation = ++this.generation;
    this.endedGeneration = undefined;
    const inputQueue = new AsyncUserMessageQueue();
    const startupFailure = deferred<never>();
    const options = this.buildOptions(bootstrap, resume);
    const query = queryClaudeAgentSdk({ prompt: inputQueue, options });
    this.query = query;
    this.inputQueue = inputQueue;
    this.startupFailure = startupFailure;
    void this.consumeQuery(query, generation);

    try {
      await Promise.race([
        verifyClaudeOAuthInitialization(query, timeoutMs, (initialized) => {
          this.logger.info(
            {
              component: "claude-main-agent",
              event: "initialized",
              account: initialized.account
            },
            "Claude Agent SDK main loop initialized with subscription OAuth"
          );
        }),
        startupFailure.promise
      ]);
    } finally {
      if (this.startupFailure === startupFailure) this.startupFailure = undefined;
    }
    if (this.endedGeneration === generation || this.query !== query) {
      throw new Error("Claude Agent SDK query ended during initialization.");
    }
  }

  private buildOptions(bootstrap: string, resume?: string): ClaudeAgentSdkOptions {
    const cfg = this.config.mainAgent.claude;
    const options: ClaudeAgentSdkOptions = {
      cwd: this.config.service.workspace,
      env: {
        ...this.safeEnv,
        CLAUDE_AGENT_SDK_CLIENT_APP: "codex-chat/main"
      },
      systemPrompt: bootstrap,
      model: cfg.model,
      effort: cfg.effort as ClaudeEffortLevel,
      permissionMode: cfg.permissionMode,
      allowDangerouslySkipPermissions:
        cfg.permissionMode === "bypassPermissions" ? cfg.allowDangerouslySkipPermissions : undefined,
      tools: cfg.allowedTools,
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      settingSources: cfg.settingSources,
      strictMcpConfig: true,
      includePartialMessages: true,
      stderr: (data) => this.captureStderr(data),
      title: "codex-chat main"
    };
    if (cfg.pathToClaudeCodeExecutable.trim()) {
      options.pathToClaudeCodeExecutable = cfg.pathToClaudeCodeExecutable.trim();
    }
    if (resume) options.resume = resume;
    return options;
  }

  private async consumeQuery(query: ClaudeAgentSdkQuery, generation: number): Promise<void> {
    try {
      for await (const message of query) {
        if (generation !== this.generation) return;
        this.handleSdkMessage(message);
      }
      this.handleUnexpectedTermination(generation, "Claude Agent SDK query ended unexpectedly.");
    } catch (error) {
      this.handleUnexpectedTermination(generation, this.redactError(error), error);
    }
  }

  private handleSdkMessage(message: ClaudeSdkMessage): void {
    const subtype = "subtype" in message && typeof message.subtype === "string" ? message.subtype : undefined;
    this.logBuffer.append("event", `[SDK] type=${message.type}${subtype ? ` subtype=${subtype}` : ""}`, true);

    if (message.type === "system" && message.subtype === "init") {
      if (message.apiKeySource && message.apiKeySource !== "oauth" && message.apiKeySource !== "none") {
        throw new Error(
          `Claude Agent SDK requires OAuth credentials; SDK init reported apiKeySource=${message.apiKeySource}.`
        );
      }
      const previousSessionId = this.sessionId;
      this.sessionId = message.session_id;
      if (previousSessionId && previousSessionId !== message.session_id) {
        this.logger.warn(
          {
            component: "claude-main-agent",
            event: "session_id_changed",
            previousSessionId,
            reportedSessionId: message.session_id
          },
          "Claude Agent SDK reported a different session id; updating persisted main session"
        );
      }
      if (this.alive && !previousSessionId) this.detail = "connected";
      void this.persistSession(message.session_id).catch((error) => {
        this.logger.error(
          { component: "claude-main-agent", event: "session_persist_failed", error: this.redactError(error) },
          "failed to persist Claude Agent SDK main session"
        );
      });
      return;
    }

    const turn = this.activeTurn;
    if (!turn) return;
    if (message.type === "stream_event") {
      const delta = extractClaudeStreamDelta(message);
      if (delta) {
        turn.partialText += delta;
        turn.queue.push({ type: "delta", text: delta });
      }
      return;
    }
    if (message.type === "assistant") {
      turn.assistantText += extractClaudeAssistantText(message);
      if (message.error) turn.queue.push(this.errorEvent(message.error));
      return;
    }
    if (message.type === "result") {
      if (message.subtype === "success") {
        const final = message.result || turn.assistantText || turn.partialText;
        turn.queue.push({ type: "final", text: final });
        this.logBuffer.append("event", `[TURN END] status=success session_id=${message.session_id}`);
      } else {
        const errors = message.errors.length > 0 ? message.errors.join("; ") : message.subtype;
        turn.queue.push(this.errorEvent(errors, message));
        this.logBuffer.append("event", `[TURN END] status=error kind=${classifyClaudeError(errors)}`);
      }
      turn.queue.close();
      this.activeTurn = undefined;
      return;
    }
    if (message.type === "system" && message.subtype === "status" && message.status) {
      turn.queue.push({ type: "status", message: message.status, raw: { subtype: message.subtype } });
      return;
    }
    if (message.type === "system" && message.subtype === "informational") {
      turn.queue.push({ type: "status", message: message.content, raw: { subtype: message.subtype, level: message.level } });
      return;
    }
    if (message.type === "tool_progress") {
      turn.queue.push({
        type: "status",
        message: `${message.tool_name} running (${message.elapsed_time_seconds}s)`,
        raw: { type: message.type, toolName: message.tool_name }
      });
      return;
    }
    if (message.type === "auth_status" && message.error) {
      turn.queue.push(this.errorEvent(message.error, { type: message.type }));
      return;
    }
    if (message.type === "rate_limit_event" && message.rate_limit_info.status === "rejected") {
      turn.queue.push(this.errorEvent("Claude subscription rate limit reached.", { type: message.type }));
    }
  }

  private handleUnexpectedTermination(generation: number, reason: string, raw?: unknown): void {
    if (generation !== this.generation) return;
    this.endedGeneration = generation;
    this.alive = false;
    this.detail = reason;
    const error = new Error(reason);
    this.startupFailure?.reject(error);
    const turn = this.activeTurn;
    if (turn) {
      turn.queue.push(this.errorEvent(error, raw));
      turn.queue.close();
      this.activeTurn = undefined;
      return;
    }
    if (!this.stopping && !this.starting) {
      this.logger.warn({ component: "claude-main-agent", event: "query_ended", reason }, reason);
      this.onCrash?.(reason, {
        signal: null,
        code: null,
        wasKilled: false,
        source: "process_exit"
      });
    }
  }

  private async disposeQuery(interrupt: boolean): Promise<void> {
    const query = this.query;
    this.generation += 1;
    this.inputQueue?.close();
    this.inputQueue = undefined;
    this.query = undefined;
    this.startupFailure = undefined;
    if (!query) return;
    if (interrupt) {
      try {
        await query.interrupt();
      } catch (error) {
        this.logger.warn(
          { component: "claude-main-agent", event: "interrupt_failed", error: this.redactError(error) },
          "Claude Agent SDK interrupt failed; closing query"
        );
      }
    }
    query.close();
  }

  private async persistSession(sessionId: string, behaviorHash = this.currentBehaviorHash): Promise<void> {
    if (!behaviorHash) throw new Error("Cannot persist Claude Agent SDK session before behavior hash is available.");
    const cfg = this.config.mainAgent.claude;
    await this.state.setCodexSession(cfg.mainSessionName, {
      sessionId,
      provider: "claude_agent_sdk",
      transport: "claude-agent-sdk",
      model: cfg.model,
      behaviorHash
    });
  }

  private async buildUserMessage(text: string, attachments: Attachment[]): Promise<ClaudeSdkUserMessage> {
    const content: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const attachment of attachments) {
      if (attachment.kind !== "image") {
        content.push({ type: "text", text: `\n\n[Attached ${attachment.kind} path: ${attachment.localPath}]` });
        continue;
      }
      const mediaType = imageMediaType(attachment.localPath);
      if (!mediaType) {
        content.push({ type: "text", text: `\n\n[Attached image path: ${attachment.localPath}]` });
        continue;
      }
      try {
        const data = (await readFile(attachment.localPath)).toString("base64");
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      } catch {
        content.push({
          type: "text",
          text: `\n\n[Attached image path unreadable by parent; try reading locally if needed: ${attachment.localPath}]`
        });
      }
    }
    return {
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
      timestamp: nowIso()
    };
  }

  private captureStderr(data: string): void {
    const redacted = redactClaudeSecrets(data, this.config, { ...process.env, ...this.safeEnv });
    this.logBuffer.append("stderr", redacted);
    const path = join(this.state.root, "claude-main-agent.stderr.log");
    void appendFile(path, redacted, { mode: 0o600 }).catch((error) => {
      this.logger.error(
        { component: "claude-main-agent", event: "stderr_write_failed", error: this.redactError(error) },
        "failed to write redacted Claude Agent SDK stderr"
      );
    });
  }

  private errorEvent(error: unknown, raw?: unknown): ClaudeMainErrorEvent {
    const message = this.redactError(error);
    const kind = classifyClaudeError(message);
    return { type: "error", message, kind, raw: raw === undefined ? { kind } : { kind, detail: safeErrorRaw(raw) } };
  }

  private redactError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return redactClaudeSecrets(message, this.config, { ...process.env, ...this.safeEnv });
  }
}

function deferred<T>(): Deferred<T> {
  let settled = false;
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    }
  };
}

function extractClaudeAssistantText(message: Extract<ClaudeSdkMessage, { type: "assistant" }>): string {
  const content = message.message.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      text += block.text;
    }
  }
  return text;
}

function extractClaudeStreamDelta(message: Extract<ClaudeSdkMessage, { type: "stream_event" }>): string {
  const event = message.event as unknown;
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  if (record.type !== "content_block_delta" || !record.delta || typeof record.delta !== "object") return "";
  const delta = record.delta as Record<string, unknown>;
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function imageMediaType(path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

function classifyClaudeError(message: string): ClaudeErrorKind {
  const normalized = message.toLowerCase();
  if (/rate.?limit|usage.?limit|too many requests|quota/.test(normalized)) return "rate_limit";
  if (/oauth|auth(?:entication|orization)?|credential|api.?provider|api.?key/.test(normalized)) return "auth";
  if (/closed|ended|interrupt|not initialized|uninitialized|disposed|dead/.test(normalized)) return "closed";
  return "other";
}

function safeErrorRaw(raw: unknown): unknown {
  if (raw instanceof Error) return { name: raw.name };
  if (typeof raw === "string") return undefined;
  if (raw && typeof raw === "object" && "type" in raw) {
    const value = raw as Record<string, unknown>;
    return {
      type: value.type,
      subtype: value.subtype,
      session_id: value.session_id
    };
  }
  return undefined;
}
