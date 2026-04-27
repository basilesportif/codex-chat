import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { injectFilePath, INJECT_TELEGRAM_USER_ID, ServiceSupervisor } from "../service.js";

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
});
