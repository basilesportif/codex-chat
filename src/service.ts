import type { Logger } from "pino";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppConfig, ensureConfiguredDirectories, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { AppServerCodexClient, CodexCrashInfo } from "./codex.js";
import { DirectiveAction, parseDirectives } from "./directives.js";
import { FileStore } from "./file-store.js";
import { CodexHeartbeat } from "./heartbeat.js";
import { LocalIpcServer } from "./ipc.js";
import { LoopManager, syncCron } from "./loops.js";
import { MonitorManager } from "./monitors.js";
import { StateStore } from "./state.js";
import { SubagentManager } from "./subagents.js";
import { DisabledTranscriber, OpenAITranscriber, Transcriber } from "./transcription.js";
import { TelegramGateway } from "./telegram.js";
import { CodexClient, StoredAction, SubagentJob, UserEvent } from "./types.js";
import { makeId, nowIso } from "./util.js";

export const INJECT_TELEGRAM_USER_ID = 253768951;
const CODEX_UNAVAILABLE_MESSAGE = "⚠️ Codex is not available. Run 'codex login' on the server to authenticate.";
const CODEX_TEMPORARILY_UNAVAILABLE_MESSAGE = "⚠️ Codex is currently unavailable. Please try again shortly.";
const CODEX_RESTARTING_MESSAGE = "⚠️ Codex is restarting. Your message was not processed; please resend it after the restart notice.";
const DISABLED_EXEC_RESUME_MESSAGE = "exec-resume transport is disabled. Only app-server (OAuth) is supported. Run 'codex login' to authenticate.";
const RESTARTED_RESEND_MESSAGE = "⚠️ Service was restarted. Please resend your message.";
const QUEUE_OVERFLOW_MESSAGE = "⚠️ I dropped an older queued message because this chat already has 50 pending messages. Please resend it if still needed.";
const MAX_QUEUE_PER_KEY = 50;
const TURN_RESPONSE_WARN_MS = 45_000;
/**
 * Hard cap on how long a single turn may keep `turnRunning = true`. If we
 * detect a turn pinning the supervisor for longer than this we force-abort
 * it (clearing turnRunning, draining the queue, telling the user) so the
 * service does not become permanently wedged when something below us stops
 * responding without rejecting. This is a watchdog of last resort — the
 * primary fix lives in codex.ts where dead WebSockets now fail in-flight
 * sendTurn iterators rather than letting them hang.
 */
const TURN_ABORT_MS = 5 * 60_000;
const TURN_ABORTED_MESSAGE =
  "⚠️ Your previous request timed out after 5 minutes. Please resend your message.";
const CONTEXT_RESET_USER_MESSAGE =
  "⚠️ Codex crashed mid-turn and was restarted. The conversation context was reset — please resend your last message and re-establish any context you need.";
const CONTEXT_RESET_OPS_NOTE =
  "Note: conversation context was reset due to the crash. Active users have been notified.";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MAX_SEEN_IDEMPOTENCY = 5_000;

type QueuedEvent = {
  event: UserEvent;
  persistedId?: string;
};

export function injectFilePath(config: AppConfig): string {
  return join(config.service.workspace, "inject.json");
}

export class ServiceSupervisor {
  readonly state: StateStore;
  readonly behavior: BehaviorPack;
  readonly files: FileStore;
  readonly telegram: TelegramGateway;
  readonly codex: CodexClient;
  readonly loops: LoopManager;
  readonly monitors: MonitorManager;
  private readonly heartbeat: CodexHeartbeat;
  private readonly ipc: LocalIpcServer;
  private readonly subagents: SubagentManager;
  private messageQueue = new Map<string, QueuedEvent[]>();
  private turnRunning = false;
  /** Wall-clock time the currently-running turn started; cleared in runTurn's finally. */
  private turnStartedAt?: Date;
  /** The event currently being processed; used for chat-level crash/timeout notifications. */
  private activeTurnEvent?: UserEvent;
  private activeTurnToken = 0;
  private drainingQueue = false;
  private watchdogInterval?: ReturnType<typeof setInterval>;
  private injectInterval?: ReturnType<typeof setInterval>;
  private injectPolling = false;
  private stopping = false;
  private restartingCodex = false;
  private seenIdempotency = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.state = new StateStore(config);
    this.behavior = new BehaviorPack(config);
    this.files = new FileStore(config, this.state);
    const transcriber = this.createTranscriber();
    if (config.codex.transport !== "app-server") {
      throw new Error(DISABLED_EXEC_RESUME_MESSAGE);
    }
    this.codex = new AppServerCodexClient(config, this.state, this.behavior, logger, (reason, info) => {
      // Capture the active chat synchronously: by the time restartCodex's
      // first await resumes, processEventSafe's .finally may have already
      // cleared activeTurnEvent in response to the now-failed sendTurn
      // iterator throwing.
      const activeChatId = this.activeTurnEvent?.chatId;
      const activeMessageId = this.activeTurnEvent?.messageId;
      void this.restartCodex(reason, info, { activeChatId, activeMessageId }).catch((error) => {
        this.logger.error({ component: "service", event: "restart_failed", error }, "Codex restart failed");
      });
    });
    this.subagents = new SubagentManager(
      config,
      this.behavior,
      this.state,
      logger,
      {
        onReturnToMain: async (job: SubagentJob, result: string) => {
          await this.enqueueSynthetic(`Subagent ${job.id} (${job.profile}) completed.\n\nResult path: ${job.lastMessagePath ?? "unknown"}\n\n${result}`, {
            source: "subagent",
            jobId: job.id,
            profile: job.profile
          });
        },
        onSendToUser: async (job: SubagentJob, result: string) => {
          if (job.originChatId) await this.telegram.sendText(job.originChatId, result, job.originMessageId);
        }
      }
    );
    this.telegram = new TelegramGateway(config, this.state, this.files, transcriber, logger, {
      onUserEvent: (event) => this.enqueueUserEvent(event),
      onJobsCommand: async () => this.formatJobs(),
      onCancelCommand: async (_chatId, jobId) => this.cancelJob(jobId),
      onHealthCommand: async () => this.healthText()
    });
    this.loops = new LoopManager(config, this.state, logger, {
      enqueueMain: (text, metadata) => this.enqueueSynthetic(text, metadata),
      sendAdmins: (text) => this.telegram.notifyOps(text),
      dispatchSubagent: async (input) => {
        await this.subagents.dispatch(input);
      }
    });
    this.monitors = new MonitorManager(config, this.state, logger, {
      enqueueMain: (text, metadata) => this.enqueueSynthetic(text, metadata),
      dispatchSubagent: async (input) => {
        await this.subagents.dispatch(input);
      },
      notifyAdmins: (text) => this.telegram.notifyOps(text)
    });
    this.heartbeat = new CodexHeartbeat(
      this.codex,
      (text) => this.telegram.notifyOps(text),
      logger
    );
    this.ipc = new LocalIpcServer(resolveConfigPath(config, config.service.ipcSocket), logger, async (message) => {
      if (message.type === "loop_run") await this.loops.handleRun(message.loopId, message.scheduledAt);
    });
  }

  async start(): Promise<void> {
    await ensureConfiguredDirectories(this.config);
    await this.state.init();
    await this.files.init();
    await this.behavior.loadBootstrapPrompt();
    await this.codex.start();
    await this.telegram.start();
    await this.recoverAbandonedWork();
    await this.ipc.start();
    if (this.config.loops.enabled) await syncCron(this.config, this.logger).catch((error) => this.logger.warn({ component: "loops", event: "cron_sync_failed", error }));
    await this.loops.processSpooled().catch((error) => this.logger.warn({ component: "loops", event: "spool_process_failed", error }));
    await this.monitors.start();
    this.heartbeat.start();
    this.watchdogInterval = setInterval(() => void this.checkTurnTimeout(), 15_000);
    this.injectInterval = setInterval(() => void this.pollInjectFile(), 1_000);
    const health = await this.codex.health();
    await this.telegram.notifyOps(`codex-chat started\ntransport: ${health.transport}\nsandbox: ${this.config.codex.sandbox}\nsession: ${health.sessionId ?? "new"}`);
  }

  async stop(): Promise<void> {
    if (this.watchdogInterval) clearInterval(this.watchdogInterval);
    if (this.injectInterval) clearInterval(this.injectInterval);
    if (this.stopping) return;
    this.stopping = true;
    await this.telegram.notifyOps("codex-chat shutting down").catch(() => undefined);
    await this.ipc.stop().catch(() => undefined);
    await this.telegram.stop().catch(() => undefined);
    await this.monitors.stop().catch(() => undefined);
    this.heartbeat.stop();
    await this.subagents.shutdown().catch(() => undefined);
    await this.codex.stop().catch(() => undefined);
  }

  async enqueueUserEvent(event: UserEvent): Promise<void> {
    const key = event.chatId ? String(event.chatId) : "system";
    if (this.shouldQueueTurn()) {
      await this.queueEvent(key, event);
      return;
    }
    this.runTurn(event);
  }

  async enqueueSynthetic(text: string, metadata?: Record<string, unknown>): Promise<void> {
    const event: UserEvent = {
      source: (metadata?.source as UserEvent["source"]) ?? "system",
      text,
      attachments: [],
      metadata,
      receivedAt: nowIso()
    };
    if (this.shouldQueueTurn()) {
      await this.queueEvent("system", event);
      return;
    }
    this.runTurn(event);
  }

  async health(): Promise<Record<string, unknown>> {
    const codex = await this.codex.health();
    return {
      ok: true,
      service: this.config.service.name,
      workspace: this.config.service.workspace,
      codex,
      telegramConfigured: Boolean(this.config.telegramBotToken),
      openaiConfigured: Boolean(this.config.openaiApiKey),
      stateDir: this.state.root
    };
  }

  async healthText(): Promise<string> {
    const health = await this.health();
    return [
      "codex-chat health",
      `ok: ${health.ok}`,
      `codex: ${(health.codex as { transport?: string; ok?: boolean }).transport} (${(health.codex as { ok?: boolean }).ok ? "ok" : "degraded"})`,
      `telegramConfigured: ${health.telegramConfigured}`,
      `openaiConfigured: ${health.openaiConfigured}`
    ].join("\n");
  }

  formatJobs(): string {
    const jobs = this.subagents.listJobs();
    if (jobs.length === 0) return "No subagent jobs.";
    return jobs.slice(0, 20).map((job) => `${job.id} ${job.status} ${job.profile}${job.startedAt ? ` started=${job.startedAt}` : ""}`).join("\n");
  }

  async cancelJob(jobId: string): Promise<string> {
    return await this.subagents.cancel(jobId) ? `Cancelled ${jobId}.` : `No running job found: ${jobId}`;
  }

  private async processEvent(event: UserEvent): Promise<void> {
    const prompt = this.formatEventForCodex(event);
    const turnId = makeId("turn");
    let turnClosed = false;
    const closeTurn = async (value: Record<string, unknown>): Promise<void> => {
      await this.state.writeJson(`turns/${turnId}.json`, value);
      turnClosed = true;
    };
    await this.state.writeJson(`turns/${turnId}.json`, { id: turnId, status: "running", input: event, startedAt: nowIso() });
    // Keep a "typing..." indicator visible to the user for the entire duration
    // of the Codex turn so they always know we received the message and are
    // working on it. Telegram clears the typing action after ~5s, so we refresh
    // it on a short interval. The first call happens synchronously below so
    // even queued and synthetic-with-chat events get an instant indicator.
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    if (event.chatId) {
      void this.telegram.sendChatAction(event.chatId, "typing");
      typingInterval = setInterval(() => {
        if (event.chatId) void this.telegram.sendChatAction(event.chatId, "typing");
      }, 4_000);
    }
    const stopTyping = (): void => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = undefined;
      }
    };
    try {
      await this.removePersistedQueuedEvent(event);
      let output = "";
      let hadError = false;
      let errorMessage = "";
      try {
        for await (const codexEvent of this.codex.sendTurn({ text: prompt, attachments: event.attachments, source: event.source, turnId })) {
          if (codexEvent.type === "delta") output += codexEvent.text;
          if (codexEvent.type === "final" && codexEvent.text.trim()) output = codexEvent.text;
          if (codexEvent.type === "error") {
            hadError = true;
            errorMessage = codexEvent.message ?? "unknown error";
            this.logger.error({ component: "codex", event: "turn_event_error", turnId, detail: codexEvent.message });
          }
        }
      } catch (error) {
        this.logger.error({ component: "codex", event: "turn_unavailable", turnId, error }, "Codex turn failed");
        await closeTurn({ id: turnId, status: "error", input: event, errorMessage: error instanceof Error ? error.message : String(error), completedAt: nowIso() });
        if (event.chatId) {
          try {
            await this.telegram.sendText(event.chatId, this.codexUnavailableMessage(error), event.messageId);
          } catch (sendError) {
            this.logger.error({ component: "service", event: "codex_unavailable_reply_failed", sendError }, "Failed to send Codex unavailable reply to Telegram");
          }
        }
        return;
      }
      if (hadError && !output.trim() && event.chatId) {
        const brief = errorMessage.split("\n")[0].slice(0, 100);
        await closeTurn({ id: turnId, status: "error", input: event, errorMessage, completedAt: nowIso() });
        await this.telegram.sendText(event.chatId, `Codex encountered an error: ${brief}. Please try again.`);
        return;
      }
      const parsed = parseDirectives(output);
      if (parsed.cleanText && event.chatId) await this.telegram.sendText(event.chatId, parsed.cleanText, event.messageId);
      for (const error of parsed.errors) {
        void this.enqueueSynthetic(`The previous assistant output contained an invalid codex-chat directive: ${error}`, { source: "system", turnId });
      }
      for (const block of parsed.blocks) {
        for (const action of block.actions) await this.executeDirective(action, event);
      }
      await closeTurn({ id: turnId, status: "completed", input: event, outputText: output, completedAt: nowIso() });
    } catch (error) {
      if (!turnClosed) {
        await closeTurn({ id: turnId, status: "error", input: event, errorMessage: error instanceof Error ? error.message : String(error), completedAt: nowIso() });
      }
      throw error;
    } finally {
      stopTyping();
      await this.removePersistedQueuedEvent(event);
    }
  }

  private async executeDirective(action: DirectiveAction, origin: UserEvent): Promise<void> {
    const stored: StoredAction = {
      id: makeId("action"),
      idempotencyKey: action.idempotencyKey,
      type: action.type,
      status: "pending",
      createdAt: nowIso(),
      payload: action
    };
    if (action.idempotencyKey && this.hasSeenIdempotency(action.idempotencyKey)) {
      stored.status = "skipped";
      await this.state.saveAction(stored);
      return;
    }
    if (action.idempotencyKey) this.rememberIdempotency(action.idempotencyKey);
    await this.state.saveAction(stored);
    stored.status = "running";
    await this.state.saveAction(stored);
    try {
      const defaultChatId = origin.chatId;
      if (action.type === "send_text") await this.telegram.sendText(action.chatId ?? this.requireChat(defaultChatId), action.text, action.replyToMessageId);
      if (action.type === "send_image") await this.telegram.sendImage(action.chatId ?? this.requireChat(defaultChatId), action);
      if (action.type === "send_document") await this.telegram.sendDocument(action.chatId ?? this.requireChat(defaultChatId), action);
      if (action.type === "dispatch_subagent") {
        await this.subagents.dispatchFromDirective(action, { chatId: origin.chatId, messageId: origin.messageId });
      }
      if (action.type === "cancel_job") await this.subagents.cancel(action.jobId);
      if (action.type === "notify_owner") await this.telegram.notifyOps(action.text);
      if (action.type === "enqueue_main") void this.enqueueSynthetic(action.text, action.metadata);
      stored.status = "completed";
    } catch (error) {
      stored.status = "failed";
      stored.error = error instanceof Error ? error.message : String(error);
      this.logger.error({ component: "directives", event: "action_failed", actionType: action.type, error }, "directive action failed");
      void this.enqueueSynthetic(`Directive action ${action.type} failed: ${stored.error}`, { source: "system" });
    } finally {
      stored.completedAt = nowIso();
      await this.state.saveAction(stored);
    }
  }

  private async restartCodex(
    reason: string,
    info?: CodexCrashInfo,
    activeTurn?: { activeChatId?: number; activeMessageId?: number }
  ): Promise<void> {
    if (this.restartingCodex || this.stopping) return;
    this.restartingCodex = true;
    const wasKilled = info?.wasKilled ?? false;
    const crashHeader = wasKilled
      ? `⚠️ Codex was SIGKILL'd (likely OOM kill) — signal=${info?.signal ?? "SIGKILL"} code=${info?.code ?? "null"}`
      : `Codex process crash detected: ${reason}`;
    await this.telegram.notifyOps(`${crashHeader}\n${reason}\nRestarting...`).catch(() => undefined);
    let recovered = false;
    try {
      // Retry codex.start() with exponential backoff. Without this, a single
      // failed start (e.g. transient port bind error) leaves the service
      // permanently degraded — every subsequent turn fails with "not
      // connected" and the user gets no clear signal that the underlying
      // engine never recovered.
      const attempts = this.config.codex.maxRestartAttempts;
      const baseDelayMs = this.config.codex.restartBackoffBaseMs;
      const maxDelayMs = this.config.codex.restartBackoffMaxMs;
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (this.stopping) return;
        try {
          await this.codex.stop().catch(() => undefined);
          await this.codex.start();
          recovered = true;
          break;
        } catch (error) {
          lastError = error;
          this.logger.error(
            { component: "codex", event: "restart_attempt_failed", attempt, attempts, error },
            `Codex restart attempt ${attempt}/${attempts} failed`
          );
          // Re-alert on every 3rd failed attempt so Tim sees the loop, not
          // just the first failure.
          if (attempt === 1 || attempt === attempts || attempt % 3 === 0) {
            await this.telegram.notifyOps(
              `⚠️ Codex restart attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`
            ).catch(() => undefined);
          }
          if (attempt === attempts) break;
          const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      if (!recovered) {
        await this.telegram.notifyOps(
          `🚨 codex-chat: Codex failed to restart after ${attempts} attempts. Service is DOWN. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}\nManual intervention required (check 'codex login', port ${this.config.codex.appServerPort}, systemctl --user status codex-chat).`
        ).catch(() => undefined);
        this.logger.error({ component: "codex", event: "restart_exhausted", attempts, lastError }, "Codex restart exhausted; service is down");
        return;
      }
      const health = await this.codex.health();
      // After a crash the in-memory thread on the app-server is gone, so the
      // restarted codex has either resumed our stored thread or started a
      // fresh one — either way, the user's mid-turn context is lost. Make
      // that explicit on the ops channel and tell the affected user directly.
      await this.telegram.notifyOps(
        `Codex restarted cleanly.\ntransport: ${health.transport}\nsession: ${health.sessionId ?? "unknown"}\n${CONTEXT_RESET_OPS_NOTE}`
      ).catch(() => undefined);
      if (activeTurn?.activeChatId) {
        try {
          await this.telegram.sendText(
            activeTurn.activeChatId,
            CONTEXT_RESET_USER_MESSAGE,
            activeTurn.activeMessageId
          );
        } catch (sendError) {
          this.logger.error(
            { component: "service", event: "context_reset_notice_failed", chatId: activeTurn.activeChatId, sendError },
            "Failed to notify user about Codex context reset"
          );
        }
      }
    } catch (error) {
      await this.telegram.notifyOps(`Codex restart failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      this.logger.error({ component: "codex", event: "restart_failed", error }, "Codex restart failed");
    } finally {
      this.restartingCodex = false;
      // Only drain if we recovered. If codex is still dead, draining the
      // queue would burn through every queued message with "Codex is not
      // available" replies, making the outage worse.
      if (recovered) this.drainQueue();
    }
  }

  private runTurn(event: UserEvent): void {
    if (this.turnRunning) {
      void this.queueEvent(event.chatId ? String(event.chatId) : "system", event);
      return;
    }
    this.turnRunning = true;
    const token = ++this.activeTurnToken;
    this.turnStartedAt = new Date();
    this.activeTurnEvent = event;
    void this.processEventSafe(event).finally(() => {
      if (this.activeTurnToken !== token) return;
      this.turnRunning = false;
      this.turnStartedAt = undefined;
      this.activeTurnEvent = undefined;
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.turnRunning || this.restartingCodex || this.drainingQueue) return;
    this.drainingQueue = true;
    for (const [key, queue] of this.messageQueue) {
      if (queue.length > 0) {
        const next = queue.shift()!;
        if (queue.length === 0) this.messageQueue.delete(key);
        this.runTurn(next.event);
        this.drainingQueue = false;
        return;
      }
    }
    this.drainingQueue = false;
  }

  private async processEventSafe(event: UserEvent): Promise<void> {
    try {
      await this.processEvent(event);
    } catch (error) {
      await this.removePersistedQueuedEvent(event);
      const brief = error instanceof Error ? error.message.split("\n")[0].slice(0, 100) : String(error).slice(0, 100);
      this.logger.error({ component: "service", event: "turn_error", error }, "Turn processing failed");
      if (event.chatId) {
        try {
          await this.telegram.sendText(event.chatId, `Codex encountered an error: ${brief}. Please try again.`);
        } catch (sendError) {
          this.logger.error({ component: "service", event: "error_reply_failed", sendError }, "Failed to send error reply to Telegram");
        }
      }
    }
  }

  private async recoverAbandonedWork(): Promise<void> {
    await this.abandonStuckTurns();
    await this.abandonQueuedTurns();
  }

  private async abandonStuckTurns(): Promise<void> {
    const turnsDir = resolveConfigPath(this.config, join(this.config.service.stateDir, "turns"));
    try {
      const files = await readdir(turnsDir).catch(() => []);
      let abandoned = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const path = join(turnsDir, file);
        try {
          const raw = await readFile(path, "utf8");
          const turn = JSON.parse(raw) as { status?: string };
          if (turn.status === "running") {
            turn.status = "abandoned";
            (turn as Record<string, unknown>).abandonedAt = nowIso();
            await writeFile(path, JSON.stringify(turn, null, 2));
            abandoned++;
            await this.notifyRestartedUser(turn as { input?: UserEvent });
          }
        } catch {
          // ignore individual file errors
        }
      }
      if (abandoned > 0) {
        this.logger.warn({ component: "service", event: "abandoned_turns", count: abandoned }, `Abandoned ${abandoned} stuck turn(s) from previous session`);
      }
    } catch {
      // ignore if turns dir doesn't exist yet
    }
  }

  private async abandonQueuedTurns(): Promise<void> {
    const queuedDir = resolveConfigPath(this.config, join(this.config.service.stateDir, "queued_turns"));
    try {
      const files = await readdir(queuedDir).catch(() => []);
      let abandoned = 0;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const path = join(queuedDir, file);
        try {
          const queued = JSON.parse(await readFile(path, "utf8")) as { event?: UserEvent };
          await this.notifyRestartedUser({ input: queued.event });
          await rm(path, { force: true });
          abandoned++;
        } catch {
          // ignore individual file errors
        }
      }
      if (abandoned > 0) {
        this.logger.warn({ component: "service", event: "abandoned_queued_turns", count: abandoned }, `Abandoned ${abandoned} queued turn(s) from previous session`);
      }
    } catch {
      // ignore if queued dir doesn't exist yet
    }
  }

  private async notifyRestartedUser(turn: { input?: UserEvent }): Promise<void> {
    const chatId = turn.input?.chatId;
    if (!chatId) return;
    try {
      await this.telegram.sendText(chatId, RESTARTED_RESEND_MESSAGE, turn.input?.messageId);
    } catch (error) {
      this.logger.error({ component: "service", event: "restart_notice_failed", chatId, error }, "Failed to send restart notice to Telegram");
    }
  }

  private async persistQueuedEvent(event: UserEvent): Promise<string | undefined> {
    if (!event.chatId) return undefined;
    const id = makeId("queued");
    const persistedEvent: UserEvent = {
      ...event,
      metadata: { ...event.metadata, persistedQueueId: id }
    };
    await this.state.writeJson(`queued_turns/${id}.json`, { id, event: persistedEvent, queuedAt: nowIso() });
    event.metadata = persistedEvent.metadata;
    return id;
  }

  private async removePersistedQueuedEvent(event: UserEvent): Promise<void> {
    const persistedId = typeof event.metadata?.persistedQueueId === "string" ? event.metadata.persistedQueueId : undefined;
    if (!persistedId) return;
    await rm(this.state.path(`queued_turns/${persistedId}.json`), { force: true }).catch(() => undefined);
  }

  private shouldQueueTurn(): boolean {
    return this.turnRunning || this.restartingCodex;
  }

  private async queueEvent(key: string, event: UserEvent): Promise<void> {
    const persistedId = await this.persistQueuedEvent(event);
    const queue = this.messageQueue.get(key) ?? [];
    if (!this.messageQueue.has(key)) this.messageQueue.set(key, queue);
    queue.push({ event, persistedId });
    const dropped: QueuedEvent[] = [];
    while (queue.length > MAX_QUEUE_PER_KEY) {
      const next = queue.shift();
      if (next) dropped.push(next);
    }
    this.logger.info({ component: "service", event: "message_queued", key, queueLength: queue.length, restartingCodex: this.restartingCodex }, "Turn busy - message queued");
    for (const item of dropped) await this.dropQueuedEvent(item);
    if (!this.shouldQueueTurn()) this.drainQueue();
  }

  private async dropQueuedEvent(queued: QueuedEvent): Promise<void> {
    if (queued.persistedId) await rm(this.state.path(`queued_turns/${queued.persistedId}.json`), { force: true }).catch(() => undefined);
    else await this.removePersistedQueuedEvent(queued.event);
    this.logger.warn({ component: "service", event: "queue_overflow_drop", chatId: queued.event.chatId, messageId: queued.event.messageId }, "Dropped queued message due to queue overflow");
    if (!queued.event.chatId) return;
    try {
      await this.telegram.sendText(queued.event.chatId, QUEUE_OVERFLOW_MESSAGE, queued.event.messageId);
    } catch (error) {
      this.logger.error({ component: "service", event: "queue_overflow_notice_failed", chatId: queued.event.chatId, error }, "Failed to notify user about queue overflow");
    }
  }

  private codexUnavailableMessage(error: unknown): string {
    if (this.restartingCodex) return CODEX_RESTARTING_MESSAGE;
    const text = error instanceof Error ? error.message : String(error);
    if (/websocket|not connected|reconnecting|closed|timed out/i.test(text)) return CODEX_TEMPORARILY_UNAVAILABLE_MESSAGE;
    return CODEX_UNAVAILABLE_MESSAGE;
  }

  private hasSeenIdempotency(key: string): boolean {
    this.pruneSeenIdempotency();
    return this.seenIdempotency.has(key);
  }

  private rememberIdempotency(key: string): void {
    this.pruneSeenIdempotency();
    this.seenIdempotency.set(key, Date.now());
    while (this.seenIdempotency.size > MAX_SEEN_IDEMPOTENCY) {
      const oldest = this.seenIdempotency.keys().next().value;
      if (!oldest) break;
      this.seenIdempotency.delete(oldest);
    }
  }

  private pruneSeenIdempotency(): void {
    const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
    for (const [key, seenAt] of this.seenIdempotency) {
      if (seenAt >= cutoff) break;
      this.seenIdempotency.delete(key);
    }
  }

  private async pollInjectFile(): Promise<void> {
    if (this.injectPolling) return;
    this.injectPolling = true;
    const path = injectFilePath(this.config);
    try {
      const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (raw === undefined) return;
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const text = typeof payload.text === "string" ? payload.text : "";
      if (!text.trim()) throw new Error("inject.json is missing message text");
      const receivedAt = typeof payload.receivedAt === "string" ? payload.receivedAt : nowIso();
      const chatId = typeof payload.chatId === "number" ? payload.chatId : INJECT_TELEGRAM_USER_ID;
      const userId = typeof payload.userId === "number" ? payload.userId : INJECT_TELEGRAM_USER_ID;
      const messageId = typeof payload.messageId === "number" ? payload.messageId : undefined;
      const username = typeof payload.username === "string" ? payload.username : "tim";
      const event: UserEvent = {
        source: "telegram",
        chatId,
        userId,
        username,
        messageId,
        text,
        attachments: [],
        receivedAt,
        metadata: { injected: true }
      };
      await this.state.recordMessage({
        direction: "inbound",
        chatId,
        userId,
        username,
        messageId,
        text,
        attachments: [],
        receivedAt,
        injected: true
      });
      await this.enqueueUserEvent(event);
      await rm(path, { force: true });
      this.logger.info({ component: "service", event: "inject_consumed", path, userId, chatId }, "Consumed injected message");
    } catch (error) {
      this.logger.error({ component: "service", event: "inject_failed", path, error }, "Failed to process injected message");
    } finally {
      this.injectPolling = false;
    }
  }

  private async checkTurnTimeout(): Promise<void> {
    if (!this.turnRunning) return;

    // Hard abort: if a turn has been running longer than TURN_ABORT_MS,
    // something below us (sendTurn iterator, codex process, websocket) has
    // failed to terminate even though we expect it to. Forcibly clear the
    // turnRunning flag, notify the user, and drain the queue so the service
    // does not stay wedged for the rest of its uptime.
    if (this.turnStartedAt && Date.now() - this.turnStartedAt.getTime() > TURN_ABORT_MS) {
      await this.forceAbortStuckTurn();
      return;
    }

    const turnsDir = resolveConfigPath(this.config, join(this.config.service.stateDir, "turns"));
    try {
      const files = await readdir(turnsDir).catch(() => []);
      const warnBefore = new Date(Date.now() - TURN_RESPONSE_WARN_MS).toISOString();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const path = join(turnsDir, file);
        try {
          const raw = await readFile(path, "utf8");
          const turn = JSON.parse(raw) as { status?: string; startedAt?: string; input?: { chatId?: number } };
          if (turn.status === "running" && turn.startedAt && turn.startedAt < warnBefore) {
            turn.status = "timeout";
            (turn as Record<string, unknown>).timedOutAt = nowIso();
            await writeFile(path, JSON.stringify(turn, null, 2));
            const chatId = turn.input?.chatId;
            if (chatId) {
              try {
                await this.telegram.sendText(chatId, "Codex is still working. Please resend your message if this does not complete shortly.");
              } catch {
                // ignore send failures in watchdog
              }
            }
          }
        } catch {
          // ignore individual file errors
        }
      }
    } catch {
      // ignore watchdog errors entirely
    }
  }

  private async forceAbortStuckTurn(): Promise<void> {
    const event = this.activeTurnEvent;
    const startedAt = this.turnStartedAt?.toISOString();
    const ageMs = this.turnStartedAt ? Date.now() - this.turnStartedAt.getTime() : undefined;
    this.logger.error(
      { component: "service", event: "turn_force_abort", chatId: event?.chatId, startedAt, ageMs },
      `Force-aborting stuck turn after ${TURN_ABORT_MS}ms — something below sendTurn never resolved`
    );
    // Clear watchdog state synchronously so concurrent enqueues do not
    // observe turnRunning=true and silently re-queue.
    this.turnRunning = false;
    this.activeTurnToken++;
    this.turnStartedAt = undefined;
    this.activeTurnEvent = undefined;
    await this.markActiveTurnAborted(event);
    if (event?.chatId) {
      try {
        await this.telegram.sendText(event.chatId, TURN_ABORTED_MESSAGE, event.messageId);
      } catch (sendError) {
        this.logger.error(
          { component: "service", event: "turn_abort_notice_failed", chatId: event.chatId, sendError },
          "Failed to notify user about forced turn abort"
        );
      }
    }
    await this.telegram.notifyOps(
      `Watchdog: aborted a turn that had been running for ${ageMs ?? "?"}ms (chat=${event?.chatId ?? "n/a"}, source=${event?.source ?? "n/a"}).`
    ).catch(() => undefined);
    this.drainQueue();
  }

  private async markActiveTurnAborted(event?: UserEvent): Promise<void> {
    if (!event) return;
    const turnsDir = resolveConfigPath(this.config, join(this.config.service.stateDir, "turns"));
    const files = await readdir(turnsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(turnsDir, file);
      try {
        const turn = JSON.parse(await readFile(path, "utf8")) as { status?: string; input?: UserEvent } & Record<string, unknown>;
        if (turn.status !== "running" && turn.status !== "timeout") continue;
        const input = turn.input;
        if (!input || input.source !== event.source || input.chatId !== event.chatId || input.messageId !== event.messageId || input.receivedAt !== event.receivedAt) continue;
        turn.status = "aborted";
        turn.abortedAt = nowIso();
        await writeFile(path, JSON.stringify(turn, null, 2));
        return;
      } catch {
        // ignore individual file errors in watchdog cleanup
      }
    }
  }

  private formatEventForCodex(event: UserEvent): string {
    const header = [
      `codex-chat event source: ${event.source}`,
      event.chatId ? `telegram chat_id: ${event.chatId}` : "",
      event.userId ? `telegram user_id: ${event.userId}` : "",
      event.messageId ? `telegram message_id: ${event.messageId}` : "",
      `received_at: ${event.receivedAt}`
    ].filter(Boolean).join("\n");
    const attachments = event.attachments.length > 0
      ? `\nAttachments:\n${event.attachments.map((item) => `- ${item.kind}: ${item.localPath}${item.mimeType ? ` (${item.mimeType})` : ""}`).join("\n")}`
      : "";
    return `${header}\n\nUser content:\n${event.text}${attachments}`;
  }

  private requireChat(chatId?: number): number {
    if (!chatId) throw new Error("Directive did not include chatId and the origin event has no Telegram chat");
    return chatId;
  }

  private createTranscriber(): Transcriber {
    if (!this.config.transcription.enabled) return new DisabledTranscriber();
    if (this.config.transcription.provider === "openai") return new OpenAITranscriber(this.config);
    return new DisabledTranscriber();
  }
}
