import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiGateway } from "../api.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";
import type { UserEvent } from "../types.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function loadApiConfig(extraApi = ""): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-api-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, "codex-chat.toml");
  await writeFile(path, `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[api]
enabled = true
host = "127.0.0.1"
port = 0
tokenEnv = "CODEX_CHAT_API_TOKEN"
${extraApi}

[loops]
enabled = false

[monitors]
enabled = false

[transcription]
enabled = false
`);
  return loadConfig(path);
}

beforeEach(() => {
  process.env = { ...originalEnv, CODEX_CHAT_API_TOKEN: "test-token" };
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local HTTP API gateway", () => {
  test("requires bearer auth and persists/polls web messages", async () => {
    const config = await loadApiConfig();
    const state = new StateStore(config);
    await state.init();
    const events: UserEvent[] = [];
    const gateway = new ApiGateway(config, state, createLogger("silent"), {
      onUserEvent: async (event) => {
        events.push(event);
      }
    });
    await gateway.start();
    try {
      const base = `http://127.0.0.1:${gateway.address()?.port}`;
      const unauthorized = await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" });
      expect(unauthorized.status).toBe(401);

      const accepted = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json"
        },
        body: JSON.stringify({ text: "hello from web", conversationKey: "web:default", clientMessageId: "client-1" })
      });
      expect(accepted.status).toBe(202);
      const body = await accepted.json() as { accepted: boolean; conversationKey: string; messageId: string; status: string };
      expect(body).toMatchObject({ accepted: true, conversationKey: "web:default", status: "queued" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        source: "web",
        text: "hello from web",
        origin: { channel: "web", logicalUserId: "tim", conversationKey: "web:default" }
      });

      const messages = await fetch(`${base}/v1/conversations/${encodeURIComponent("web:default")}/messages`, {
        headers: { authorization: "Bearer test-token" }
      });
      expect(messages.status).toBe(200);
      const listed = await messages.json() as { messages: Array<{ direction: string; text: string; conversationKey: string }> };
      expect(listed.messages).toHaveLength(1);
      expect(listed.messages[0]).toMatchObject({ direction: "inbound", text: "hello from web", conversationKey: "web:default" });
    } finally {
      await gateway.stop();
    }
  });

  test("HTTP idempotency prevents duplicate enqueue", async () => {
    const config = await loadApiConfig();
    const state = new StateStore(config);
    await state.init();
    const onUserEvent = vi.fn().mockResolvedValue(undefined);
    const gateway = new ApiGateway(config, state, createLogger("silent"), { onUserEvent });
    await gateway.start();
    try {
      const base = `http://127.0.0.1:${gateway.address()?.port}`;
      const request = {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
          "idempotency-key": "idem-1"
        },
        body: JSON.stringify({ text: "only once", conversationKey: "web:idem" })
      };
      const first = await fetch(`${base}/v1/messages`, request);
      const firstBody = await first.json() as { messageId: string; duplicate?: boolean };
      const second = await fetch(`${base}/v1/messages`, request);
      const secondBody = await second.json() as { messageId: string; duplicate?: boolean };

      expect(first.status).toBe(202);
      expect(second.status).toBe(200);
      expect(secondBody).toMatchObject({ messageId: firstBody.messageId, duplicate: true });
      expect(onUserEvent).toHaveBeenCalledTimes(1);
      const rows = await state.listConversationMessages("web:idem");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.text).toBe("only once");
    } finally {
      await gateway.stop();
    }
  });

  test("refuses non-loopback bind unless explicitly allowed", async () => {
    const config = await loadApiConfig();
    config.api.host = "0.0.0.0";
    const state = new StateStore(config);
    await state.init();
    const gateway = new ApiGateway(config, state, createLogger("silent"), { onUserEvent: vi.fn() });

    await expect(gateway.start()).rejects.toThrow(/Refusing to bind/);
  });
});
