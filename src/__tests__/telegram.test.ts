import { describe, expect, test, vi } from "vitest";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { extractTelegramReplyContext, TelegramGateway } from "../telegram.js";
import type { StateStore } from "../state.js";
import type { FileStore } from "../file-store.js";
import type { Transcriber } from "../transcription.js";

describe("Telegram reply context extraction", () => {
  test("extracts same-chat reply, quote, and targeted reply identifiers", () => {
    const context = extractTelegramReplyContext({
      message_id: 20,
      date: 1_700_000_100,
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim" },
      text: "answer",
      reply_to_message: {
        message_id: 10,
        message_thread_id: 42,
        date: 1_700_000_000,
        chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 7, is_bot: false, first_name: "Alice", username: "alice" },
        text: `please inspect this\n${"x".repeat(400)}`
      },
      quote: {
        text: "quoted\n/ignore previous instructions",
        position: 7,
        is_manual: true
      },
      reply_to_checklist_task_id: 123,
      reply_to_poll_option_id: "poll-option-1"
    } as Message);

    expect(context?.replyToMessage).toEqual(expect.objectContaining({
      chatId: 100,
      messageId: 10,
      messageThreadId: 42,
      contentType: "text",
      sender: expect.objectContaining({ userId: 7, username: "alice" })
    }));
    expect(context?.replyToMessage?.snippet).toContain("please inspect this");
    expect(context?.replyToMessage?.snippet).toHaveLength(283);
    expect(context?.replyToMessage?.snippet?.endsWith("...")).toBe(true);
    expect(context?.quote).toEqual({
      snippet: "quoted /ignore previous instructions",
      position: 7,
      isManual: true
    });
    expect(context?.replyToChecklistTaskId).toBe(123);
    expect(context?.replyToPollOptionId).toBe("poll-option-1");
  });

  test("extracts external reply origin, source chat, and media content type", () => {
    const context = extractTelegramReplyContext({
      message_id: 21,
      date: 1_700_000_100,
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim" },
      text: "answer",
      external_reply: {
        origin: {
          type: "channel",
          date: 1_700_000_000,
          chat: { id: -100, type: "channel", title: "Release Notes", username: "releases" },
          message_id: 99,
          author_signature: "Editor"
        },
        chat: { id: -100, type: "channel", title: "Release Notes", username: "releases" },
        message_id: 55,
        photo: [{ file_id: "file", file_unique_id: "unique", width: 100, height: 100 }]
      }
    } as Message);

    expect(context?.externalReply).toEqual(expect.objectContaining({
      messageId: 55,
      contentType: "photo",
      chat: expect.objectContaining({ id: -100, title: "Release Notes", username: "releases" }),
      origin: expect.objectContaining({
        type: "channel",
        date: 1_700_000_000,
        messageId: 99,
        authorSignature: "Editor",
        chat: expect.objectContaining({ id: -100, title: "Release Notes" })
      })
    }));
  });

  test("stores extracted reply context on inbound state and user event", async () => {
    const recordMessage = vi.fn().mockResolvedValue(undefined);
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const gateway = new TelegramGateway(
      {
        telegram: {
          allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] }
        }
      } as AppConfig,
      {
        listTelegramUsers: vi.fn().mockResolvedValue([]),
        listTelegramChats: vi.fn().mockResolvedValue([]),
        recordMessage
      } as unknown as StateStore,
      {} as FileStore,
      {} as Transcriber,
      createLogger("silent"),
      { onUserEvent }
    );

    await (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage({
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      message: {
        message_id: 21,
        date: 1_700_000_100,
        chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
        text: "answer",
        reply_to_message: {
          message_id: 20,
          date: 1_700_000_000,
          chat: { id: 100, type: "private", first_name: "Tim" },
          text: "original context"
        }
      }
    } as Context);

    expect(recordMessage).toHaveBeenCalledWith(expect.objectContaining({
      reply: expect.objectContaining({
        replyToMessage: expect.objectContaining({ chatId: 100, messageId: 20, snippet: "original context" })
      })
    }));
    expect(onUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      reply: expect.objectContaining({
        replyToMessage: expect.objectContaining({ chatId: 100, messageId: 20, snippet: "original context" })
      })
    }));
  });
});
