import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: {
      name: "codex-chat",
      workspace: rootDir,
      stateDir: "state",
      logLevel: "silent",
      timezone: "Etc/UTC",
      ipcSocket: "data/run/codex-chat.sock"
    },
    codex: {
      binary: "codex",
      transport: "app-server",
      appServerHost: "127.0.0.1",
      appServerPort: 49345,
      model: "gpt-test",
      effort: "medium",
      profile: "",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      mainSessionName: "codex-chat-main",
      startupTimeoutSec: 1,
      turnTimeoutSec: 1,
      keepAliveSec: 60,
      extraConfig: [],
      addDirs: []
    }
  } as AppConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("ws");
  delete process.env.OPENAI_API_KEY;
});

describe("codex clients", () => {
  test("exec-resume and hybrid clients are not exported", async () => {
    const codex = await import("../codex.js");

    expect(codex).not.toHaveProperty("ExecResumeCodexClient");
    expect(codex).not.toHaveProperty("HybridCodexClient");
  });

  test("OPENAI_API_KEY is stripped from app-server spawn env", async () => {
    vi.resetModules();
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    vi.doMock("ws", () => {
      class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        readyState = 1;

        constructor(readonly url: string) {
          super();
          queueMicrotask(() => this.emit("open"));
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { id: number; method: string };
          const result = message.method === "thread/start" ? { thread: { id: "thread-test" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
        }
      }
      return { default: FakeWebSocket };
    });
    process.env.OPENAI_API_KEY = "sk-test-should-never-reach-codex";
    process.env.OTHER_VAR = "keep-me";
    const { AppServerCodexClient } = await import("../codex.js");
    const state = {
      getCodexSession: vi.fn().mockResolvedValue(undefined),
      setCodexSession: vi.fn().mockResolvedValue(undefined)
    };
    const behavior = {
      loadBootstrapPrompt: vi.fn().mockResolvedValue("bootstrap"),
      hash: vi.fn().mockResolvedValue("hash")
    };
    const client = new AppServerCodexClient(testConfig("/tmp/codex-chat-test"), state as never, behavior as never, fakeLogger() as never);

    await client.start();

    expect(spawn).toHaveBeenCalledOnce();
    const options = spawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(options.env?.OTHER_VAR).toBe("keep-me");
    await client.stop();
  });
});
