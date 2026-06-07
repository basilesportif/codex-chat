import type { AppConfig } from "./config.js";
import type { JsonRecord, MessageChannel, MessageOrigin, UserEvent } from "./types.js";

export const DEFAULT_LOGICAL_USER_ID = "tim";

export function configuredLogicalUserId(config: Pick<AppConfig, "api"> | undefined): string {
  return config?.api?.logicalUserId || DEFAULT_LOGICAL_USER_ID;
}

export function telegramConversationKey(chatId: number): string {
  return `telegram:${chatId}`;
}

export function originForTelegram(input: {
  chatId: number;
  userId?: number;
  username?: string;
  messageId?: number;
  logicalUserId?: string;
  metadata?: JsonRecord;
}): MessageOrigin {
  return {
    channel: "telegram",
    logicalUserId: input.logicalUserId ?? DEFAULT_LOGICAL_USER_ID,
    conversationKey: telegramConversationKey(input.chatId),
    messageId: input.messageId !== undefined ? String(input.messageId) : undefined,
    replyToMessageId: input.messageId !== undefined ? String(input.messageId) : undefined,
    metadata: {
      ...input.metadata,
      chatId: input.chatId,
      userId: input.userId,
      username: input.username
    }
  };
}

export function originForChannel(input: {
  channel: Exclude<MessageChannel, "telegram">;
  conversationKey: string;
  logicalUserId?: string;
  messageId?: string;
  replyToMessageId?: string;
  metadata?: JsonRecord;
}): MessageOrigin {
  return {
    channel: input.channel,
    logicalUserId: input.logicalUserId ?? DEFAULT_LOGICAL_USER_ID,
    conversationKey: input.conversationKey,
    messageId: input.messageId,
    replyToMessageId: input.replyToMessageId,
    metadata: input.metadata
  };
}

export function eventOrigin(event: UserEvent, logicalUserId = DEFAULT_LOGICAL_USER_ID): MessageOrigin | undefined {
  if (event.origin) return event.origin;
  if (event.chatId !== undefined) {
    return originForTelegram({
      chatId: event.chatId,
      userId: event.userId,
      username: event.username,
      messageId: event.messageId,
      logicalUserId,
      metadata: event.metadata
    });
  }
  return undefined;
}

export function eventConversationKey(event: UserEvent): string | undefined {
  return event.origin?.conversationKey ?? (event.chatId !== undefined ? String(event.chatId) : undefined);
}

export function metadataNumber(metadata: JsonRecord | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
