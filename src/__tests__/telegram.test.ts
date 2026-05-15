import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { extractTelegramReplyContext, TelegramGateway } from "../telegram.js";
import type { StateStore } from "../state.js";
import type { FileStore } from "../file-store.js";
import type { Transcriber } from "../transcription.js";

function testGateway(overrides: { state?: Partial<StateStore>; files?: Partial<FileStore>; config?: Partial<AppConfig> } = {}): TelegramGateway {
  return new TelegramGateway(
    {
      telegram: {
        allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] }
      },
      ...overrides.config
    } as AppConfig,
    {
      listTelegramUsers: vi.fn().mockResolvedValue([]),
      listTelegramChats: vi.fn().mockResolvedValue([]),
      recordMessage: vi.fn().mockResolvedValue(undefined),
      ...overrides.state
    } as unknown as StateStore,
    {
      validateSendPath: vi.fn((path: string) => path),
      ...overrides.files
    } as unknown as FileStore,
    {} as Transcriber,
    createLogger("silent"),
    { onUserEvent: vi.fn() }
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

  test("fires immediate receipt reaction before recording and queueing the user event", async () => {
    const recordGate = deferred();
    const recordMessage = vi.fn().mockImplementation(async () => {
      await recordGate.promise;
    });
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

    const reactions: Array<{ chatId: number; messageId: number; emoji: string }> = [];
    vi.spyOn(gateway, "sendReaction").mockImplementation(async (chatId, messageId, emoji) => {
      reactions.push({ chatId, messageId, emoji });
    });

    const handlePromise = (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage({
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      message: {
        message_id: 77,
        date: 1_700_000_100,
        chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
        text: "hello"
      }
    } as Context);

    await flush();

    expect(reactions).toEqual([{ chatId: 100, messageId: 77, emoji: "👀" }]);
    expect(recordMessage).toHaveBeenCalledTimes(1);
    expect(onUserEvent).not.toHaveBeenCalled();

    recordGate.resolve();
    await handlePromise;

    expect(onUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      chatId: 100,
      messageId: 77,
      text: "hello"
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

  test("sendText retries unthreaded when Telegram cannot find the reply target", async () => {
    const recordMessage = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn()
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: message to be replied not found" })
      .mockResolvedValueOnce({});
    const gateway = testGateway({ state: { recordMessage } });
    (gateway as unknown as { bot: { api: { sendMessage: typeof sendMessage } } }).bot = { api: { sendMessage } };

    await gateway.sendText(100, "hello", 20, "text");

    expect(sendMessage).toHaveBeenNthCalledWith(1, 100, "hello", expect.objectContaining({
      reply_parameters: { message_id: 20 }
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, 100, "hello", expect.objectContaining({
      reply_parameters: undefined
    }));
    expect(recordMessage).toHaveBeenCalledTimes(1);
  });

  test("sendDocument retries unthreaded when Telegram cannot find the reply target", async () => {
    const sendDocument = vi.fn()
      .mockRejectedValueOnce({ error_code: 400, description: "Bad Request: replied message not found" })
      .mockResolvedValueOnce({});
    const gateway = testGateway();
    (gateway as unknown as { bot: { api: { sendDocument: typeof sendDocument } } }).bot = { api: { sendDocument } };

    await gateway.sendDocument(100, { path: "/tmp/report.txt", caption: "report", replyToMessageId: 20 });

    expect(sendDocument).toHaveBeenNthCalledWith(1, 100, expect.anything(), expect.objectContaining({
      caption: "report",
      reply_parameters: { message_id: 20 }
    }));
    expect(sendDocument).toHaveBeenNthCalledWith(2, 100, expect.anything(), expect.objectContaining({
      caption: "report",
      reply_parameters: undefined
    }));
  });

  test("sendImage deletes local path after a successful send when requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-chat-image-"));
    const imagePath = join(dir, "image.png");
    await writeFile(imagePath, Buffer.from("fake image"));
    const sendPhoto = vi.fn().mockResolvedValue({});
    const gateway = testGateway();
    (gateway as unknown as { bot: { api: { sendPhoto: typeof sendPhoto } } }).bot = { api: { sendPhoto } };

    try {
      await gateway.sendImage(100, { path: imagePath, caption: "generated", deleteAfterSend: true });

      expect(sendPhoto).toHaveBeenCalledTimes(1);
      await expect(stat(imagePath)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sendImage keeps local path when the send fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-chat-image-"));
    const imagePath = join(dir, "image.png");
    await writeFile(imagePath, Buffer.from("fake image"));
    const sendPhoto = vi.fn().mockRejectedValue(new Error("upload failed"));
    const gateway = testGateway();
    (gateway as unknown as { bot: { api: { sendPhoto: typeof sendPhoto } } }).bot = { api: { sendPhoto } };

    try {
      await expect(gateway.sendImage(100, { path: imagePath, deleteAfterSend: true })).rejects.toThrow("upload failed");

      await expect(stat(imagePath)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
