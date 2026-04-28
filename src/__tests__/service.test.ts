import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { injectFilePath, INJECT_TELEGRAM_USER_ID, ServiceSupervisor } from "../service.js";
import type { CodexEvent, UserEvent } from "../types.js";

const tempDirs: string[] = [];

async function loadTestConfig(transport = "app-server") {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-service-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "test behavior\n");
  await writeFile(join(root, "directives.md"), "");
  await writeFile(join(root, "loops.json"), JSON.stringify({ version: 1, defaults: {}, loops: [] }));
  await writeFile(join(root, "monitors.json"), JSON.stringify({ version: 1, monitors: [] }));
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[codex]
transport = "${transport}"
startupTimeoutSec = 1
turnTimeoutSec = 1

[behavior]
dir = "."
entrypoint = "AGENTS.md"

[loops]
enabled = false
path = "loops.json"

[monitors]
enabled = false
path = "monitors.json"

[transcription]
enabled = false
`);
  return loadConfig(join(configDir, "codex-chat.toml"));
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

function userEvent(messageId: number, text = `message ${messageId}`): UserEvent {
  return {
    source: "telegram",
    chatId: 253768951,
    userId: 253768951,
    messageId,
    text,
    attachments: [],
    receivedAt: new Date().toISOString()
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("service supervisor", () => {
  test("rejects non-app-server transport at startup", async () => {
    const config = await loadTestConfig("exec-resume");
    const logger = createLogger("silent");

    expect(() => new ServiceSupervisor(config, logger)).toThrow("exec-resume transport is disabled. Only app-server (OAuth) is supported. Run 'codex login' to authenticate.");
  });

  test("polls inject.json, queues a synthetic Telegram message, and deletes the file", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const enqueue = vi.spyOn(service, "enqueueUserEvent").mockResolvedValue();
    const path = injectFilePath(config);
    await writeFile(path, JSON.stringify({ text: "ping test" }));

    await (service as unknown as { pollInjectFile(): Promise<void> }).pollInjectFile();

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      chatId: INJECT_TELEGRAM_USER_ID,
      userId: INJECT_TELEGRAM_USER_ID,
      username: "tim",
      text: "ping test",
      attachments: []
    }));
    await expect(access(path)).rejects.toThrow();
    const day = new Date().toISOString().slice(0, 10);
    const messages = await readFile(join(config.rootDir, "state", "messages", `${day}.jsonl`), "utf8");
    expect(messages).toContain("ping test");
    expect(messages).toContain("\"injected\":true");
  });

  test("notifies Telegram users about abandoned running turns after restart", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    await service.state.writeJson("turns/turn_old.json", {
      id: "turn_old",
      status: "running",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      input: {
        source: "telegram",
        chatId: 253768951,
        userId: 253768951,
        messageId: 123,
        text: "hi",
        attachments: [],
        receivedAt: new Date().toISOString()
      }
    });

    await (service as unknown as { abandonStuckTurns(): Promise<void> }).abandonStuckTurns();

    expect(sendText).toHaveBeenCalledWith(253768951, "⚠️ Service was restarted. Please resend your message.", 123);
    const turn = JSON.parse(await readFile(join(config.rootDir, "state", "turns", "turn_old.json"), "utf8")) as { status: string };
    expect(turn.status).toBe("abandoned");
  });

  test("persists queued Telegram events and notifies on restart recovery", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    await service.state.writeJson("queued_turns/queued_old.json", {
      id: "queued_old",
      queuedAt: new Date().toISOString(),
      event: {
        source: "telegram",
        chatId: 253768951,
        userId: 253768951,
        messageId: 124,
        text: "queued",
        attachments: [],
        receivedAt: new Date().toISOString()
      }
    });

    await (service as unknown as { abandonQueuedTurns(): Promise<void> }).abandonQueuedTurns();

    expect(sendText).toHaveBeenCalledWith(253768951, "⚠️ Service was restarted. Please resend your message.", 124);
    await expect(access(join(config.rootDir, "state", "queued_turns", "queued_old.json"))).rejects.toThrow();
  });

  test("drops the oldest queued message on per-chat queue overflow and notifies the user", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const firstTurn = deferred();
    vi.spyOn(service as unknown as { processEvent(event: UserEvent): Promise<void> }, "processEvent").mockReturnValue(firstTurn.promise);
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();

    await service.enqueueUserEvent(userEvent(1, "active"));
    const firstQueued = userEvent(2, "oldest queued");
    await service.enqueueUserEvent(firstQueued);
    for (let messageId = 3; messageId <= 52; messageId++) {
      await service.enqueueUserEvent(userEvent(messageId));
    }

    expect(sendText).toHaveBeenCalledWith(
      253768951,
      "⚠️ I dropped an older queued message because this chat already has 50 pending messages. Please resend it if still needed.",
      2
    );
    const queue = (service as unknown as { messageQueue: Map<string, Array<{ event: UserEvent }>> }).messageQueue.get("253768951");
    expect(queue).toHaveLength(50);
    expect(queue?.[0]?.event.messageId).toBe(3);
    const persistedId = firstQueued.metadata?.persistedQueueId;
    expect(persistedId).toEqual(expect.any(String));
    await expect(access(join(config.rootDir, "state", "queued_turns", `${persistedId}.json`))).rejects.toThrow();

    (service as unknown as { messageQueue: Map<string, unknown[]> }).messageQueue.clear();
    firstTurn.resolve();
    await flush();
  });

  test("force abort and original turn finalizer do not double-drain queued work", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    vi.spyOn(service.telegram, "notifyOps").mockResolvedValue();
    const firstTurn = deferred();
    const secondTurn = deferred();
    const calls: number[] = [];
    vi.spyOn(service as unknown as { processEvent(event: UserEvent): Promise<void> }, "processEvent").mockImplementation(async (event) => {
      calls.push(event.messageId ?? 0);
      if (event.messageId === 1) await firstTurn.promise;
      if (event.messageId === 2) await secondTurn.promise;
    });

    await service.enqueueUserEvent(userEvent(1));
    await service.enqueueUserEvent(userEvent(2));
    await (service as unknown as { forceAbortStuckTurn(): Promise<void> }).forceAbortStuckTurn();
    await service.enqueueUserEvent(userEvent(3));
    firstTurn.resolve();
    await flush();

    expect(calls).toEqual([1, 2]);

    secondTurn.resolve();
    await flush();
    expect(calls).toEqual([1, 2, 3]);
  });

  test("restartCodex retries with backoff and notifies ops on exhaustion without draining queue", async () => {
    const config = await loadTestConfig();
    // Tighten retry knobs so the test runs fast.
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).maxRestartAttempts = 3;
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).restartBackoffBaseMs = 1;
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).restartBackoffMaxMs = 5;
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();

    vi.spyOn(service.codex, "stop").mockResolvedValue(undefined);
    vi.spyOn(service.codex, "start").mockRejectedValue(new Error("port busy"));
    const notifyOps = vi.spyOn(service.telegram, "notifyOps").mockResolvedValue(undefined);
    const drainSpy = vi.spyOn(service as unknown as { drainQueue(): void }, "drainQueue");

    await (service as unknown as { restartCodex(reason: string): Promise<void> }).restartCodex("test crash");

    // Should not drain when restart never recovered.
    expect(drainSpy).not.toHaveBeenCalled();
    // Should have notified ops at least once with the final exhaustion message.
    const messages = notifyOps.mock.calls.map((call) => call[0] as string);
    expect(messages.some((message) => message.includes("failed to restart after"))).toBe(true);
    expect(messages.some((message) => message.includes("Service is DOWN"))).toBe(true);
  });

  test("restartCodex notifies and drains queue on successful recovery", async () => {
    const config = await loadTestConfig();
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).maxRestartAttempts = 3;
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).restartBackoffBaseMs = 1;
    (config.codex as unknown as { maxRestartAttempts: number; restartBackoffBaseMs: number; restartBackoffMaxMs: number }).restartBackoffMaxMs = 5;
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();

    vi.spyOn(service.codex, "stop").mockResolvedValue(undefined);
    let attempts = 0;
    vi.spyOn(service.codex, "start").mockImplementation(async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("transient");
    });
    vi.spyOn(service.codex, "health").mockResolvedValue({ ok: true, transport: "app-server", sessionId: "thread-x" });
    const notifyOps = vi.spyOn(service.telegram, "notifyOps").mockResolvedValue(undefined);
    const drainSpy = vi.spyOn(service as unknown as { drainQueue(): void }, "drainQueue");

    await (service as unknown as { restartCodex(reason: string): Promise<void> }).restartCodex("test crash");

    expect(attempts).toBe(2);
    expect(drainSpy).toHaveBeenCalled();
    const messages = notifyOps.mock.calls.map((call) => call[0] as string);
    expect(messages.some((message) => message.includes("Codex restarted cleanly"))).toBe(true);
  });

  test("marks turn files as error when processing fails after writing running state", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "hello" };
    });
    vi.spyOn(service.telegram, "sendText").mockRejectedValue(new Error("telegram send failed"));

    await service.enqueueUserEvent(userEvent(1));
    for (let i = 0; i < 20; i++) {
      const running = (service as unknown as { turnRunning: boolean }).turnRunning;
      if (!running) break;
      await flush();
    }

    const files = await readdir(join(config.rootDir, "state", "turns"));
    expect(files).toHaveLength(1);
    const turn = JSON.parse(await readFile(join(config.rootDir, "state", "turns", files[0] as string), "utf8")) as { status: string; errorMessage?: string };
    expect(turn.status).toBe("error");
    expect(turn.errorMessage).toContain("telegram send failed");
  });
});
