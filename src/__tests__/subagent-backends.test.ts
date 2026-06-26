import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { SubagentJob } from "../types.js";

const tempDirs: string[] = [];

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
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
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
      addDirs: [],
      serviceTier: "fast"
    },
    subagents: {
      enabled: true,
      backend: "codex_app_server",
      maxConcurrent: 1,
      defaultModel: "",
      defaultEffort: "medium",
      defaultServiceTier: "fast",
      defaultTimeoutSec: 10,
      maxTimeoutSec: 10,
      maxPromptBytes: 262_144,
      artifactDir: "data/subagents",
      childSocketDir: "data/run/subagents",
      childStartupTimeoutSec: 1,
      childInterruptGraceMs: 50,
      allowedProfiles: [],
      cleanupArtifacts: false
    }
  } as AppConfig;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("ws");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("app-server subagent backend", () => {
  test("starts regular subagents as ephemeral and does not resume them", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-backend-"));
    tempDirs.push(root);
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
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
          const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          sent.push({ method: message.method, params: message.params });
          const result = message.method === "thread/start"
            ? { thread: { id: "subagent-thread" } }
            : message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexAppServerChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_ephemeral000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    const started = await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "fast",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const threadStart = sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      serviceName: "codex-chat-subagent",
      serviceTier: "fast",
      ephemeral: true
    });
    const turnStart = sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ serviceTier: "fast" });
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("features.fast_mode=true");
    expect(args).toContain('service_tier="fast"');
    expect(threadStart?.params).not.toHaveProperty("persistExtendedHistory");
    expect(sent.some((message) => message.method === "thread/resume")).toBe(false);
    expect(job.backendThreadId).toBe("subagent-thread");
    await started.kill("SIGTERM");
    await backend.shutdown();
  });

  test("does not accept a stale websocket if the spawned subagent app-server exits during startup", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-backend-"));
    tempDirs.push(root);
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
      return child;
    });
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
          const result = message.method === "thread/start"
            ? { thread: { id: "stale-subagent-thread" } }
            : message.method === "turn/start" ? { turn: { id: "turn-stale" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexAppServerChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_stale0000000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    await expect(backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow(/exited during startup/);

    expect(job.backendThreadId).toBeUndefined();
    await backend.shutdown();
  });
});

describe("codex exec subagent backend", () => {
  test("skips Codex git repo checks for private assistant workspaces", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    const child = fakeChild() as ReturnType<typeof fakeChild> & {
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    child.stdin = { end: vi.fn() };
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_exec0000000000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    expect(spawn).toHaveBeenCalledOnce();
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--skip-git-repo-check");
    expect(args.indexOf("--skip-git-repo-check")).toBeLessThan(args.indexOf("--cd"));
    await backend.shutdown();
  });

  test("adds Codex Fast config for fast codex_exec subagents", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    const child = fakeChild() as ReturnType<typeof fakeChild> & {
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    child.stdin = { end: vi.fn() };
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_execfast0000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root,
      serviceTier: "fast"
    };

    await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "fast",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("features.fast_mode=true");
    expect(args).toContain('service_tier="fast"');
    await backend.shutdown();
  });

});
