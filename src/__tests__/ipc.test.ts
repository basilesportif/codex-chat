import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createLogger } from "../logger.js";
import {
  ensureIpcToken,
  ipcTokenPath,
  LocalIpcServer,
  readIpcToken,
  sendIpcMessage,
  type IpcResponse,
  type IpcMessage,
} from "../ipc.js";

const tempDirs: string[] = [];
const servers: LocalIpcServer[] = [];
const logger = createLogger("silent");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer(handler: (message: IpcMessage) => Promise<unknown>): Promise<{ socketPath: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-ipc-"));
  tempDirs.push(root);
  const socketPath = join(root, "run", "codex-chat.sock");
  const server = new LocalIpcServer(socketPath, logger, handler);
  await server.start();
  servers.push(server);
  const token = (await readIpcToken(socketPath)) ?? "";
  return { socketPath, token };
}

async function sendRawIpcLine(socketPath: string, line: string): Promise<IpcResponse> {
  return new Promise<IpcResponse>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC raw request timed out"));
    }, 1000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${line}\n`);
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(chunk.toString().trim()) as IpcResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("LocalIpcServer token authentication", () => {
  test("generates a 0600 token file next to the socket and restricts the socket", async () => {
    const { socketPath, token } = await startServer(async () => ({ pong: true }));
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const tokenInfo = await stat(ipcTokenPath(socketPath));
    expect(tokenInfo.mode & 0o777).toBe(0o600);
    const socketInfo = await stat(socketPath);
    expect(socketInfo.mode & 0o777).toBe(0o600);
  });

  test("ping is accepted without a token", async () => {
    const { socketPath } = await startServer(async (message) => ({ echo: message.type }));
    await expect(sendIpcMessage(socketPath, { type: "ping" })).resolves.toEqual({ echo: "ping" });
  });

  test("mutating commands are rejected without or with a wrong token", async () => {
    const { socketPath } = await startServer(async () => ({ ok: true }));
    await expect(
      sendRawIpcLine(socketPath, JSON.stringify({ type: "employee_start", employeeId: "x" })),
    ).resolves.toEqual({ ok: false, error: "unauthorized: valid IPC token required", code: "unauthorized" });
    await expect(
      sendIpcMessage(socketPath, { type: "employee_start", employeeId: "x" }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      sendIpcMessage(socketPath, { type: "employee_start", employeeId: "x", token: "wrong" }),
    ).rejects.toThrow(/unauthorized/);
  });

  test("mutating commands succeed with the correct token", async () => {
    const received: IpcMessage[] = [];
    const { socketPath, token } = await startServer(async (message) => {
      received.push(message);
      return { started: true };
    });
    await expect(
      sendIpcMessage(socketPath, { type: "employee_start", employeeId: "x", token }),
    ).resolves.toEqual({ started: true });
    expect(received).toHaveLength(1);
  });

  test("set_config requires the token and reaches the handler when authenticated", async () => {
    const seen: Array<Record<string, string>> = [];
    const { socketPath, token } = await startServer(async (message) => {
      if (message.type === "set_config") {
        seen.push(message.entries);
        return { ok: true, restartRequired: true };
      }
      return undefined;
    });
    await expect(
      sendIpcMessage(socketPath, { type: "set_config", entries: { CODEX_CHAT_CODEX_MODEL: "gpt-5.5" } }),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      sendIpcMessage(socketPath, { type: "set_config", entries: { CODEX_CHAT_CODEX_MODEL: "gpt-5.5" }, token }),
    ).resolves.toEqual({ ok: true, restartRequired: true });
    expect(seen).toEqual([{ CODEX_CHAT_CODEX_MODEL: "gpt-5.5" }]);
  });

  test("rejects malformed and non-object JSON lines without an unhandled rejection", async () => {
    const { socketPath } = await startServer(async () => ({ ok: true }));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const line of ["null", JSON.stringify("str"), "[1]", "{not-json"]) {
        await expect(sendRawIpcLine(socketPath, line)).resolves.toEqual({ ok: false, error: "invalid IPC message" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      await expect(sendIpcMessage(socketPath, { type: "ping" })).resolves.toEqual({ ok: true });
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("ensureIpcToken / readIpcToken", () => {
  test("ensureIpcToken is idempotent and readIpcToken returns undefined when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-ipc-token-"));
    tempDirs.push(root);
    const socketPath = join(root, "run", "codex-chat.sock");
    expect(await readIpcToken(socketPath)).toBeUndefined();
    const first = await ensureIpcToken(socketPath);
    const second = await ensureIpcToken(socketPath);
    expect(first).toBe(second);
    expect(await readIpcToken(socketPath)).toBe(first);
  });
});
