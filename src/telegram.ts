import { Bot, InputFile, type Context } from "grammy";
import type { Logger } from "pino";
import { AppConfig } from "./config.js";
import { FileStore } from "./file-store.js";
import { StateStore } from "./state.js";
import { Transcriber } from "./transcription.js";
import { Attachment, UserEvent } from "./types.js";
import { chunkText, makePairingCode, nowIso } from "./util.js";


export interface TelegramAllowlistInput {
  userId?: number;
  chatId?: number;
  configUserIds: Array<number | string>;
  configChatIds: number[];
  stateUsers?: Array<{ userId: number; isAdmin?: boolean }>;
  stateChats?: Array<{ chatId: number }>;
}

function normalizeTelegramUserId(userId: number | string): string {
  return String(userId).trim();
}

export function isTelegramUserAllowed(input: TelegramAllowlistInput): boolean {
  if (input.userId === undefined || input.chatId === undefined) return false;
  const allowedUsers = new Set([...(input.configUserIds ?? []), ...(input.stateUsers ?? []).map((user) => user.userId)].map(normalizeTelegramUserId));
  const allowedChats = new Set([...(input.configChatIds ?? []), ...(input.stateChats ?? []).map((chat) => chat.chatId)]);
  if (!allowedUsers.has(normalizeTelegramUserId(input.userId))) return false;
  return allowedChats.size === 0 || allowedChats.has(input.chatId);
}

export function isTelegramAdmin(input: { userId?: number; configAdminUserIds: Array<number | string>; stateUsers?: Array<{ userId: number; isAdmin?: boolean }> }): boolean {
  if (input.userId === undefined) return false;
  const userId = normalizeTelegramUserId(input.userId);
  const configAdminUserIds = new Set(input.configAdminUserIds.map(normalizeTelegramUserId));
  return configAdminUserIds.has(userId) || Boolean(input.stateUsers?.some((user) => user.userId === input.userId && user.isAdmin));
}

interface TelegramCallbacks {
  onUserEvent(event: UserEvent): Promise<void>;
  onJobsCommand?(chatId: number): Promise<string>;
  onCancelCommand?(chatId: number, jobId: string): Promise<string>;
  onHealthCommand?(): Promise<string>;
}

export class TelegramGateway {
  private bot?: Bot;
  private pairingCode?: string;
  private token?: string;
  private pollingTask?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly files: FileStore,
    private readonly transcriber: Transcriber,
    private readonly logger: Logger,
    private readonly callbacks: TelegramCallbacks
  ) {}

  async start(): Promise<void> {
    this.token = this.config.telegramBotToken;
    if (!this.token) throw new Error(`${this.config.telegram.botTokenEnv} is required to start Telegram`);
    this.stopping = false;
    this.bot = new Bot(this.token);
    const emptyAllowlist = await this.isAllowlistEmpty();
    if (emptyAllowlist && this.config.telegram.pairingEnabledOnEmptyAllowlist) {
      this.pairingCode = await this.loadOrCreatePairingCode();
      this.logger.warn({ component: "telegram", event: "pairing_code" }, `Telegram pairing enabled. Send /pair ${this.pairingCode} to the bot.`);
      process.stderr.write(`\nTelegram pairing code: /pair ${this.pairingCode}\n\n`);
    }
    this.registerHandlers(this.bot);
    this.pollingTask = this.runPollingLoop(this.bot);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.bot?.stop();
    await this.pollingTask?.catch(() => undefined);
  }

  async sendText(chatId: number, text: string, replyToMessageId?: number, format?: "text" | "markdownv2"): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is not started");
    let parseMode: string | undefined;
    if (format === "markdownv2") {
      parseMode = "MarkdownV2";
    } else if (format === "text") {
      parseMode = undefined;
    } else {
      parseMode = this.config.telegram.parseMode === "plain" ? undefined : this.config.telegram.parseMode;
    }
    for (const chunk of chunkText(text || "(empty response)")) {
      await this.bot.api.sendMessage(chatId, chunk, {
        parse_mode: parseMode,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
      } as never);
      await this.state.recordMessage({ direction: "outbound", chatId, text: chunk, sentAt: nowIso() });
    }
  }

  async sendReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is not started");
    await this.bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji }] as never);
  }

  /**
   * Send a Telegram chat action (e.g. "typing") so the user sees an instant
   * indicator that we received their message and are working on a reply.
   * Telegram displays the action for ~5 seconds or until the next message,
   * whichever comes first. Failures are logged but never thrown — this is a
   * best-effort UX hint, not a critical send. Disabled when
   * telegram.sendProgressUpdates is false.
   */
  async sendChatAction(chatId: number, action: "typing" | "upload_photo" | "upload_document" = "typing"): Promise<void> {
    if (!this.bot) return;
    if (!this.config.telegram.sendProgressUpdates) return;
    try {
      await this.bot.api.sendChatAction(chatId, action);
    } catch (error) {
      this.logger.warn({ component: "telegram", event: "chat_action_failed", chatId, action, error }, "sendChatAction failed");
    }
  }

  async sendImage(chatId: number, input: { path?: string; fileId?: string; caption?: string; asDocument?: boolean; replyToMessageId?: number }): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is not started");
    const media = input.fileId ?? new InputFile(this.files.validateSendPath(input.path ?? ""));
    const options = {
      caption: input.caption,
      reply_parameters: input.replyToMessageId ? { message_id: input.replyToMessageId } : undefined
    } as never;
    if (input.asDocument) await this.bot.api.sendDocument(chatId, media, options);
    else await this.bot.api.sendPhoto(chatId, media, options);
  }

  async sendDocument(chatId: number, input: { path: string; caption?: string; replyToMessageId?: number }): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is not started");
    await this.bot.api.sendDocument(chatId, new InputFile(this.files.validateSendPath(input.path)), {
      caption: input.caption,
      reply_parameters: input.replyToMessageId ? { message_id: input.replyToMessageId } : undefined
    } as never);
  }

  async notifyOps(text: string): Promise<void> {
    const chatId = await this.opsChatId();
    if (!chatId) {
      this.logger.warn({ component: "telegram", event: "ops_notify_no_chat", text }, "no Telegram ops chat is known yet");
      return;
    }
    try {
      await this.sendText(chatId, text);
    } catch (error) {
      this.logger.error({ component: "telegram", event: "ops_notify_failed", error }, "failed to send Telegram ops notification");
    }
  }

  private registerHandlers(bot: Bot): void {
    bot.command("pair", async (ctx) => this.handlePair(ctx));
    bot.command("health", async (ctx) => {
      if (!(await this.isAuthorized(ctx))) return;
      await ctx.reply(this.callbacks.onHealthCommand ? await this.callbacks.onHealthCommand() : "ok");
    });
    bot.command("jobs", async (ctx) => {
      if (!(await this.isAuthorized(ctx))) return;
      await ctx.reply(this.callbacks.onJobsCommand ? await this.callbacks.onJobsCommand(ctx.chat.id) : "No job manager is configured.");
    });
    bot.command("cancel", async (ctx) => {
      if (!(await this.isAuthorized(ctx))) return;
      const jobId = (ctx.message?.text ?? "").split(/\s+/)[1];
      await ctx.reply(jobId && this.callbacks.onCancelCommand ? await this.callbacks.onCancelCommand(ctx.chat.id, jobId) : "Usage: /cancel <jobId>");
    });
    bot.on("message", async (ctx) => this.handleMessage(ctx));
    bot.catch((error) => this.logger.error({ component: "telegram", event: "handler_error", error }, "Telegram handler failed"));
  }

  private async runPollingLoop(bot: Bot): Promise<void> {
    while (!this.stopping) {
      try {
        await bot.start({
          onStart: (info) => this.logger.info({ component: "telegram", event: "started", username: info.username }, "Telegram polling started")
        });
        if (!this.stopping) this.logger.error({ component: "telegram", event: "polling_stopped" }, "Telegram polling stopped unexpectedly; restarting");
      } catch (error) {
        if (!this.stopping) this.logger.error({ component: "telegram", event: "polling_failed", error }, "Telegram polling failed; restarting");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  private async handlePair(ctx: Context): Promise<void> {
    const from = ctx.from;
    const chat = ctx.chat;
    const text = ctx.message?.text ?? "";
    const code = text.split(/\s+/)[1];
    if (!from || !chat) return;
    if (!this.pairingCode || code !== this.pairingCode) {
      await ctx.reply("Pairing failed.");
      return;
    }
    await this.state.addTelegramIdentity(from.id, chat.id, true);
    await this.state.deletePairingCode();
    this.pairingCode = undefined;
    await ctx.reply(`Paired user ${from.id} and chat ${chat.id}.`);
    this.logger.info({ component: "telegram", event: "paired", userId: from.id, chatId: chat.id }, "Telegram user paired");
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (ctx.message?.text?.startsWith("/pair")) return;
    if (!(await this.isAuthorized(ctx))) {
      await this.logDenied(ctx);
      return;
    }
    const message = ctx.message;
    if (!message || !ctx.from || !ctx.chat) return;
    // React immediately at the Telegram ingress layer. Codex-emitted `react`
    // directives cannot fire until the model starts returning output, and voice
    // transcription can also add latency before the event reaches Codex. This
    // best-effort reaction confirms receipt as soon as the bot has the message.
    void this.sendReaction(ctx.chat.id, message.message_id, "👀").catch((error) => {
      this.logger.warn({ component: "telegram", event: "immediate_reaction_failed", chatId: ctx.chat?.id, messageId: message.message_id, error }, "immediate reaction failed");
    });
    // Fire-and-forget typing indicator so the user sees instant feedback
    // before Codex even starts processing. Independent of any assistant
    // output — we always want some immediate signal of receipt.
    void this.sendChatAction(ctx.chat.id, "typing");
    const attachments: Attachment[] = [];
    let text = "text" in message && typeof message.text === "string" ? message.text : "";
    if ("caption" in message && typeof message.caption === "string") text = message.caption;

    if ("photo" in message && Array.isArray(message.photo) && message.photo.length > 0) {
      attachments.push(await this.downloadTelegramFile("image", message.photo.at(-1)));
    } else if ("document" in message && message.document) {
      const mimeType = message.document.mime_type ?? "";
      const isImage = mimeType.startsWith("image/");
      attachments.push(await this.downloadTelegramFile(isImage ? "image" : "document", message.document));
    } else if ("voice" in message && message.voice) {
      const attachment = await this.downloadTelegramFile("voice", message.voice);
      attachments.push(attachment);
      if (this.config.transcription.enabled) {
        const transcript = await this.transcriber.transcribe({ path: attachment.localPath });
        text = [
          text,
          "Voice transcript:",
          transcript.text,
          "",
          `Audio path: ${attachment.localPath}`
        ].filter(Boolean).join("\n");
      } else {
        await ctx.reply("Voice transcription is not enabled.");
        return;
      }
    } else if ("audio" in message && message.audio) {
      const attachment = await this.downloadTelegramFile("audio", message.audio);
      attachments.push(attachment);
      if (this.config.transcription.enabled) {
        const transcript = await this.transcriber.transcribe({ path: attachment.localPath });
        text = ["Audio transcript:", transcript.text, "", `Audio path: ${attachment.localPath}`].join("\n");
      }
    }

    if (!text && attachments.length === 0) {
      await ctx.reply("Unsupported message type.");
      return;
    }

    await this.state.recordMessage({
      direction: "inbound",
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      messageId: message.message_id,
      text,
      attachments,
      receivedAt: nowIso()
    });

    await this.callbacks.onUserEvent({
      source: "telegram",
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      username: ctx.from.username,
      messageId: message.message_id,
      text,
      attachments,
      receivedAt: nowIso(),
      metadata: { telegramMessageId: message.message_id }
    });
  }

  private async downloadTelegramFile(kind: Attachment["kind"], fileLike: any): Promise<Attachment> {
    if (!this.bot || !this.token) throw new Error("Telegram bot is not started");
    const fileId = fileLike.file_id as string;
    const fileUniqueId = fileLike.file_unique_id as string;
    const telegramFile = await this.bot.api.getFile(fileId);
    if (!telegramFile.file_path) throw new Error("Telegram did not return file_path");
    if (telegramFile.file_size && telegramFile.file_size > this.config.telegram.downloadMaxBytes) {
      throw new Error(`Telegram file exceeds downloadMaxBytes: ${telegramFile.file_size}`);
    }
    const url = `https://api.telegram.org/file/bot${this.token}/${telegramFile.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.config.telegram.downloadMaxBytes) throw new Error(`Telegram file exceeds downloadMaxBytes: ${buffer.length}`);
    return this.files.storeTelegramFile({
      buffer,
      kind,
      telegramFileId: fileId,
      telegramFileUniqueId: fileUniqueId,
      mimeType: fileLike.mime_type,
      originalName: fileLike.file_name,
      receivedFromUserId: fileLike.from?.id
    });
  }

  private async isAuthorized(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return false;
    const stateUsers = await this.state.listTelegramUsers();
    const stateChats = await this.state.listTelegramChats();
    return isTelegramUserAllowed({
      userId: from.id,
      chatId: chat.id,
      configUserIds: this.config.telegram.allowlist.userIds,
      configChatIds: this.config.telegram.allowlist.chatIds,
      stateUsers,
      stateChats
    });
  }

  private async isAllowlistEmpty(): Promise<boolean> {
    const stateUsers = await this.state.listTelegramUsers();
    return this.config.telegram.allowlist.userIds.length === 0 && stateUsers.length === 0;
  }

  private async opsChatId(): Promise<number | undefined> {
    if (this.config.telegram.opsChatId) return this.config.telegram.opsChatId;
    const chats = await this.state.listTelegramChats();
    if (chats[0]) return chats[0].chatId;
    if (this.config.telegram.allowlist.chatIds[0]) return this.config.telegram.allowlist.chatIds[0];
    return undefined;
  }

  private async logDenied(ctx: Context): Promise<void> {
    this.logger.warn({
      component: "telegram",
      event: "denied",
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      username: ctx.from?.username
    }, "denied Telegram message");
    await this.state.recordMessage({
      direction: "denied",
      userId: ctx.from?.id,
      chatId: ctx.chat?.id,
      username: ctx.from?.username,
      receivedAt: nowIso()
    });
  }

  private async loadOrCreatePairingCode(): Promise<string> {
    const existing = await this.state.readPairingCode();
    if (existing) {
      this.logger.info({ component: "telegram", event: "pairing_code_reused" }, "Reusing persisted pairing code");
      return existing;
    }
    const code = makePairingCode();
    await this.state.writePairingCode(code);
    return code;
  }
}
