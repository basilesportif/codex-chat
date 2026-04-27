import type { Logger } from "pino";
import { AppConfig, ensureConfiguredDirectories, resolveConfigPath } from "./config.js";
import { BehaviorPack } from "./behavior.js";
import { AppServerCodexClient, ExecResumeCodexClient, HybridCodexClient } from "./codex.js";
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
  private turnChain: Promise<void> = Promise.resolve();
  private stopping = false;
  private restartingCodex = false;
  private seenIdempotency = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {
    this.state = new StateStore(config);
    this.behavior = new BehaviorPack(config);
    this.files = new FileStore(config, this.state);
    const transcriber = this.createTranscriber();
    const appServer = new AppServerCodexClient(config, this.state, this.behavior, logger, (reason) => {
      void this.restartCodex(reason);
    });
    const execFallback = new ExecResumeCodexClient(config, this.state, this.behavior, logger);
    this.codex = config.codex.transport === "app-server"
      ? new HybridCodexClient(appServer, execFallback, logger)
      : execFallback;
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
    await this.ipc.start();
    if (this.config.loops.enabled) await syncCron(this.config, this.logger).catch((error) => this.logger.warn({ component: "loops", event: "cron_sync_failed", error }));
    await this.loops.processSpooled().catch((error) => this.logger.warn({ component: "loops", event: "spool_process_failed", error }));
    await this.monitors.start();
    this.heartbeat.start();
    const health = await this.codex.health();
    await this.telegram.notifyOps(`codex-chat started\ntransport: ${health.transport}\nsandbox: ${this.config.codex.sandbox}\nsession: ${health.sessionId ?? "new"}`);
  }

  async stop(): Promise<void> {
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
    this.turnChain = this.turnChain.then(() => this.processEvent(event)).catch((error) => {
      this.logger.error({ component: "service", event: "turn_failed", error }, "turn failed");
      if (event.chatId) void this.telegram.sendText(event.chatId, `Codex turn failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.turnChain;
  }

  async enqueueSynthetic(text: string, metadata?: Record<string, unknown>): Promise<void> {
    const event: UserEvent = {
      source: (metadata?.source as UserEvent["source"]) ?? "system",
      text,
      attachments: [],
      metadata,
      receivedAt: nowIso()
    };
    this.turnChain = this.turnChain.then(() => this.processEvent(event)).catch((error) => {
      this.logger.error({ component: "service", event: "synthetic_turn_failed", error }, "synthetic turn failed");
    });
    await this.turnChain;
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
    await this.state.writeJson(`turns/${turnId}.json`, { id: turnId, status: "running", input: event, startedAt: nowIso() });
    let output = "";
    for await (const codexEvent of this.codex.sendTurn({ text: prompt, attachments: event.attachments, source: event.source, turnId })) {
      if (codexEvent.type === "delta") output += codexEvent.text;
      if (codexEvent.type === "final" && codexEvent.text.trim()) output = codexEvent.text;
      if (codexEvent.type === "error") this.logger.error({ component: "codex", event: "turn_event_error", turnId, detail: codexEvent.message });
    }
    const parsed = parseDirectives(output);
    await this.state.writeJson(`turns/${turnId}.json`, { id: turnId, status: "completed", input: event, outputText: output, completedAt: nowIso() });
    if (parsed.cleanText && event.chatId) await this.telegram.sendText(event.chatId, parsed.cleanText, event.messageId);
    for (const error of parsed.errors) {
      void this.enqueueSynthetic(`The previous assistant output contained an invalid codex-chat directive: ${error}`, { source: "system", turnId });
    }
    for (const block of parsed.blocks) {
      for (const action of block.actions) await this.executeDirective(action, event);
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
    if (action.idempotencyKey && this.seenIdempotency.has(action.idempotencyKey)) {
      stored.status = "skipped";
      await this.state.saveAction(stored);
      return;
    }
    if (action.idempotencyKey) this.seenIdempotency.add(action.idempotencyKey);
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

  private async restartCodex(reason: string): Promise<void> {
    if (this.restartingCodex || this.stopping) return;
    this.restartingCodex = true;
    await this.telegram.notifyOps(`Codex process crash detected: ${reason}\nRestarting...`).catch(() => undefined);
    try {
      await this.codex.stop().catch(() => undefined);
      await this.codex.start();
      const health = await this.codex.health();
      await this.telegram.notifyOps(`Codex restarted cleanly.\ntransport: ${health.transport}\nsession: ${health.sessionId ?? "unknown"}`);
    } catch (error) {
      await this.telegram.notifyOps(`Codex restart failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
      this.logger.error({ component: "codex", event: "restart_failed", error }, "Codex restart failed");
    } finally {
      this.restartingCodex = false;
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
