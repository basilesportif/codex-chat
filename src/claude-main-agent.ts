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
  withTimeout,
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
import {
  DEFAULT_HANDOFF_SUMMARY_TIMEOUT_MS,
  generateHandoffSummary,
  type HandoffSummaryResult
} from "./claude-main-handoff.js";
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
  MainAgentTurnInput,
  MainAgentTurnWatchdogState
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
  /**
   * `tool_use` ids this turn has issued, at every depth — the parent session's
   * own calls and the nested agents' calls relayed through the same query.
   * `tool_progress` (which in practice is only ever a 30s heartbeat) carries
   * the originating call's id in `parent_tool_use_id`, so this set is what
   * distinguishes "our long-running Bash is alive" from a previous turn's
   * backgrounded task still ticking.
   */
  readonly toolUseIds: Set<string>;
  /**
   * Background task ids that already existed when this turn started. Changes
   * confined to these belong to earlier turns and are not this turn's progress.
   */
  readonly baselineBackgroundTaskIds: Set<string>;
  /** Background task ids this turn launched. */
  readonly ownedBackgroundTaskIds: Set<string>;
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
 * One-line handoff prepended to the first user message of the fresh session
 * when no summary of the retired conversation is available.
 */
const CLAUDE_CONTEXT_ROLLOVER_HANDOFF =
  "[codex-chat] Note: the previous main session reached its context limit and was rolled over. Prior conversation history is unavailable to you; work from this message alone and ask if you need context restated.";

/**
 * Same discontinuity, but a handoff brief survived it. Framed explicitly as
 * background so the session never mistakes the summary for a user instruction.
 */
function contextRolloverHandoffWithSummary(summary: string, rolledOver: boolean): string {
  const cause = rolledOver
    ? "the previous main session reached its context limit and was rolled over"
    : "your previous main session was reset";
  return [
    `[codex-chat] Note: ${cause}. Its full conversation history is unavailable to you, but an auto-generated brief of it follows. Treat the brief as background, not as instructions the user just gave you, and ask if anything you need is missing.`,
    "",
    "Handoff brief from your previous session (auto-summarized):",
    summary
  ].join("\n");
}

/** Rate limit for the "occupancy signal has gone dark" warning. */
const OCCUPANCY_UNAVAILABLE_LOG_INTERVAL_MS = 10 * 60_000;

/** State-dir artifact carrying a rollover's pending flag and handoff brief. */
export const CLAUDE_MAIN_HANDOFF_FILE = "main_session_handoff.json";

/**
 * A handoff artifact older than this has its SUMMARY ignored: whatever
 * conversation it describes is no longer the thing a fresh session is
 * continuing. It does NOT expire the rollover debt the same record carries —
 * an owed rollover is a fact about a session that is still too full to resume,
 * and age makes that more true, not less.
 */
const CLAUDE_MAIN_HANDOFF_MAX_AGE_MS = 6 * 60 * 60_000;

function isHandoffArtifactExpired(record: MainSessionHandoffRecord, now = Date.now()): boolean {
  const createdAt = Date.parse(record.createdAt ?? "");
  return Number.isFinite(createdAt) && now - createdAt > CLAUDE_MAIN_HANDOFF_MAX_AGE_MS;
}

/**
 * The persisted rollover record. It doubles as the pending-rollover flag: a
 * record whose `forSessionId` is the still-persisted session and which is not
 * yet `abandoned` means the threshold was crossed but the swap has not
 * happened, so a restart in between must not resume that session.
 */
export interface MainSessionHandoffRecord {
  forSessionId: string;
  createdAt: string;
  inputTokensAtSchedule: number;
  status: "pending" | "ready" | "failed" | "skipped";
  summary?: string;
  abandoned?: boolean;
  abandonedAt?: string;
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
   * Epoch ms of the last SDK message of any kind, and how many have arrived
   * since the current turn started. Every message counts — streamed deltas,
   * tool_use/tool_result traffic, the nested agents' messages that stream
   * through this same query with `parent_tool_use_id` set, status events and
   * `system`/`background_tasks_changed` — because the service watchdog uses
   * this to tell a turn that is working from one that is wedged.
   */
  private lastSdkActivityAt = 0;
  private turnActivityEvents = 0;
  /**
   * Set while this client is doing bounded work that legitimately produces no
   * SDK messages at all — the inline session restart a context rollover does
   * inside `sendTurn`, which may take up to `startupTimeoutSec` (90s) and so
   * outlives the watchdog's inactivity budget on its own.
   *
   * The suspension carries its OWN expiry rather than relying on the code that
   * set it to clear it. Everything it covers is a teardown/startup path that
   * can itself hang (an `interrupt()` against a wedged child is the obvious
   * one), and a suspension that leaked would disable the inactivity deadline
   * permanently — the watchdog would be left with only the absolute ceiling,
   * which never clears a session, so nothing would ever recover.
   */
  private watchdogSuspendedReason?: string;
  private watchdogSuspendedUntil = 0;
  /**
   * How full the session's context window is, measured from the LAST single
   * API request of the last completed turn. See `effectiveInputTokens`: the
   * result message's `usage` is cumulative across every request in the turn,
   * so it is not an occupancy figure at all.
   */
  private lastTurnInputTokens?: number;
  /** Occupancy of the most recent main-session (non-subagent) API request. */
  private lastMainRequestInputTokens?: number;
  /** Context window the serving model reported, for logging and stats. */
  private contextWindowTokens?: number;
  /** Rate limiter for the "no occupancy signal at all" warning. */
  private occupancyUnavailableLoggedAt = 0;
  /**
   * Set when a completed turn crossed `contextRolloverInputTokens`. Acted on at
   * the NEXT turn boundary — never mid-turn — so no in-flight work is lost.
   */
  private pendingContextRollover?: { inputTokens: number };
  /**
   * Session id whose handoff brief the NEXT first turn on this fresh session
   * should consume. Set by the rollover path, by a watchdog clear, and by
   * `start()` when a persisted artifact says the session it names was (or must
   * be) abandoned. Cleared after one attempt — a handoff is never retried.
   */
  private pendingHandoffSourceSessionId?: string;
  /** At most one summarization job in flight; a newer schedule supersedes. */
  private handoffSummaryInFlight = false;
  /** Session the in-flight summarization job belongs to. */
  private handoffSummaryFor?: string;
  /**
   * The most recent handoff-artifact write. `scheduleHandoffSummary` runs from
   * a synchronous SDK message handler and so cannot await its own write; the
   * turn boundary awaits this instead, which is what makes the persisted
   * pending-rollover marker observable before the next turn acts on it.
   */
  private handoffArtifactWrite: Promise<void> = Promise.resolve();
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

      const [bootstrap, behaviorHash, storedSessionId, storedBehaviorHash, storedInputTokens] = await Promise.all([
        this.behavior.loadBootstrapPrompt(),
        this.behavior.hash(),
        this.state.getCodexSession(cfg.mainSessionName),
        this.state.getCodexSessionBehaviorHash(cfg.mainSessionName),
        this.state.getCodexSessionInputTokens?.(cfg.mainSessionName)
      ]);
      this.currentBehaviorHash = behaviorHash;
      this.sessionId = storedSessionId;
      // A resumed session arrives as full as it was left. Seeding occupancy
      // means the rollover threshold and the watchdog's wedge evidence both
      // work from the first turn after a restart rather than after one.
      if (storedSessionId && storedInputTokens !== undefined) {
        this.lastTurnInputTokens = storedInputTokens;
        this.lastMainRequestInputTokens = storedInputTokens;
      }

      // The handoff artifact is also the persisted pending-rollover flag, so
      // it is consulted BEFORE deciding whether to resume: a threshold that
      // was crossed before a restart must still cost the session, not be
      // forgotten because the flag only lived in memory.
      const resumeBlocked = await this.evaluateStartupHandoff(storedSessionId);
      if (resumeBlocked) this.sessionId = undefined;

      let resumed = false;
      if (storedSessionId && !resumeBlocked) {
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
    // Fresh inactivity budget for the new turn: the watchdog treats an
    // activity count of zero as "this turn never produced a single event".
    this.turnActivityEvents = 0;
    this.lastSdkActivityAt = Date.now();
    // Turn boundary: the only safe place to swap the underlying session.
    const rolledOver = await this.rolloverContextIfPending();
    if (!this.alive || !this.query || !this.inputQueue) {
      throw new Error("Claude Agent SDK main session is closed or uninitialized.");
    }

    // Never waits on summarization: whatever is already on disk is used, and
    // anything still generating is simply skipped.
    const summary = await this.consumeHandoffSummary(Boolean(rolledOver));

    const turn: ActiveTurn = {
      queue: new AsyncEventQueue<MainAgentEvent>(),
      assistantText: "",
      partialText: "",
      toolUseIds: new Set<string>(),
      baselineBackgroundTaskIds: new Set(this.liveBackgroundTasks.map((task) => task.taskId)),
      ownedBackgroundTaskIds: new Set<string>(),
      nudgeSent: false
    };
    this.activeTurn = turn;
    this.logBuffer.append("event", `[TURN START] session_id=${this.sessionId ?? "?"}`);
    try {
      if (rolledOver) {
        turn.queue.push({
          type: "status",
          message: summary
            ? "main session context rolled over; a summary of the prior conversation was carried over"
            : "main session context rolled over; conversation history was reset",
          raw: {
            event: CLAUDE_CONTEXT_ROLLOVER_EVENT,
            previousSessionId: rolledOver.previousSessionId,
            previousTurnInputTokens: rolledOver.inputTokens,
            thresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens,
            handoffSummary: Boolean(summary)
          }
        });
      }
      const prefix = summary
        ? contextRolloverHandoffWithSummary(summary, Boolean(rolledOver))
        : rolledOver
          ? CLAUDE_CONTEXT_ROLLOVER_HANDOFF
          : undefined;
      const text = prefix ? `${prefix}\n\n${input.text}` : input.text;
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
    const abandoned = this.sessionId;
    await this.state.clearCodexSession(this.config.mainAgent.claude.mainSessionName);
    // The session just went away (watchdog abort, rollover, manual reset), so
    // any handoff artifact describing it is now owed to the NEXT fresh session.
    if (abandoned && (await this.markHandoffAbandoned(abandoned))) {
      this.pendingHandoffSourceSessionId = abandoned;
    }
    this.sessionId = undefined;
    this.lastTurnInputTokens = undefined;
    this.lastMainRequestInputTokens = undefined;
    this.pendingContextRollover = undefined;
    this.logBuffer.append("event", `[SESSION] cleared persisted session reason=${reason}`);
  }

  contextStats(): MainAgentContextStats {
    return {
      sessionId: this.sessionId,
      lastTurnInputTokens: this.lastTurnInputTokens,
      rolloverThresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens,
      rolloverPending: this.pendingContextRollover !== undefined,
      contextWindowTokens: this.contextWindowTokens
    };
  }

  /**
   * Liveness of the turn in flight, for the service watchdog. `lastActivityAt`
   * is bumped by every SDK message, so a turn that is doing tool work or
   * running nested agents reads as active even though it has emitted no
   * user-visible output for minutes.
   */
  turnWatchdogState(): MainAgentTurnWatchdogState {
    const suspended = this.watchdogSuspendedReason !== undefined && Date.now() < this.watchdogSuspendedUntil;
    return {
      lastActivityAt: this.lastSdkActivityAt || undefined,
      activityEvents: this.turnActivityEvents,
      suspended,
      suspendedReason: suspended ? this.watchdogSuspendedReason : undefined
    };
  }

  /**
   * Pause the watchdog's inactivity deadline for at most `maxMs`, whatever
   * happens to the work it covers. The expiry is the point: the caller's
   * `finally` cannot be trusted to run when the thing being awaited is a
   * potentially-hanging child process operation.
   */
  private suspendWatchdog(reason: string, maxMs: number): void {
    this.watchdogSuspendedReason = reason;
    this.watchdogSuspendedUntil = Date.now() + maxMs;
  }

  private resumeWatchdog(): void {
    this.watchdogSuspendedReason = undefined;
    this.watchdogSuspendedUntil = 0;
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
    // The marker was written from a synchronous message handler that could not
    // await it. Land it before anything reads or acts on it.
    await this.flushHandoffArtifactWrite();
    if (await this.deferRolloverForHandoffSummary(pending.inputTokens)) return undefined;
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
    // stop()/start() emits no SDK messages and may take up to startupTimeoutSec
    // (90s), which is longer than the watchdog's inactivity budget. Suspend the
    // deadline across it rather than letting the watchdog shoot a rollover
    // mid-startup; the absolute ceiling still bounds the turn. The suspension
    // expires on its own (teardown + startup, doubled) so a hang below cannot
    // strand the watchdog even though the `finally` would never run.
    const cfg = this.config.mainAgent.claude;
    this.suspendWatchdog(
      "context_rollover_restart",
      (cfg.interruptTimeoutSec + cfg.startupTimeoutSec) * 2_000
    );
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
    } finally {
      this.resumeWatchdog();
      this.lastSdkActivityAt = Date.now();
    }
    return { inputTokens: pending.inputTokens, previousSessionId };
  }

  /**
   * Hold an armed rollover while its handoff summary is still generating.
   *
   * During an active conversation the next turn boundary arrives seconds after
   * the threshold crossing, long before a ~30-60s summarization finishes, so
   * swapping sessions immediately would throw the brief away in exactly the
   * case where continuity matters most. Waiting at the boundary is never an
   * option; skipping the swap for a turn or two is — the threshold leaves
   * ~100k tokens of slack below `contextRolloverHardCapTokens`, past which the
   * session is swapped regardless. No artifact at all (summaries disabled,
   * state dir unwritable) means nothing to wait for: roll over now.
   */
  private async deferRolloverForHandoffSummary(scheduledInputTokens: number): Promise<boolean> {
    const cfg = this.config.mainAgent.claude;
    const record = await this.readHandoffArtifact();
    const artifactPending = record?.forSessionId === this.sessionId && record?.status === "pending";
    // In-memory truth wins over the artifact: the job is unambiguously running
    // here, whereas a `pending` record only means nothing has overwritten it.
    const summaryRunning = this.handoffSummaryInFlight && this.handoffSummaryFor === this.sessionId;
    if (!artifactPending && !summaryRunning) return false;
    const inputTokens = Math.max(this.lastTurnInputTokens ?? 0, scheduledInputTokens);
    if (inputTokens >= cfg.contextRolloverHardCapTokens) return false;
    this.logger.info(
      {
        component: "claude-main-agent",
        event: "context_rollover_deferred",
        sessionId: this.sessionId,
        inputTokens,
        thresholdTokens: cfg.contextRolloverInputTokens,
        hardCapTokens: cfg.contextRolloverHardCapTokens,
        artifactStatus: record?.status,
        summaryRunning
      },
      "holding the Claude main-session rollover until its handoff summary resolves"
    );
    this.logBuffer.append("event", `[SESSION] rollover deferred for handoff summary input_tokens=${inputTokens}`);
    return true;
  }

  /**
   * Record how full the session's context is from a completed turn's usage and
   * arm a rollover once it crosses the configured threshold.
   */
  private recordTurnUsage(message: Extract<ClaudeSdkMessage, { type: "result" }>): void {
    this.contextWindowTokens = reportedContextWindow(message) ?? this.contextWindowTokens;
    const inputTokens = effectiveInputTokens(message, this.lastMainRequestInputTokens);
    if (inputTokens === undefined) {
      // Both signals gone. This is not cosmetic: with no occupancy figure the
      // rollover never arms AND the watchdog loses its wedge evidence, so the
      // session grows unbounded and aborts stop being able to recover it.
      // Rate-limited because a broken shape would repeat every single turn.
      this.reportOccupancyUnavailable();
      return;
    }
    this.occupancyUnavailableLoggedAt = 0;
    this.persistOccupancy(inputTokens);
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
    this.scheduleHandoffSummary(this.sessionId, inputTokens);
  }

  /**
   * Persist the rollover record and summarize the doomed conversation OUT of
   * band. Deliberately fire-and-forget: user turns must never wait on this,
   * and the summarizer must never run against the near-full main session.
   *
   * Ordering matters twice over. The record doubles as the persisted
   * pending-rollover flag, so it is written FIRST and unconditionally —
   * skipping the write because summarization is off, or because another
   * summarizer is still running, used to leave a restart in that window free
   * to resume a session that was already owed a rollover. And the write is
   * kicked off synchronously (its promise parked on `handoffArtifactWrite`)
   * because the next turn boundary can arrive before any await here resolves;
   * that boundary awaits the promise instead of racing the file.
   */
  private scheduleHandoffSummary(sessionId: string | undefined, inputTokens: number): void {
    const cfg = this.config.mainAgent.claude;
    if (!sessionId) return;
    const startedAt = Date.now();
    // "pending" means a summarizer is being started for this record right now,
    // and is what makes the next boundary wait for the brief. Anything else is
    // marked terminal so nothing ever waits on a summary that will not come.
    const willSummarize = cfg.handoffSummaryEnabled && !this.handoffSummaryInFlight;
    const record: MainSessionHandoffRecord = {
      forSessionId: sessionId,
      createdAt: nowIso(),
      inputTokensAtSchedule: inputTokens,
      status: willSummarize ? "pending" : "skipped"
    };
    this.handoffArtifactWrite = this.writeHandoffArtifact(record).catch((error) => {
      this.logger.warn(
        { component: "claude-main-agent", event: "handoff_write_failed", forSessionId: sessionId, error: this.redactError(error) },
        "failed to persist the Claude main-session rollover marker"
      );
    });
    if (!willSummarize) {
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_summary_skipped",
          sessionId,
          inputTokens,
          reason: cfg.handoffSummaryEnabled ? "summary_already_in_flight" : "disabled"
        },
        "wrote the rollover marker without scheduling a handoff summary"
      );
      return;
    }
    this.handoffSummaryInFlight = true;
    this.handoffSummaryFor = sessionId;
    void (async () => {
      try {
        await this.handoffArtifactWrite;
        this.logger.info(
          {
            component: "claude-main-agent",
            event: "handoff_summary_started",
            sessionId,
            inputTokens,
            model: cfg.handoffSummaryModel
          },
          "summarizing the Claude main session before it is rolled over"
        );
        const result: HandoffSummaryResult = await generateHandoffSummary({
          config: this.config,
          sessionId,
          safeEnv: this.safeEnv,
          model: cfg.handoffSummaryModel,
          timeoutMs: DEFAULT_HANDOFF_SUMMARY_TIMEOUT_MS
        });
        const stored = await this.patchHandoffArtifact(sessionId, {
          status: "ready",
          summary: result.summary
        });
        this.logger.info(
          {
            component: "claude-main-agent",
            event: "handoff_summary_ready",
            sessionId,
            stored,
            summaryChars: result.summary.length,
            transcriptChars: result.transcriptChars,
            transcriptMessages: result.transcriptMessages,
            transcriptBytes: result.transcriptBytes,
            durationMs: Date.now() - startedAt
          },
          "generated a handoff brief for the Claude main session being rolled over"
        );
        this.logBuffer.append("event", `[HANDOFF] summary ready chars=${result.summary.length}`);
      } catch (error) {
        await this.patchHandoffArtifact(sessionId, { status: "failed" }).catch(() => false);
        this.logger.warn(
          {
            component: "claude-main-agent",
            event: "handoff_summary_failed",
            sessionId,
            durationMs: Date.now() - startedAt,
            error: this.redactError(error)
          },
          "failed to summarize the Claude main session before rollover; the fresh session will get the plain handoff note"
        );
        this.logBuffer.append("event", "[HANDOFF] summary failed");
      } finally {
        this.handoffSummaryInFlight = false;
        if (this.handoffSummaryFor === sessionId) this.handoffSummaryFor = undefined;
      }
    })();
  }

  /**
   * Carry occupancy across restarts alongside the session id it describes.
   * Fire-and-forget: a failed write costs post-restart wedge evidence, which
   * is not worth failing or delaying a turn for.
   */
  private persistOccupancy(inputTokens: number): void {
    const sessionId = this.sessionId;
    if (!sessionId) return;
    void this.state
      .setCodexSession(this.config.mainAgent.claude.mainSessionName, { sessionId, lastInputTokens: inputTokens })
      .catch((error) => {
        this.logger.debug?.(
          { component: "claude-main-agent", event: "occupancy_persist_failed", error: this.redactError(error) },
          "failed to persist Claude main-session context occupancy"
        );
      });
  }

  private reportOccupancyUnavailable(): void {
    const now = Date.now();
    if (now - this.occupancyUnavailableLoggedAt < OCCUPANCY_UNAVAILABLE_LOG_INTERVAL_MS) return;
    this.occupancyUnavailableLoggedAt = now;
    this.logger.warn(
      {
        component: "claude-main-agent",
        event: "context_occupancy_unavailable",
        sessionId: this.sessionId,
        thresholdTokens: this.config.mainAgent.claude.contextRolloverInputTokens
      },
      "a completed turn carried no per-request usage; context rollover and watchdog wedge evidence are both blind until it returns"
    );
    this.logBuffer.append("event", "[USAGE] no per-request occupancy signal available");
  }

  /** Let any in-flight handoff-artifact write land before reading it. */
  private async flushHandoffArtifactWrite(): Promise<void> {
    await this.handoffArtifactWrite.catch(() => undefined);
  }

  /**
   * Startup half of the rollover/handoff contract. Returns true when the
   * persisted session must NOT be resumed because a rollover was already owed
   * to it when the process last stopped.
   */
  private async evaluateStartupHandoff(storedSessionId?: string): Promise<boolean> {
    // Read past the age bound here. The record carries two independent things:
    // a brief (which does go stale) and a rollover DEBT (which does not). If a
    // process is down for more than six hours with a rollover owed, the
    // session it names is still too full to resume — expiring the debt with
    // the brief resumed it straight back into the wedge.
    let record = await this.readRawHandoffArtifact();
    if (!record) return false;
    const expired = isHandoffArtifactExpired(record);
    if (expired && !(storedSessionId && record.forSessionId === storedSessionId && !record.abandoned)) {
      // Stale and owed to nobody: nothing to carry, nothing to enforce.
      return false;
    }
    if (expired) {
      this.logger.warn(
        {
          component: "claude-main-agent",
          event: "handoff_expired_rollover_forced",
          sessionId: storedSessionId,
          createdAt: record.createdAt,
          inputTokensAtSchedule: record.inputTokensAtSchedule
        },
        "the rollover owed to the persisted Claude main session outlived its handoff brief; starting fresh without one"
      );
      // Drop the summary so the fresh session is never handed a stale brief,
      // but keep the debt so the branch below still refuses the resume.
      record = { ...record, status: "failed", summary: undefined };
      await this.patchHandoffArtifact(record.forSessionId, { status: "failed", summary: undefined });
    }
    // A "pending" record with no summarizer behind it is orphaned — the
    // process that owned the job is gone. Mark it terminal so the consume path
    // stops waiting for a brief that will never arrive. Never do this while a
    // job really is running (the rollover restart calls start() mid-job).
    if (record.status === "pending" && !this.handoffSummaryInFlight) {
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_summary_orphaned",
          forSessionId: record.forSessionId,
          createdAt: record.createdAt
        },
        "handoff summary was still pending when the process last stopped; marking it failed"
      );
      await this.patchHandoffArtifact(record.forSessionId, { status: "failed" });
      record = { ...record, status: "failed" };
    }
    if (storedSessionId && record.forSessionId === storedSessionId && !record.abandoned) {
      this.logger.warn(
        {
          component: "claude-main-agent",
          event: "context_rollover_restart_fresh",
          sessionId: storedSessionId,
          inputTokens: record.inputTokensAtSchedule
        },
        "a context rollover was owed to the persisted Claude main session; starting fresh instead of resuming"
      );
      this.logBuffer.append("event", `[SESSION] rollover owed to ${storedSessionId}; starting fresh`);
      await this.markHandoffAbandoned(storedSessionId);
      await this.state.clearCodexSession(this.config.mainAgent.claude.mainSessionName);
      this.pendingContextRollover = undefined;
      this.pendingHandoffSourceSessionId = storedSessionId;
      return true;
    }
    // Nothing is being resumed and the artifact describes an already-abandoned
    // session (rollover or watchdog clear that a restart interrupted): the
    // fresh session's first turn should still receive its brief.
    if (!storedSessionId && record.abandoned) {
      this.pendingHandoffSourceSessionId = record.forSessionId;
    }
    return false;
  }

  /**
   * Take the handoff brief owed to this fresh session, if one is ready. Reads
   * only what is already persisted — a summary still generating is never
   * awaited — and invalidates the artifact once it has been resolved, so a
   * consumed or dead brief can never be replayed into a later session.
   *
   * A brief that is still `pending` is LEFT ALONE and stays owed to a later
   * turn. Discarding it here (which is what clearing the artifact before
   * checking its status did) threw away briefs that finished seconds later:
   * on 2026-08-17 the boundary skipped an unready summary at 17:05:02, the
   * summarizer completed at 17:05:19, and its write found nothing to patch.
   * The age bound in `readHandoffArtifact` is what stops an orphaned pending
   * record from being retried forever.
   */
  private async consumeHandoffSummary(rolledOver: boolean): Promise<string | undefined> {
    const source = this.pendingHandoffSourceSessionId;
    if (!source) return undefined;
    this.pendingHandoffSourceSessionId = undefined;
    await this.flushHandoffArtifactWrite();
    const raw = await this.readRawHandoffArtifact();
    // Expired but ours: the debt it carried has already been enforced at
    // startup, and the brief is too old to hand on. Retire the file rather
    // than leaving an inert record behind.
    if (raw?.forSessionId === source && isHandoffArtifactExpired(raw)) {
      await this.clearHandoffArtifact();
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_skipped_stale",
          expectedSessionId: source,
          artifactSessionId: raw.forSessionId,
          expired: true,
          rolledOver
        },
        "the handoff brief for the abandoned Claude main session had expired; using the plain note"
      );
      return undefined;
    }
    const record = await this.readHandoffArtifact();
    if (record?.forSessionId === source && record.status === "pending") {
      // Still generating (or a fresh process that has not yet reconciled it):
      // keep the debt, keep the artifact, and try again at a later boundary.
      this.pendingHandoffSourceSessionId = source;
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_deferred_unready",
          previousSessionId: source,
          sessionId: this.sessionId,
          rolledOver
        },
        "handoff brief is still generating; keeping it owed to a later turn rather than discarding it"
      );
      return undefined;
    }
    if (!record || record.forSessionId !== source) {
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_skipped_stale",
          expectedSessionId: source,
          artifactSessionId: record?.forSessionId,
          rolledOver
        },
        "no handoff brief matching the abandoned Claude main session; using the plain note"
      );
      return undefined;
    }
    await this.clearHandoffArtifact();
    if (record.status !== "ready" || !record.summary) {
      this.logger.info(
        {
          component: "claude-main-agent",
          event: "handoff_skipped_unready",
          previousSessionId: source,
          status: record.status,
          rolledOver
        },
        "handoff brief was not ready at the turn boundary; using the plain note"
      );
      return undefined;
    }
    this.logger.info(
      {
        component: "claude-main-agent",
        event: "handoff_consumed",
        previousSessionId: source,
        sessionId: this.sessionId,
        summaryChars: record.summary.length,
        rolledOver
      },
      "carried a handoff brief from the retired Claude main session into the fresh one"
    );
    this.logBuffer.append("event", `[HANDOFF] consumed brief chars=${record.summary.length}`);
    return record.summary;
  }

  /**
   * The artifact with the age bound applied — i.e. the one whose SUMMARY is
   * still worth carrying. Use `readRawHandoffArtifact` for the rollover debt,
   * which never expires.
   */
  private async readHandoffArtifact(): Promise<MainSessionHandoffRecord | undefined> {
    const record = await this.readRawHandoffArtifact();
    if (!record) return undefined;
    return isHandoffArtifactExpired(record) ? undefined : record;
  }

  /** The artifact exactly as stored, age bound NOT applied. */
  private async readRawHandoffArtifact(): Promise<MainSessionHandoffRecord | undefined> {
    try {
      const record = await this.state.readJson<MainSessionHandoffRecord | null>(CLAUDE_MAIN_HANDOFF_FILE, null);
      if (!record || typeof record !== "object" || typeof record.forSessionId !== "string") return undefined;
      return record;
    } catch (error) {
      this.logger.warn(
        { component: "claude-main-agent", event: "handoff_read_failed", error: this.redactError(error) },
        "failed to read the Claude main-session handoff artifact"
      );
      return undefined;
    }
  }

  private async writeHandoffArtifact(record: MainSessionHandoffRecord): Promise<void> {
    await this.state.writeJson(CLAUDE_MAIN_HANDOFF_FILE, record);
  }

  /** Merge into the artifact only while it still describes `forSessionId`. */
  private async patchHandoffArtifact(
    forSessionId: string,
    patch: Partial<MainSessionHandoffRecord>
  ): Promise<boolean> {
    let applied = false;
    try {
      await this.state.updateJson<MainSessionHandoffRecord | null>(CLAUDE_MAIN_HANDOFF_FILE, null, (current) => {
        if (!current || current.forSessionId !== forSessionId) return undefined;
        applied = true;
        return { ...current, ...patch };
      });
    } catch (error) {
      this.logger.warn(
        { component: "claude-main-agent", event: "handoff_write_failed", forSessionId, error: this.redactError(error) },
        "failed to update the Claude main-session handoff artifact"
      );
      return false;
    }
    return applied;
  }

  private async markHandoffAbandoned(forSessionId: string): Promise<boolean> {
    return this.patchHandoffArtifact(forSessionId, { abandoned: true, abandonedAt: nowIso() });
  }

  private async clearHandoffArtifact(): Promise<void> {
    try {
      await this.state.writeJson(CLAUDE_MAIN_HANDOFF_FILE, null);
    } catch (error) {
      this.logger.warn(
        { component: "claude-main-agent", event: "handoff_clear_failed", error: this.redactError(error) },
        "failed to invalidate the Claude main-session handoff artifact"
      );
    }
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
    // Same signal, different consumer: the service watchdog aborts on silence,
    // so anything the session emits — including a nested agent's tool traffic
    // relayed through this query — resets its inactivity budget.
    //
    // Scoped to an open turn, and within that to traffic ATTRIBUTABLE to it.
    // The SDK's message stream is SESSION-scoped: `background_tasks_changed`
    // fires for a dev server some earlier turn backgrounded, and
    // `tool_progress` keeps ticking for whatever is running. Counting
    // unattributable traffic would let a chatty leftover hold the inactivity
    // budget open while the conversation itself is wedged — the precise
    // failure this watchdog exists to catch — leaving only the 30-minute
    // ceiling, i.e. an endless half-hour abort loop.
    const turn = this.activeTurn;
    if (turn) {
      this.registerTurnToolUses(turn, message);
      if (this.countsAsTurnActivity(turn, message)) {
        this.lastSdkActivityAt = Date.now();
        this.turnActivityEvents += 1;
      }
    }
    this.clearNestedDrainTimer();
    try {
      this.routeSdkMessage(message);
    } finally {
      this.armNestedDrainTimerIfIdle();
    }
  }

  /**
   * Record every `tool_use` this turn issues, at any depth. Nested agents'
   * assistant messages arrive on the same query with `parent_tool_use_id` set,
   * and their tool calls are still work this turn is waiting on, so their ids
   * belong in the same set — otherwise a nested agent running one long silent
   * Bash would look like a stalled turn.
   */
  private registerTurnToolUses(turn: ActiveTurn, message: ClaudeSdkMessage): void {
    if (message.type !== "assistant") return;
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as unknown as Record<string, unknown>;
      if (record.type === "tool_use" && typeof record.id === "string") turn.toolUseIds.add(record.id);
    }
  }

  /**
   * Whether an SDK message is evidence that THIS turn is progressing.
   *
   * Almost everything is: any message at all proves the CLI child is not
   * blocked (the 2026-08-07 wedge produced literally nothing). Two message
   * types are session-scoped rather than turn-scoped and need attributing:
   *
   * - `tool_progress`. In production this is ONLY ever a 30-second heartbeat:
   *   all 15 such messages captured in this repo's `data/subagents/` streams
   *   carry `heartbeat: true`, and none carries a null `parent_tool_use_id`.
   *   Excluding heartbeats outright therefore does not exclude "noise", it
   *   makes every tool call longer than the inactivity budget unfinishable —
   *   job_46baa638's single Bash ran 119.8s emitting nothing but heartbeats
   *   and would have been aborted ~40s from the finish line. So a heartbeat
   *   IS activity, provided it belongs to a call this turn made.
   * - `background_tasks_changed`. Attributable only when the change involves a
   *   task this turn launched; a previous turn's task starting or stopping is
   *   not this turn's progress.
   */
  private countsAsTurnActivity(turn: ActiveTurn, message: ClaudeSdkMessage): boolean {
    if (message.type === "tool_progress") {
      const originating = message.parent_tool_use_id;
      return typeof originating === "string" && turn.toolUseIds.has(originating);
    }
    if (message.type === "system" && message.subtype === "background_tasks_changed") {
      const incoming = normalizeClaudeBackgroundTasks(message.tasks ?? []);
      let attributable = false;
      for (const task of incoming) {
        if (turn.baselineBackgroundTaskIds.has(task.taskId)) continue;
        turn.ownedBackgroundTaskIds.add(task.taskId);
        attributable = true;
      }
      if (attributable) return true;
      // A task this turn launched disappearing is this turn's progress too.
      const liveIds = new Set(incoming.map((task) => task.taskId));
      for (const owned of turn.ownedBackgroundTaskIds) {
        if (!liveIds.has(owned)) return true;
      }
      return false;
    }
    return true;
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
      if (previousSessionId !== message.session_id) {
        // Occupancy belongs to a conversation, not to the client: a different
        // session id means the old figure describes something that is gone.
        this.lastMainRequestInputTokens = undefined;
        this.lastTurnInputTokens = undefined;
      }
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

    // Context occupancy is read off individual assistant messages, before the
    // active-turn guard. Each one carries the usage of the ONE API request that
    // produced it, which is the only per-request figure the stream offers; the
    // result message's `usage` is summed over the whole turn. Subagent messages
    // (`parent_tool_use_id` set) describe a different conversation entirely and
    // must never be mistaken for this session's occupancy.
    //
    // Last write wins, deliberately NOT a running maximum. Occupancy is not
    // monotonic: SDK-side auto-compaction can shrink a session's context in
    // place, and a ratcheted high-water mark would then read as "near full"
    // forever — arming rollovers on an empty session and, worse, making every
    // watchdog abort look like wedge evidence and destroy a healthy session.
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      const occupancy = assistantRequestInputTokens(message);
      if (occupancy !== undefined) this.lastMainRequestInputTokens = occupancy;
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
    // Absolute bound. The service watchdog aborts on SILENCE, and a hold is not
    // silent while the nested agents work — their tool traffic streams through
    // this query and resets the budget. The only quiet stretch is the
    // post-drain settle/nudge window, so this cap simply has to stay under
    // `service.turnInactivityAbortMs` (55s against 80s) to guarantee the hold
    // always releases itself rather than being killed.
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
        // Bounded on purpose. `interrupt()` is a round trip to the CLI child,
        // and the single case that most needs interrupting — a child wedged on
        // a near-full session — is also the one most likely never to answer.
        // An unbounded await here hangs stop(), and with it the rollover,
        // provider switches and shutdown.
        const interruptTimeoutMs = this.config.mainAgent.claude.interruptTimeoutSec * 1000;
        await withTimeout(
          query.interrupt(),
          interruptTimeoutMs,
          `Claude Agent SDK interrupt did not complete within ${interruptTimeoutMs}ms`
        );
      } catch (error) {
        this.logger.warn(
          { component: "claude-main-agent", event: "interrupt_failed", error: this.redactError(error) },
          "Claude Agent SDK interrupt failed or timed out; closing query"
        );
      }
    }
    query.close();
  }

  private async persistSession(sessionId: string, behaviorHash = this.currentBehaviorHash): Promise<void> {
    if (!behaviorHash) throw new Error("Cannot persist Claude Agent SDK session before behavior hash is available.");
    const cfg = this.config.mainAgent.claude;
    const record: Record<string, unknown> = {
      sessionId,
      provider: "claude_agent_sdk",
      transport: "claude-agent-sdk",
      model: cfg.model,
      behaviorHash
    };
    // `setCodexSession` MERGES, so a persisted occupancy figure outlives the
    // session id it was measured against unless it is explicitly dropped.
    // Pairing a new id with the old session's tokens is actively dangerous: a
    // restart before the new session completes a turn would re-seed a false
    // "≥ threshold" occupancy, arming a bogus rollover and handing the
    // watchdog fabricated wedge evidence against a healthy conversation.
    const storedSessionId = await this.state.getCodexSession(cfg.mainSessionName);
    if (storedSessionId !== sessionId) record.lastInputTokens = undefined;
    await this.state.setCodexSession(cfg.mainSessionName, record);
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
 * How full the session's context window is after this turn.
 *
 * The prompt size of ONE API request is `input_tokens + cache_read + cache_
 * creation` — cached tokens still occupy the window, so they must be counted.
 * The trap is that a result message's `usage` is not one request: the SDK sums
 * it over every request the agentic loop made for the turn. Verified against
 * SDK 0.3.220 on 2026-08-17 with a four-request turn:
 *
 *   per request  1632, 1710, 1788, 1866   (real occupancy: 1866)
 *   result.usage 8 + 5124 + 1864 = 6996   (the sum of all four)
 *
 * `modelUsage` is the same sum keyed by model, so it is no better. Reading
 * `usage` as occupancy therefore overstates it by roughly the number of tool
 * round-trips — which is how a 1M-token window produced "2,050,378 effective
 * input tokens" in production and armed rollovers against sessions that were
 * nowhere near full.
 *
 * Preference order, most to least direct:
 *  1. `mainRequestInputTokens` — tracked from the parent session's own
 *     assistant messages, each of which carries exactly one request's usage.
 *  2. `usage.iterations` — the SDK's per-iteration breakdown, whose last entry
 *     is the final request. Not in the published types; read defensively.
 */
function effectiveInputTokens(
  message: Extract<ClaudeSdkMessage, { type: "result" }>,
  mainRequestInputTokens?: number
): number | undefined {
  if (mainRequestInputTokens !== undefined && mainRequestInputTokens > 0) return mainRequestInputTokens;
  const record = message as unknown as Record<string, unknown>;
  const usage = record.usage as Record<string, unknown> | undefined;
  const iterations = usage?.iterations;
  if (!Array.isArray(iterations) || iterations.length === 0) return undefined;
  // `iterations` IS typed — `BetaUsage.iterations: BetaIterationsUsage | null`
  // in @anthropic-ai/sdk 0.110.0, reaching this message through
  // `NonNullableUsage` — but it is null on most results, and the union's
  // members are not uniform: only the per-message entries carry prompt
  // counters (a `fallback_message` entry, for instance, does not). Walk
  // backwards to the last entry that actually carries them rather than
  // trusting the tail.
  for (let index = iterations.length - 1; index >= 0; index--) {
    const entry = iterations[index] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.type === "string" && entry.type !== "message") continue;
    if (!hasRequestTokenFields(entry)) continue;
    const total = requestInputTokens(entry);
    if (total > 0) return total;
  }
  return undefined;
}

/** A usage-shaped record carries at least one of the three prompt counters. */
function hasRequestTokenFields(entry: Record<string, unknown>): boolean {
  return (
    typeof entry.input_tokens === "number" ||
    typeof entry.cache_read_input_tokens === "number" ||
    typeof entry.cache_creation_input_tokens === "number"
  );
}

/** Prompt size of the single API request that produced an assistant message. */
function assistantRequestInputTokens(
  message: Extract<ClaudeSdkMessage, { type: "assistant" }>
): number | undefined {
  const usage = (message.message as unknown as Record<string, unknown> | undefined)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const total = requestInputTokens(usage as Record<string, unknown>);
  return total > 0 ? total : undefined;
}

function requestInputTokens(usage: Record<string, unknown>): number {
  return (
    numberOrZero(usage.input_tokens) +
    numberOrZero(usage.cache_read_input_tokens) +
    numberOrZero(usage.cache_creation_input_tokens)
  );
}

/**
 * The serving model's context window, off `modelUsage`. Unlike the token
 * counts there this is a static model property, so the cumulative-sum problem
 * does not apply; it is what makes an occupancy figure interpretable.
 */
function reportedContextWindow(message: Extract<ClaudeSdkMessage, { type: "result" }>): number | undefined {
  const modelUsage = (message as unknown as Record<string, unknown>).modelUsage as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  let largest = 0;
  for (const entry of Object.values(modelUsage)) {
    if (!entry || typeof entry !== "object") continue;
    const window = numberOrZero(entry.contextWindow);
    if (window > largest) largest = window;
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
