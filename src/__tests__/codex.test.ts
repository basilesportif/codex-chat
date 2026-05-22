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
    },
    transcription: {
      apiKeyEnv: "CUSTOM_TRANSCRIPTION_API_KEY"
    }
  } as AppConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("ws");
  delete process.env.OPENAI_API_KEY;
  delete process.env.CUSTOM_TRANSCRIPTION_API_KEY;
});

describe("codex clients", () => {
  test("exec-resume and hybrid clients are not exported", async () => {
    const codex = await import("../codex.js");

    expect(codex).not.toHaveProperty("ExecResumeCodexClient");
    expect(codex).not.toHaveProperty("HybridCodexClient");
  });

  test("OpenAI and transcription keys are stripped from app-server spawn env", async () => {
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
    process.env.CUSTOM_TRANSCRIPTION_API_KEY = "sk-test-transcription-should-never-reach-codex";
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
    expect(options.env).not.toHaveProperty("CUSTOM_TRANSCRIPTION_API_KEY");
    expect(options.env?.OTHER_VAR).toBe("keep-me");
    await client.stop();
  });

  test("starts Employee threads as non-ephemeral with extended history persistence", async () => {
    vi.resetModules();
    const spawn = vi.fn(() => fakeChild());
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
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
          const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          sent.push({ method: message.method, params: message.params });
          const serviceName = typeof message.params?.serviceName === "string" ? message.params.serviceName : "";
          const result = message.method === "thread/start"
            ? { thread: { id: serviceName.startsWith("codex-chat-employee:") ? "employee-thread" : "main-thread" } }
            : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
        }
      }
      return { default: FakeWebSocket };
    });
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
    const result = await client.startEmployeeThread({
      id: "email-calendar",
      name: "Email/calendar",
      description: "Triage email/calendar context.",
      directory: "/tmp/codex-chat-test/employees/email-calendar",
      profile: "email-calendar",
      model: "gpt-employee",
      effort: "high",
      serviceName: "codex-chat-employee:email-calendar",
      baseInstructions: "base",
      developerInstructions: "dev"
    });

    expect(result.backendThreadId).toBe("employee-thread");
    const employeeStart = sent.find((message) => message.method === "thread/start" && message.params.serviceName === "codex-chat-employee:email-calendar");
    expect(employeeStart?.params).toMatchObject({
      model: "gpt-employee",
      cwd: "/tmp/codex-chat-test/employees/email-calendar",
      serviceName: "codex-chat-employee:email-calendar",
      ephemeral: false,
      persistExtendedHistory: true
    });
    expect((employeeStart?.params.config as Record<string, unknown> | undefined)?.model_reasoning_effort).toBe("high");
    await client.resumeEmployeeThread({
      id: "email-calendar",
      name: "Email/calendar",
      directory: "/tmp/codex-chat-test/employees/email-calendar",
      profile: "email-calendar",
      model: "gpt-employee",
      effort: "high",
      serviceName: "codex-chat-employee:email-calendar",
      baseInstructions: "base",
      developerInstructions: "dev",
      backendThreadId: "employee-thread"
    });
    const employeeResume = sent.find((message) => message.method === "thread/resume" && message.params.threadId === "employee-thread");
    expect(employeeResume?.params).toMatchObject({
      threadId: "employee-thread",
      model: "gpt-employee",
      cwd: "/tmp/codex-chat-test/employees/email-calendar",
      persistExtendedHistory: true
    });
    await client.stop();
  });

  test("does not report a crash while app-server websocket startup is still retrying", async () => {
    vi.resetModules();
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    vi.doMock("ws", () => {
      class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        readyState = 0;

        constructor(readonly url: string) {
          super();
          queueMicrotask(() => {
            const error = new Error("ECONNREFUSED");
            this.emit("error", error);
            this.emit("close");
          });
        }

        send(): void {}

        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { AppServerCodexClient } = await import("../codex.js");
    const state = {
      getCodexSession: vi.fn().mockResolvedValue(undefined),
      setCodexSession: vi.fn().mockResolvedValue(undefined)
    };
    const behavior = {
      loadBootstrapPrompt: vi.fn().mockResolvedValue("bootstrap"),
      hash: vi.fn().mockResolvedValue("hash")
    };
    const onCrash = vi.fn();
    const client = new AppServerCodexClient(testConfig("/tmp/codex-chat-test"), state as never, behavior as never, fakeLogger() as never, onCrash);

    await expect(client.start()).rejects.toThrow("ECONNREFUSED");

    expect(onCrash).not.toHaveBeenCalled();
    await client.stop();
  });

  test("recovers by starting a fresh thread when turn/start reports thread not found", async () => {
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
        turnStartCalls = 0;

        constructor(readonly url: string) {
          super();
          queueMicrotask(() => this.emit("open"));
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { id: number; method: string };
          if (message.method === "turn/start") {
            this.turnStartCalls += 1;
            if (this.turnStartCalls === 1) {
              queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, error: { message: "thread not found" } })));
              return;
            }
            queueMicrotask(() => {
              this.emit("message", JSON.stringify({ id: message.id, result: { turn: { id: "turn-recovered" } } }));
              setTimeout(() => {
                this.emit("message", JSON.stringify({ method: "item/agentMessage/delta", params: { turnId: "turn-recovered", delta: "ok" } }));
                this.emit("message", JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-recovered" } } }));
              }, 0);
            });
            return;
          }
          const result = message.method === "thread/start" ? { thread: { id: "fresh-thread" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
        }
      }
      return { default: FakeWebSocket };
    });
    const { AppServerCodexClient } = await import("../codex.js");
    const state = {
      getCodexSession: vi.fn().mockResolvedValue("stale-thread"),
      setCodexSession: vi.fn().mockResolvedValue(undefined),
      clearCodexSession: vi.fn().mockResolvedValue(undefined)
    };
    const behavior = {
      loadBootstrapPrompt: vi.fn().mockResolvedValue("bootstrap"),
      hash: vi.fn().mockResolvedValue("hash")
    };
    const client = new AppServerCodexClient(testConfig("/tmp/codex-chat-test"), state as never, behavior as never, fakeLogger() as never);

    await client.start();
    const events = [];
    for await (const event of client.sendTurn({ text: "hello" })) events.push(event);

    expect(events).toContainEqual({ type: "final", text: "ok" });
    expect(state.clearCodexSession).toHaveBeenCalledWith("codex-chat-main");
    expect(state.setCodexSession).toHaveBeenCalledWith("codex-chat-main", expect.objectContaining({ sessionId: "fresh-thread" }));
    await client.stop();
  });
});
