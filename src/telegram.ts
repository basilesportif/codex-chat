import { Bot, InputFile, type Context } from "grammy";
import type { Logger } from "pino";
import { AppConfig } from "./config.js";
import { FileStore } from "./file-store.js";
import { StateStore } from "./state.js";
import { Transcriber } from "./transcription.js";
import { Attachment, UserEvent } from "./types.js";
import { chunkText, makePairingCode, nowIso } from "./util.js";

type GrammyContext = Context;

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
    this.bot = new Bot(this.token);
    const emptyAllowlist = await this.isAllowlistEmpty();
    if (emptyAllowlist && this.config.telegram.pairingEnabledOnEmptyAllowlist) {
      this.pairingCode = makePairingCode();
      this.logger.warn({ component: "telegram", event: "pairing_code" }, `Telegram pairing enabled. Send /pair ${this.pairingCode} to the bot.`);
      process.stderr.write(`\nTelegram pairing code: /pair ${this.pairingCode}\n\n`);
    }
    this.registerHandlers(this.bot);
    void this.bot.start({
      onStart: (info) => this.logger.info({ component: "telegram", event: "started", username: info.username }, "Telegram polling started")
    }).catch((error) => this.logger.error({ component: "telegram", event: "polling_failed", error }, "Telegram polling failed"));
  }

  async stop(): Promise<void> {
    await this.bot?.stop();
  }

  async sendText(chatId: number, text: string, replyToMessageId?: number): Promise<void> {
    if (!this.bot) throw new Error("Telegram bot is not started");
    for (const chunk of chunkText(text || "(empty response)")) {
      await this.bot.api.sendMessage(chatId, chunk, {
        parse_mode: this.config.telegram.parseMode === "plain" ? undefined : this.config.telegram.parseMode,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined
      } as never);
      await this.state.recordMessage({ direction: "outbound", chatId, text: chunk, sentAt: nowIso() });
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
    bot.command("pair", async (ctx) => this.handlePair(ctx as GrammyContext));
    bot.command("health", async (ctx) => {
      if (!(await this.isAuthorized(ctx as GrammyContext))) return;
      await ctx.reply(this.callbacks.onHealthCommand ? await this.callbacks.onHealthCommand() : "ok");
    });
    bot.command("jobs", async (ctx) => {
      if (!(await this.isAuthorized(ctx as GrammyContext))) return;
      await ctx.reply(this.callbacks.onJobsCommand ? await this.callbacks.onJobsCommand(ctx.chat.id) : "No job manager is configured.");
    });
    bot.command("cancel", async (ctx) => {
      if (!(await this.isAuthorized(ctx as GrammyContext))) return;
      const jobId = (ctx.message?.text ?? "").split(/\s+/)[1];
      await ctx.reply(jobId && this.callbacks.onCancelCommand ? await this.callbacks.onCancelCommand(ctx.chat.id, jobId) : "Usage: /cancel <jobId>");
    });
    bot.on("message", async (ctx) => this.handleMessage(ctx as GrammyContext));
    bot.catch((error) => this.logger.error({ component: "telegram", event: "handler_error", error }, "Telegram handler failed"));
  }

  private async handlePair(ctx: GrammyContext): Promise<void> {
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
    this.pairingCode = undefined;
    await ctx.reply(`Paired user ${from.id} and chat ${chat.id}.`);
    this.logger.info({ component: "telegram", event: "paired", userId: from.id, chatId: chat.id }, "Telegram user paired");
  }

  private async handleMessage(ctx: GrammyContext): Promise<void> {
    if (ctx.message?.text?.startsWith("/pair")) return;
    if (!(await this.isAuthorized(ctx))) {
      await this.logDenied(ctx);
      return;
    }
    const message = ctx.message;
    if (!message || !ctx.from || !ctx.chat) return;
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
        const transcript = await this.transcriber.transcribe({ path: attachment.localPath, mimeType: attachment.mimeType });
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
        const transcript = await this.transcriber.transcribe({ path: attachment.localPath, mimeType: attachment.mimeType });
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

  private async isAuthorized(ctx: GrammyContext): Promise<boolean> {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || !chat) return false;
    const stateUsers = await this.state.listTelegramUsers();
    const stateChats = await this.state.listTelegramChats();
    const allowedUsers = new Set([...this.config.telegram.allowlist.userIds, ...stateUsers.map((user) => user.userId)]);
    const allowedChats = new Set([...this.config.telegram.allowlist.chatIds, ...stateChats.map((item) => item.chatId)]);
    if (!allowedUsers.has(from.id)) return false;
    return allowedChats.size === 0 || allowedChats.has(chat.id);
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

  private async logDenied(ctx: GrammyContext): Promise<void> {
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
}
