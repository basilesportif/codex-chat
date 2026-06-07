import type { Logger } from "pino";
import type { TelegramGateway } from "./telegram.js";
import type { StateStore } from "./state.js";
import type { JsonRecord, MessageChannel, MessageOrigin, StoredConversationMessage, UserEvent } from "./types.js";
import { makeId, nowIso } from "./util.js";
import { DEFAULT_LOGICAL_USER_ID, eventOrigin, metadataNumber, telegramConversationKey } from "./origin.js";

export interface ExplicitOutboundTarget {
  channel: MessageChannel;
  logicalUserId?: string;
  conversationKey?: string;
  chatId?: number;
  messageId?: string;
  metadata?: JsonRecord;
}

export type OutboundTarget = MessageOrigin | ExplicitOutboundTarget;

export interface OutboundTextOptions {
  replyToMessageId?: number | string;
  format?: "text" | "markdown" | "markdownv2";
  forceFormatArg?: boolean;
  metadata?: JsonRecord;
}

export class OutboundRouter {
  constructor(
    private readonly state: StateStore,
    private readonly telegram: TelegramGateway,
    private readonly logger: Logger,
    private readonly logicalUserId = DEFAULT_LOGICAL_USER_ID
  ) {}

  async sendText(target: OutboundTarget, text: string, options: OutboundTextOptions = {}): Promise<void> {
    if (target.channel === "telegram") {
      const chatId = this.telegramChatId(target);
      const replyToMessageId = this.telegramReplyToMessageId(options.replyToMessageId);
      if (options.format === undefined && !options.forceFormatArg) await this.telegram.sendText(chatId, text, replyToMessageId);
      else await this.telegram.sendText(chatId, text, replyToMessageId, options.format);
      return;
    }

    await this.persistWebText(target, text, options);
  }

  async sendTextForEvent(event: UserEvent, text: string, options: OutboundTextOptions = {}): Promise<boolean> {
    const origin = eventOrigin(event, this.logicalUserId);
    if (!origin) return false;
    const replyToMessageId = options.replyToMessageId ?? (origin.channel === "telegram" ? event.messageId : origin.messageId);
    await this.sendText(origin, text, { ...options, replyToMessageId });
    return true;
  }

  async sendTelegramText(chatId: number, text: string, options: OutboundTextOptions = {}): Promise<void> {
    await this.sendText({ channel: "telegram", chatId, conversationKey: telegramConversationKey(chatId), logicalUserId: this.logicalUserId }, text, options);
  }

  private telegramChatId(target: OutboundTarget): number {
    const explicit = "chatId" in target ? target.chatId : undefined;
    if (typeof explicit === "number") return explicit;
    const metadataChatId = metadataNumber(target.metadata, "chatId");
    if (metadataChatId !== undefined) return metadataChatId;
    throw new Error("Telegram outbound target requires chatId");
  }

  private telegramReplyToMessageId(value: number | string | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
    return undefined;
  }

  private async persistWebText(target: OutboundTarget, text: string, options: OutboundTextOptions): Promise<void> {
    const conversationKey = target.conversationKey;
    if (!conversationKey) throw new Error(`${target.channel} outbound target requires conversationKey`);
    const sentAt = nowIso();
    const message: StoredConversationMessage = {
      id: makeId("msg"),
      direction: "outbound",
      channel: target.channel,
      logicalUserId: target.logicalUserId ?? this.logicalUserId,
      conversationKey,
      replyToMessageId: options.replyToMessageId !== undefined ? String(options.replyToMessageId) : undefined,
      text: text || "(empty response)",
      sentAt,
      metadata: {
        ...options.metadata,
        format: options.format
      }
    };
    await this.state.recordChannelMessage(message);
    this.logger.debug({ component: "outbound", event: "web_message_recorded", channel: target.channel, conversationKey, messageId: message.id }, "recorded web/API outbound message");
  }
}
