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
import {
  CLAUDE_AGENT_TOOL_NAME,
  CLAUDE_NESTED_AGENTS_DRAINED_NUDGE,
  buildForceForegroundNestedAgentsHook,
  claudeNestedAgentPromptRules,
  isClaudeNestedAgentTask,
  normalizeClaudeBackgroundTasks,
  type ClaudeBackgroundTask
} from "./claude-nested-agents.js";
import { resolveConfigPath, type AppConfig } from "./config.js";
import type { CodexCrashHandler } from "./codex.js";
import { LogBuffer } from "./log-buffer.js";
import type { StateStore } from "./state.js";
import type {
  Attachment,
  MainAgentClient,
  MainAgentContextStats,
  MainAgentEvent,
  MainAgentHealth,
  MainAgentTurnInput
} from "./types.js";
import { nowIso } from "./util.js";

type ClaudeErrorKind = "auth" | "rate_limit" | "closed" | "other";
type ClaudeMainErrorEvent = Extract<MainAgentEvent, { type: "error" }> & { kind: ClaudeErrorKind };

interface ActiveTurn {
  readonly queue: AsyncEventQueue<MainAgentEvent>;
  assistantText: string;
  partialText: string;
  /**
   * A successful result withheld because nested native agents launched by this
   * turn were still running. The turn stays open until they drain and the
   * session produces a post-nested result (or a bound below releases this).
   */
  heldFinalText?: string;
  /** Fires `nestedAgentSettleGraceMs` after the nested set drains while quiet. */
  drainTimer?: NodeJS.Timeout;
  /** Absolute `nestedAgentHoldMaxMs` bound armed when the hold starts. */
  holdTimer?: NodeJS.Timeout;
  nudgeSent: boolean;
}

/**
 * Appended to the behavior-pack bootstrap for the Claude main session only.
 * `[mainAgent.claude].allowedTools` includes the SDK-native `Agent` tool, and
 * SDK 0.3.220 backgrounds those calls by default — which would let the session
 * finish its turn (and codex-chat reply on Telegram) while the nested agent it
 * just launched is still working.
 */
const CLAUDE_MAIN_NESTED_AGENT_GUIDANCE = [
  "Nested agents (codex-chat main loop):",
  ...claudeNestedAgentPromptRules("bug"),
  "If you have nothing to report yet because nested work is still running, keep working instead of ending your turn: the user only sees your final message."
].join("\n");

/**
 * `raw.event` marker on the status event emitted when a turn starts on a fresh
 * session because the previous one outgrew the context window. The service
 * matches on it to tell the user their history is gone.
 */
export const CLAUDE_CONTEXT_ROLLOVER_EVENT = "claude_context_rollover";

/**
 * One-line handoff prepended to the first user message of the fresh session.
 * Deliberately not a summary — this pass only makes the discontinuity legible.
 */
const CLAUDE_CONTEXT_ROLLOVER_HANDOFF =
  "[codex-chat] Note: the previous main session reached its context limit and was rolled over. Prior conversation history is unavailable to you; work from this message alone and ask if you need context restated.";

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
  /**
   * Live background tasks from the SDK's `system` / `background_tasks_changed`
   * message (REPLACE semantics: every payload carries the whole set). Only the
   * nested-agent subset gates turn completion; a backgrounded `Bash` dev server
   * must never hold a user's reply.
   */
  private liveBackgroundTasks: ClaudeBackgroundTask[] = [];
  private liveNestedAgentTasks: ClaudeBackgroundTask[] = [];
  /**
   * Bumped on every SDK message. The quiet-parent drain timer captures it and
   * aborts if the session spoke again, so a stale timer cannot release a turn
   * that is making progress.
   */
  private sdkActivityGeneration = 0;
  /**
   * Effective input size (input + cache read + cache creation tokens) of the
   * last completed turn, straight off the SDK result message. This is the only
   * signal codex-chat gets about how full the resumed session's context is.
   */
  private lastTurnInputTokens?: number;
  /**
   * Set when a completed turn crossed `contextRolloverInputTokens`. Acted on at
   * the NEXT turn boundary — never mid-turn — so no in-flight work is lost.
   */
  private pendingContextRollover?: { inputTokens: number };
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
    // A provider switch only waits MAIN_AGENT_SWITCH_GRACE_MS for in-flight
    // turns before calling stop(); flush anything being held so the switch
    // costs the user a stale reply rather than silence.
    this.flushHeldResult("session stopped");
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
    if (this.activeTurn) {
      throw new Error("Claude Agent SDK main session already has an active turn.");
    }
    // Turn boundary: the only safe place to swap the underlying session.
    const rolledOver = await this.rolloverContextIfPending();
    if (!this.alive || !this.query || !this.inputQueue) {
      throw new Error("Claude Agent SDK main session is closed or uninitialized.");
    }

    const turn: ActiveTurn = {
      queue: new AsyncEventQueue<MainAgentEvent>(),
      assistantText: "",
      partialText: "",
      nudgeSent: false
    };
    this.activeTurn = turn;
    this.logBuffer.append("event", `[TURN START] session_id=${this.sessionId ?? "?"}`);
    try {
      if (rolledOver) {
        turn.queue.push({
          type: "status",
          message: "main session context rolled over; conversation history was reset",
          raw: {
            event: CLAUDE_CONTEXT_ROLLOVER_EVENT,
            previousSessionId: rolledOver.previousSessionId,
            previousTurnInputTokens: rolledOver.inputTokens,
            thresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens
          }
        });
      }
      const text = rolledOver ? `${CLAUDE_CONTEXT_ROLLOVER_HANDOFF}\n\n${input.text}` : input.text;
      this.inputQueue.push(await this.buildUserMessage(text, input.attachments ?? []));
      for await (const event of turn.queue.iterate()) yield event;
    } catch (error) {
      if (this.activeTurn === turn) {
        turn.queue.push(this.errorEvent(error));
        turn.queue.close();
      }
      throw error;
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
      this.clearNestedHoldTimers(turn);
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
    await this.clearPersistedSession(reason);
    this.pendingBehaviorRefresh = undefined;
    await this.start();
    return this.health();
  }

  /**
   * Drop the persisted Claude main-session record (and the in-memory id that
   * would otherwise be re-persisted) without restarting. The watchdog calls
   * this through the switcher so recovery clears the ACTIVE provider's key —
   * before this existed it always cleared the Codex key, which left a wedged
   * Claude session resumable forever.
   */
  async clearPersistedSession(reason = "clear_persisted_session"): Promise<void> {
    await this.state.clearCodexSession(this.config.mainAgent.claude.mainSessionName);
    this.sessionId = undefined;
    this.lastTurnInputTokens = undefined;
    this.pendingContextRollover = undefined;
    this.logBuffer.append("event", `[SESSION] cleared persisted session reason=${reason}`);
  }

  contextStats(): MainAgentContextStats {
    return {
      lastTurnInputTokens: this.lastTurnInputTokens,
      rolloverThresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens,
      rolloverPending: this.pendingContextRollover !== undefined
    };
  }

  /**
   * SDK 0.3.220 exposes no imperative compaction control on `Query` (only the
   * `autoCompactEnabled` setting and PreCompact/PostCompact hooks), so growth
   * is bounded by starting a fresh session instead. Runs at a turn boundary
   * only; returns the pre-rollover facts when one happened.
   */
  private async rolloverContextIfPending(): Promise<{ inputTokens: number; previousSessionId?: string } | undefined> {
    const pending = this.pendingContextRollover;
    if (!pending) return undefined;
    this.pendingContextRollover = undefined;
    const previousSessionId = this.sessionId;
    this.logger.warn(
      {
        component: "claude-main-agent",
        event: "context_rollover",
        previousSessionId,
        inputTokens: pending.inputTokens,
        thresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens
      },
      "rolling the Claude main session over to a fresh one before it exhausts its context window"
    );
    this.logBuffer.append("event", `[SESSION] context rollover input_tokens=${pending.inputTokens}`);
    try {
      await this.stop();
      await this.clearPersistedSession("context_rollover");
      this.pendingBehaviorRefresh = undefined;
      await this.start();
    } catch (error) {
      this.logger.error(
        { component: "claude-main-agent", event: "context_rollover_failed", error: this.redactError(error) },
        "failed to roll the Claude main session over to a fresh session"
      );
      throw error;
    }
    return { inputTokens: pending.inputTokens, previousSessionId };
  }

  /**
   * Record how full the session's context is from a completed turn's usage and
   * arm a rollover once it crosses the configured threshold.
   */
  private recordTurnUsage(message: Extract<ClaudeSdkMessage, { type: "result" }>): void {
    const inputTokens = effectiveInputTokens(message);
    if (inputTokens === undefined) return;
    this.lastTurnInputTokens = inputTokens;
    const threshold = this.config.mainAgent.claude.contextRolloverInputTokens;
    this.logBuffer.append("event", `[USAGE] input_tokens=${inputTokens} rollover_threshold=${threshold}`, true);
    if (inputTokens < threshold || this.pendingContextRollover) return;
    this.pendingContextRollover = { inputTokens };
    this.logger.warn(
      {
        component: "claude-main-agent",
        event: "context_rollover_scheduled",
        sessionId: this.sessionId,
        inputTokens,
        thresholdTokens: threshold
      },
      "Claude main session crossed the context rollover threshold; the next turn will start a fresh session"
    );
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
      systemPrompt: `${bootstrap}\n\n${CLAUDE_MAIN_NESTED_AGENT_GUIDANCE}`,
      model: cfg.model,
      effort: cfg.effort as ClaudeEffortLevel,
      permissionMode: cfg.permissionMode,
      allowDangerouslySkipPermissions:
        cfg.permissionMode === "bypassPermissions" ? cfg.allowDangerouslySkipPermissions : undefined,
      tools: cfg.allowedTools,
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      settingSources: cfg.settingSources,
      // The main loop declares no programmatic `agents`; whatever agent types
      // the Agent tool exposes come from the SDK and from any filesystem
      // agent definitions `settingSources` loads, none of which codex-chat can
      // annotate with `background: false`. The hook is therefore the only
      // structural place to force foreground execution here.
      hooks: {
        PreToolUse: [
          {
            matcher: CLAUDE_AGENT_TOOL_NAME,
            hooks: [
              buildForceForegroundNestedAgentsHook(({ subagentType }) => {
                this.logBuffer.append(
                  "event",
                  `[NESTED AGENT] forced foreground subagent_type=${subagentType ?? "unspecified"}`
                );
                this.logger.info(
                  {
                    component: "claude-main-agent",
                    event: "claude_nested_agent_forced_foreground",
                    sessionId: this.sessionId,
                    subagentType
                  },
                  "rewrote a nested Agent call to run in the foreground"
                );
              })
            ]
          }
        ]
      },
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
    // Any SDK message means the session is not quiet, so a pending quiet-parent
    // release must be cancelled and re-armed only once it goes silent again.
    this.sdkActivityGeneration += 1;
    this.clearNestedDrainTimer();
    try {
      this.routeSdkMessage(message);
    } finally {
      this.armNestedDrainTimerIfIdle();
    }
  }

  private routeSdkMessage(message: ClaudeSdkMessage): void {
    const subtype = "subtype" in message && typeof message.subtype === "string" ? message.subtype : undefined;
    this.logBuffer.append("event", `[SDK] type=${message.type}${subtype ? ` subtype=${subtype}` : ""}`, true);

    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      this.replaceLiveBackgroundTasks(message.tasks ?? []);
      return;
    }

    if (message.type === "system" && message.subtype === "init") {
      // SDK 0.3.220 narrowed the apiKeySource union to API-key sources only
      // (OAuth sessions omit the field); widen so the historic oauth/none
      // values stay tolerated while any API-key source still fails closed.
      const mainApiKeySource = message.apiKeySource as string | undefined;
      if (mainApiKeySource && mainApiKeySource !== "oauth" && mainApiKeySource !== "none") {
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

    // Usage is recorded before the active-turn guard: a result that arrives
    // with no open turn still describes the session's context size.
    if (message.type === "result") this.recordTurnUsage(message);

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
        if (this.liveNestedAgentTasks.length > 0 && !this.stopping) {
          // The session ended its turn while nested agents it launched are
          // still running: this "answer" describes work that has not happened
          // yet. Hold it — the user must not be replied to until the nested
          // work drains and the session reports again.
          this.holdResultForNestedAgents(turn, final);
          return;
        }
        this.clearNestedHoldTimers(turn);
        if (turn.heldFinalText !== undefined) {
          turn.heldFinalText = undefined;
          this.logBuffer.append("event", "[NESTED AGENT] released held turn on post-nested result");
          this.logger.info(
            { component: "claude-main-agent", event: "claude_result_released_after_nested_agents", sessionId: this.sessionId },
            "post-nested result released the held main turn"
          );
        }
        turn.queue.push({ type: "final", text: final });
        this.logBuffer.append("event", `[TURN END] status=success session_id=${message.session_id}`);
      } else {
        this.clearNestedHoldTimers(turn);
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

  /**
   * REPLACE semantics per the SDK contract for `background_tasks_changed`:
   * swap the whole set rather than pairing start/stop edges, so a missed
   * bookend cannot wedge a stale "still running" state.
   */
  private replaceLiveBackgroundTasks(
    tasks: ReadonlyArray<{ task_id: string; task_type: string; description: string }>
  ): void {
    const previousNestedAgentCount = this.liveNestedAgentTasks.length;
    this.liveBackgroundTasks = normalizeClaudeBackgroundTasks(tasks);
    this.liveNestedAgentTasks = this.liveBackgroundTasks.filter((task) => isClaudeNestedAgentTask(task.taskType));
    if (previousNestedAgentCount === this.liveNestedAgentTasks.length && this.liveNestedAgentTasks.length === 0) return;
    this.logBuffer.append(
      "event",
      `[BACKGROUND TASKS] nested_agents=${this.liveNestedAgentTasks.length} total=${this.liveBackgroundTasks.length}`
    );
    this.logger.info(
      {
        component: "claude-main-agent",
        event: "claude_background_tasks_changed",
        sessionId: this.sessionId,
        previousNestedAgentCount,
        nestedAgentTasks: this.liveNestedAgentTasks,
        backgroundTasks: this.liveBackgroundTasks,
        resultHeld: this.activeTurn?.heldFinalText !== undefined
      },
      "Claude main-loop background task set changed"
    );
  }

  /** Withhold a successful result until the turn's nested agents drain. */
  private holdResultForNestedAgents(turn: ActiveTurn, final: string): void {
    const firstHold = turn.heldFinalText === undefined;
    turn.heldFinalText = final;
    const count = this.liveNestedAgentTasks.length;
    this.logBuffer.append("event", `[TURN HELD] waiting on ${count} nested agent(s)`);
    this.logger.info(
      {
        component: "claude-main-agent",
        event: "claude_result_held_for_nested_agents",
        sessionId: this.sessionId,
        nestedAgentTasks: this.liveNestedAgentTasks
      },
      "held a Claude main-loop result because nested agents are still running"
    );
    turn.queue.push({
      type: "status",
      message: `waiting on ${count} nested agent${count === 1 ? "" : "s"} before replying`,
      raw: { event: "claude_result_held_for_nested_agents", nestedAgents: count }
    });
    if (!firstHold || turn.holdTimer) return;
    // Absolute bound: the service watchdog force-aborts any main turn older
    // than TURN_ABORT_MS and tells the user it timed out, so the hold has to
    // release on its own well before that.
    turn.holdTimer = setTimeout(() => {
      turn.holdTimer = undefined;
      this.releaseHeldResultOnMaxHold(turn);
    }, this.config.mainAgent.claude.nestedAgentHoldMaxMs);
    turn.holdTimer.unref?.();
  }

  private armNestedDrainTimerIfIdle(): void {
    this.clearNestedDrainTimer();
    const turn = this.activeTurn;
    if (!turn || turn.heldFinalText === undefined) return;
    if (this.stopping || this.liveNestedAgentTasks.length > 0) return;
    const generation = this.sdkActivityGeneration;
    turn.drainTimer = setTimeout(() => {
      turn.drainTimer = undefined;
      this.settleOrNudgeAfterNestedDrain(turn, generation);
    }, this.config.mainAgent.claude.nestedAgentSettleGraceMs);
    turn.drainTimer.unref?.();
  }

  private clearNestedDrainTimer(): void {
    const turn = this.activeTurn;
    if (!turn?.drainTimer) return;
    clearTimeout(turn.drainTimer);
    turn.drainTimer = undefined;
  }

  private clearNestedHoldTimers(turn: ActiveTurn): void {
    if (turn.drainTimer) clearTimeout(turn.drainTimer);
    if (turn.holdTimer) clearTimeout(turn.holdTimer);
    turn.drainTimer = undefined;
    turn.holdTimer = undefined;
  }

  /**
   * The nested agents drained while a result was held and the session then
   * stayed quiet. Ask it once for the report that accounts for the nested
   * results; if it has already been asked (or cannot be), release the held
   * text rather than leaving the user waiting.
   */
  private settleOrNudgeAfterNestedDrain(turn: ActiveTurn, generation: number): void {
    if (this.activeTurn !== turn || turn.heldFinalText === undefined) return;
    if (this.stopping || this.liveNestedAgentTasks.length > 0) return;
    if (this.sdkActivityGeneration !== generation) return;
    if (!turn.nudgeSent && this.alive && this.inputQueue) {
      turn.nudgeSent = true;
      this.logBuffer.append("event", "[NESTED AGENT] nudging quiet session for the post-nested report");
      this.logger.info(
        { component: "claude-main-agent", event: "claude_nested_agents_drained_nudge", sessionId: this.sessionId },
        "nested agents drained while a main-loop result was held; nudging the session"
      );
      void this.buildUserMessage(CLAUDE_NESTED_AGENTS_DRAINED_NUDGE, [])
        .then((nudge) => {
          if (this.activeTurn !== turn || this.stopping) return;
          this.inputQueue?.push(nudge);
        })
        .catch((error) => {
          this.logger.warn(
            {
              component: "claude-main-agent",
              event: "claude_nested_agents_drained_nudge_failed",
              error: this.redactError(error)
            },
            "failed to nudge the Claude main session after its nested agents drained"
          );
          this.releaseHeldResult(turn, "nudge failed");
        });
      return;
    }
    this.releaseHeldResult(turn, "session stayed quiet after its nested agents drained");
  }

  private releaseHeldResultOnMaxHold(turn: ActiveTurn): void {
    if (this.activeTurn !== turn || turn.heldFinalText === undefined) return;
    const count = this.liveNestedAgentTasks.length;
    this.logger.warn(
      {
        component: "claude-main-agent",
        event: "claude_nested_agent_hold_expired",
        sessionId: this.sessionId,
        nestedAgentTasks: this.liveNestedAgentTasks
      },
      "released a held Claude main-loop result at the maximum hold window"
    );
    const note =
      count > 0
        ? `\n\n_(codex-chat: ${count} nested agent${count === 1 ? " was" : "s were"} still running when this reply was sent.)_`
        : "";
    this.releaseHeldResult(turn, "maximum hold window elapsed", note);
  }

  /** End a held turn with the withheld text. */
  private releaseHeldResult(turn: ActiveTurn, reason: string, suffix = "", closeTurn = true): void {
    const held = turn.heldFinalText;
    if (held === undefined) return;
    turn.heldFinalText = undefined;
    this.clearNestedHoldTimers(turn);
    this.logBuffer.append("event", `[TURN END] status=success held_release reason=${reason}`);
    turn.queue.push({ type: "final", text: `${held}${suffix}` });
    if (!closeTurn) return;
    turn.queue.close();
    if (this.activeTurn === turn) this.activeTurn = undefined;
  }

  /**
   * Emit whatever the active turn is holding without ending it; the stop and
   * termination paths close the turn themselves (and termination still needs
   * to append its error after the held text).
   */
  private flushHeldResult(reason: string): void {
    const turn = this.activeTurn;
    if (!turn || turn.heldFinalText === undefined) return;
    this.releaseHeldResult(turn, reason, "", false);
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
      this.flushHeldResult(reason);
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

/**
 * Effective context size of the API call that produced this result: fresh
 * input plus everything served from (or written to) the prompt cache. Cached
 * tokens still occupy the context window, so they must be counted.
 *
 * `SDKResultSuccess.usage` (NonNullableUsage) is the last request's usage and
 * is the authoritative figure. `modelUsage` (Record<string, ModelUsage>) is
 * summed across every request in the turn, so it is only a fallback for older
 * shapes — the largest single model entry is the closest available proxy.
 */
function effectiveInputTokens(message: Extract<ClaudeSdkMessage, { type: "result" }>): number | undefined {
  const record = message as unknown as Record<string, unknown>;
  const usage = record.usage as Record<string, unknown> | undefined;
  const fromUsage =
    numberOrZero(usage?.input_tokens) +
    numberOrZero(usage?.cache_read_input_tokens) +
    numberOrZero(usage?.cache_creation_input_tokens);
  if (fromUsage > 0) return fromUsage;

  const modelUsage = record.modelUsage as Record<string, Record<string, unknown>> | undefined;
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let largest = 0;
  for (const entry of Object.values(modelUsage)) {
    if (!entry || typeof entry !== "object") continue;
    const total =
      numberOrZero(entry.inputTokens) +
      numberOrZero(entry.cacheReadInputTokens) +
      numberOrZero(entry.cacheCreationInputTokens);
    if (total > largest) largest = total;
  }
  return largest > 0 ? largest : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
