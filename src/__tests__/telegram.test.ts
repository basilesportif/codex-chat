import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Context } from "grammy";
import type { Message } from "grammy/types";
import type { AppConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { decideTelegramAudioTranscription, extractTelegramReplyContext, TelegramGateway } from "../telegram.js";
import type { StateStore } from "../state.js";
import type { FileStore } from "../file-store.js";
import type { Transcriber, TranscribeInput, TranscriptionResult } from "../transcription.js";

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
      saveOutboundMessage: vi.fn().mockResolvedValue(undefined),
      findOutboundMessage: vi.fn().mockResolvedValue(undefined),
      claimEmojiFollowup: vi.fn().mockResolvedValue(true),
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
  test("normalizes an emoji-only exact bot reply but preserves unrelated emoji conversation", async () => {
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const findOutboundMessage = vi.fn().mockImplementation(async (_platform, _chat, messageId) => messageId === "20" ? {
      platform: "telegram", chatId: "100", messageId: "20", content: "Should I archive this file?", sentAt: "now"
    } : undefined);
    const gateway = new TelegramGateway(
      { telegram: { allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] } } } as AppConfig,
      {
        listTelegramUsers: vi.fn().mockResolvedValue([]), listTelegramChats: vi.fn().mockResolvedValue([]),
        recordMessage: vi.fn().mockResolvedValue(undefined), findOutboundMessage,
        claimEmojiFollowup: vi.fn().mockResolvedValue(true)
      } as unknown as StateStore,
      {} as FileStore, {} as Transcriber, createLogger("silent"), { onUserEvent }
    );
    vi.spyOn(gateway, "sendReaction").mockResolvedValue(undefined);

    const messageContext = (messageId: number, replyId?: number) => ({
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      message: {
        message_id: messageId, date: 1, chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" }, text: "✅",
        ...(replyId ? { reply_to_message: { message_id: replyId, date: 1, chat: { id: 100, type: "private", first_name: "Tim" }, from: { id: 7, is_bot: true, first_name: "Bot" }, text: "snippet" } } : {})
      }
    } as Context);

    await (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage(messageContext(21, 20));
    expect(onUserEvent.mock.calls[0]?.[0].text).toContain("[Verified emoji follow-up]");
    expect(onUserEvent.mock.calls[0]?.[0].text).toContain('"Should I archive this file?"');

    await (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage(messageContext(22));
    expect(onUserEvent.mock.calls[1]?.[0].text).toBe("✅");
  });

  test("accepts one attributable Telegram reaction addition on a persisted bot message", async () => {
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const claimEmojiFollowup = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const gateway = new TelegramGateway(
      { telegram: { allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] } } } as AppConfig,
      {
        listTelegramUsers: vi.fn().mockResolvedValue([]), listTelegramChats: vi.fn().mockResolvedValue([]),
        findOutboundMessage: vi.fn().mockResolvedValue({ platform: "telegram", chatId: "100", messageId: "20", content: "Run it?", sentAt: "now" }),
        claimEmojiFollowup
      } as unknown as StateStore,
      {} as FileStore, {} as Transcriber, createLogger("silent"), { onUserEvent }
    );
    const ctx = {
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      messageReaction: {
        chat: { id: 100, type: "private", first_name: "Tim" }, message_id: 20,
        user: { id: 9, is_bot: false, first_name: "Tim", username: "tim" }, date: 1,
        old_reaction: [], new_reaction: [{ type: "emoji", emoji: "👍" }]
      }
    } as unknown as Context;
    const handler = gateway as unknown as { handleMessageReaction(ctx: Context): Promise<void> };
    await handler.handleMessageReaction(ctx);
    await handler.handleMessageReaction(ctx);
    expect(onUserEvent).toHaveBeenCalledTimes(1);
    expect(onUserEvent.mock.calls[0]?.[0].text).toContain("Emoji: 👍");
  });

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

  test("audio transcription decision uses caption, reply, and previous context", () => {
    expect(decideTelegramAudioTranscription({
      caption: "Please diarize this meeting recording",
      isMp3: true
    })).toMatchObject({ mode: "diarize", requestKind: "diarize", requestSource: "caption", shouldAskForContext: false });

    expect(decideTelegramAudioTranscription({
      reply: { replyToMessage: { chatId: 100, messageId: 1, snippet: "Can you transcribe this audio?" } },
      isMp3: true
    })).toMatchObject({ mode: "regular", requestKind: "transcribe", requestSource: "reply", shouldAskForContext: false });

    expect(decideTelegramAudioTranscription({
      previousText: "diarize the next mp3 by speaker",
      isMp3: true
    })).toMatchObject({ mode: "diarize", requestKind: "diarize", requestSource: "previous", shouldAskForContext: false });

    expect(decideTelegramAudioTranscription({
      previousText: "Audio transcript:\nThis was already transcribed.",
      isMp3: true
    })).toMatchObject({ mode: "regular", shouldAskForContext: true });

    expect(decideTelegramAudioTranscription({ isMp3: true })).toMatchObject({
      mode: "regular",
      shouldAskForContext: true
    });
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
      text: "hello",
      actor: expect.objectContaining({ id: "telegram:user:9", surfaceKind: "telegram", handle: "tim" }),
      outputTarget: expect.objectContaining({ surfaceKind: "telegram", chatId: "100", messageId: "77" }),
      conversationKey: expect.objectContaining({ id: "telegram:chat:100" }),
      conversationSessionId: expect.stringMatching(/^session_[0-9a-f]{24}$/),
      correlationId: expect.stringMatching(/^corr_/),
      // Runtime no longer fabricates grants; Brain is the sole grant source (Slack-scoped).
      capabilityGrants: []
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

  test("uses diarize mode for MP3 audio when the previous message requested diarization", async () => {
    const recordMessage = vi.fn().mockResolvedValue(undefined);
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const transcribe = vi.fn(async (input: TranscribeInput): Promise<TranscriptionResult> => ({
      text: "A: Hello.\nB: Hi.",
      mode: input.mode,
      speakerSegments: [
        { id: "seg_1", start: 0, end: 1.2, text: "Hello.", speaker: "A" },
        { id: "seg_2", start: 1.2, end: 2.4, text: "Hi.", speaker: "B" }
      ]
    }));
    const gateway = new TelegramGateway(
      {
        telegram: {
          allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] }
        },
        transcription: { enabled: true }
      } as AppConfig,
      {
        listTelegramUsers: vi.fn().mockResolvedValue([]),
        listTelegramChats: vi.fn().mockResolvedValue([]),
        recordMessage,
        findRecentTelegramInboundMessage: vi.fn().mockResolvedValue({ text: "Please diarize the next MP3 by speaker.", messageId: 20 })
      } as unknown as StateStore,
      {} as FileStore,
      { transcribe } as Transcriber,
      createLogger("silent"),
      { onUserEvent }
    );
    vi.spyOn(gateway, "sendReaction").mockResolvedValue(undefined);
    vi.spyOn(gateway, "sendChatAction").mockResolvedValue(undefined);
    vi.spyOn(gateway as unknown as { downloadTelegramFile(kind: string, fileLike: unknown): Promise<unknown> }, "downloadTelegramFile")
      .mockResolvedValue({ kind: "audio", localPath: "/tmp/meeting.mp3", mimeType: "audio/mpeg", originalName: "meeting.mp3" });

    await (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage({
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      message: {
        message_id: 21,
        date: 1_700_000_100,
        chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
        audio: {
          file_id: "file",
          file_unique_id: "unique",
          duration: 10,
          mime_type: "audio/mpeg",
          file_name: "meeting.mp3"
        }
      }
    } as Context);

    expect(transcribe).toHaveBeenCalledWith({ path: "/tmp/meeting.mp3", mode: "diarize" });
    expect(onUserEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      transcript: "A: Hello.\nB: Hi.",
      metadata: expect.objectContaining({
        telegramAudioTranscriptionMode: "diarize",
        telegramAudioRequestKind: "diarize",
        telegramAudioRequestSource: "previous",
        telegramAudioPath: "/tmp/meeting.mp3"
      }),
      text: expect.stringContaining("Diarized audio transcript:")
    }));
    const text = onUserEvent.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain("Previous Telegram message requested speaker diarization");
    expect(text).toContain("Speaker segments:");
  });

  test("regular MP3 audio without context tells Codex to ask what to do", async () => {
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const transcribe = vi.fn(async (input: TranscribeInput): Promise<TranscriptionResult> => ({
      text: "Uncaptioned meeting notes.",
      mode: input.mode
    }));
    const gateway = new TelegramGateway(
      {
        telegram: {
          allowlist: { userIds: [9], chatIds: [100], adminUserIds: [] }
        },
        transcription: { enabled: true }
      } as AppConfig,
      {
        listTelegramUsers: vi.fn().mockResolvedValue([]),
        listTelegramChats: vi.fn().mockResolvedValue([]),
        recordMessage: vi.fn().mockResolvedValue(undefined),
        findRecentTelegramInboundMessage: vi.fn().mockResolvedValue(undefined)
      } as unknown as StateStore,
      {} as FileStore,
      { transcribe } as Transcriber,
      createLogger("silent"),
      { onUserEvent }
    );
    vi.spyOn(gateway, "sendReaction").mockResolvedValue(undefined);
    vi.spyOn(gateway, "sendChatAction").mockResolvedValue(undefined);
    vi.spyOn(gateway as unknown as { downloadTelegramFile(kind: string, fileLike: unknown): Promise<unknown> }, "downloadTelegramFile")
      .mockResolvedValue({ kind: "audio", localPath: "/tmp/no-context.mp3", mimeType: "audio/mpeg", originalName: "no-context.mp3" });

    await (gateway as unknown as { handleMessage(ctx: Context): Promise<void> }).handleMessage({
      chat: { id: 100, type: "private", first_name: "Tim" },
      from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
      message: {
        message_id: 30,
        date: 1_700_000_100,
        chat: { id: 100, type: "private", first_name: "Tim" },
        from: { id: 9, is_bot: false, first_name: "Tim", username: "tim" },
        audio: {
          file_id: "file",
          file_unique_id: "unique",
          duration: 10,
          mime_type: "audio/mpeg",
          file_name: "no-context.mp3"
        }
      }
    } as Context);

    expect(transcribe).toHaveBeenCalledWith({ path: "/tmp/no-context.mp3", mode: "regular" });
    const text = onUserEvent.mock.calls[0]?.[0]?.text as string;
    expect(text).toContain("MP3 audio arrived without a caption");
    expect(text).toContain("ask Tim what he wants done");
    expect(text).toContain("Do not assume a Soundcore-specific workflow");
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
