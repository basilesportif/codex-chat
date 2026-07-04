import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as realSetImmediate } from "node:timers";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { SubagentJob } from "../types.js";
import type { ChildAgentBackend, ChildAgentFinish, StartChildAgentInput, StartedChildAgent } from "../subagent-backends.js";

const tempDirs: string[] = [];

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function makeConfig(rootDir: string, maxConcurrent = 2): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { workspace: rootDir, stateDir: "state" },
    codex: {
      binary: "/bin/true",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      profile: "",
      modelProvider: "",
      serviceTierMode: "auto",
      providerApiKeyEnvNames: ["OPENROUTER_API_KEY"],
      model: "gpt-test",
      extraConfig: [],
      serviceTier: "fast"
    },
    subagents: {
      enabled: true,
      backend: "codex_exec",
      maxConcurrent,
      defaultModel: "",
      defaultEffort: "medium",
      defaultServiceTier: "fast",
      defaultCodexProfile: "",
      defaultModelProvider: "",
      serviceTierMode: "auto",
      allowProviderOverride: false,
      allowedCodexProfiles: [],
      allowedModelProviders: [],
      defaultTimeoutSec: 60,
      maxTimeoutSec: 60,
      maxPromptBytes: 1_000_000,
      artifactDir: "data/subagents",
      childSocketDir: "data/run/subagents",
      childStartupTimeoutSec: 60,
      childInterruptGraceMs: 5000,
      allowedProfiles: [],
      cleanupArtifacts: false
    }
  } as AppConfig;
}

function fakeBackend(kind: "codex_exec" | "codex_app_server" | "claude_agent_sdk", options: { activeTurnId?: string; alive?: boolean } = {}) {
  let resolveFinish!: (finish: ChildAgentFinish) => void;
  const starts: StartChildAgentInput[] = [];
  const finished = new Promise<ChildAgentFinish>((resolve) => {
    resolveFinish = resolve;
  });
  const backend = {
    kind,
    start: vi.fn(async (input: StartChildAgentInput): Promise<StartedChildAgent> => {
      starts.push(input);
      input.job.pid = 1234;
      if (options.activeTurnId) {
        input.job.backendThreadId = "thread_1";
        input.job.activeTurnId = options.activeTurnId;
      }
      await input.onJobUpdated(input.job);
      return {
        kind,
        finished,
        kill: vi.fn(async () => undefined),
        isAlive: () => options.alive !== false
      };
    }),
    steer: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    starts,
    finish: (finish: ChildAgentFinish = { code: 0, signal: null }) => resolveFinish(finish)
  } satisfies ChildAgentBackend & { starts: StartChildAgentInput[]; finish(finish?: ChildAgentFinish): void };
  return backend;
}

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function flushUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("ws");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("subagents", () => {
  test("does not exceed maxConcurrent under bursty parallel dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 2);
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    // Fire 5 dispatches in parallel — only 2 should be running concurrently.
    await Promise.all([
      manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main" }),
      manager.dispatch({ profile: "x", prompt: "b", route: "return_to_main" }),
      manager.dispatch({ profile: "x", prompt: "c", route: "return_to_main" }),
      manager.dispatch({ profile: "x", prompt: "d", route: "return_to_main" }),
      manager.dispatch({ profile: "x", prompt: "e", route: "return_to_main" })
    ]);

    // Wait for any pending microtasks/drains.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(spawn.mock.calls.length).toBeLessThanOrEqual(2);
  });


  test("stores selected model, effort, and summary on queued job", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main", model: "gpt-5.5", effort: "xhigh", serviceTier: "fast", summary: "test task" });

    const saved = state.saveJob.mock.calls[0]?.[0];
    expect(saved).toMatchObject({ model: "gpt-5.5", effort: "xhigh", serviceTier: "fast", summary: "test task", status: "queued" });
    expect(manager.listJobs()[0]).toMatchObject({ model: "gpt-5.5", effort: "xhigh", serviceTier: "fast", summary: "test task" });
  });



  test("records allowed per-dispatch Codex profile and model provider overrides", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    config.subagents.allowProviderOverride = true;
    config.subagents.allowedCodexProfiles = ["openrouter"];
    config.subagents.allowedModelProviders = ["openrouter"];
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({
      profile: "x",
      prompt: "a",
      route: "return_to_main",
      model: "anthropic/claude-sonnet-4.5",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "omit",
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      summary: "openrouter task"
    });

    expect(state.saveJob.mock.calls[0]?.[0]).toMatchObject({
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      serviceTierMode: "omit",
      model: "anthropic/claude-sonnet-4.5",
      status: "queued"
    });
  });

  test("rejects per-dispatch provider overrides unless enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await expect(manager.dispatch({
      profile: "x",
      prompt: "a",
      route: "return_to_main",
      codexProfile: "openrouter"
    })).rejects.toThrow(/codexProfile override is not enabled/);
  });

  test("records owner and result metadata with compatible main defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main" });

    expect(state.saveJob.mock.calls[0]?.[0]).toMatchObject({
      ownerType: "main",
      ownerId: "main",
      resultTarget: "main",
      status: "queued"
    });
    expect(manager.listJobs()[0]).toMatchObject({ ownerType: "main", ownerId: "main", resultTarget: "main" });
  });

  test("routes Employee child terminal results back to the Employee callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const onReturnToMain = vi.fn().mockResolvedValue(undefined);
    const onReturnToEmployee = vi.fn().mockResolvedValue(undefined);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain, onSendToUser: vi.fn(), onReturnToEmployee }
    );

    const id = await manager.dispatch({
      profile: "researcher",
      prompt: "child work",
      route: "return_to_main",
      ownerType: "employee",
      ownerId: "email-calendar",
      ownerRequestId: "req-1",
      parentTurnId: "turn-employee",
      resultTarget: "employee"
    });
    await waitFor(() => children.length === 1);
    const job = manager.listJobs()[0]!;
    await writeFile(join(job.artifactDir, "last-message.md"), "child result");
    children[0]!.emit("exit", 0, null);
    await waitFor(() => onReturnToEmployee.mock.calls.length === 1);

    expect(onReturnToMain).not.toHaveBeenCalled();
    expect(onReturnToEmployee).toHaveBeenCalledWith(
      expect.objectContaining({ id, ownerType: "employee", ownerId: "email-calendar", ownerRequestId: "req-1", resultTarget: "employee", status: "completed" }),
      "child result"
    );
  });

  test("Employee actors can cancel or steer only their own child jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const manager = new SubagentManager(
      makeConfig(root, 0),
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );
    manager.addJobs([
      { id: "job_aaaa0000000000000000000000000000", profile: "researcher", route: "return_to_main", ownerType: "employee", ownerId: "employee-a", resultTarget: "employee", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_bbbb0000000000000000000000000000", profile: "debugger", route: "return_to_main", ownerType: "employee", ownerId: "employee-b", resultTarget: "employee", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a", backend: "codex_exec" }
    ]);

    await expect(manager.requestCancel("aaaa", { actor: { ownerType: "employee", ownerId: "employee-b" } }))
      .resolves.toMatchObject({ status: "forbidden", job: { id: "job_aaaa0000000000000000000000000000" } });
    await expect(manager.requestCancel("aaaa", { actor: { ownerType: "employee", ownerId: "employee-a" } }))
      .resolves.toMatchObject({ status: "success", job: { status: "cancelled" } });
    await expect(manager.steerJob("bbbb", "status", { actor: { ownerType: "employee", ownerId: "employee-a" } }))
      .resolves.toMatchObject({ status: "forbidden" });
    await expect(manager.steerJob("bbbb", "status", { actor: { ownerType: "employee", ownerId: "employee-b" } }))
      .resolves.toMatchObject({ status: "unsupported_backend" });
  });

  test("adds remote repo authority rules to subagent prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({ profile: "x", prompt: "verify dev server path", route: "return_to_main" });
    for (let i = 0; i < 20 && children.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const prompt = children[0]!.stdin.end.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Remote repo authority:");
    expect(prompt).toContain("/home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml");
    expect(prompt).toContain("ssh <host>");
    expect(prompt).toContain(".claude/repo-registry/repos/<alias>");
    expect(prompt).toContain("Do not print or inspect secret values");
  });

  test("rejects new dispatch when queue depth is exhausted", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    // Stuff the internal queue past MAX_QUEUE_DEPTH (200) directly so we
    // don't have to await 200 dispatch starts that all spawn.
    const internalQueue = (manager as unknown as { queue: unknown[] }).queue;
    for (let i = 0; i < 200; i++) internalQueue.push({ id: `x_${i}`, profile: "x", prompt: "p", route: "return_to_main" });

    await expect(manager.dispatch({ profile: "x", prompt: "overflow", route: "return_to_main" }))
      .rejects.toThrow(/Subagent dispatch queue is full/);
  });

  test("subagent effort override wins over codex.extraConfig", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    config.codex.extraConfig = ['model_reasoning_effort="medium"', 'experimental_feature="on"'];
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main", effort: "xhigh" });
    await waitFor(() => spawn.mock.calls.length === 1);

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('experimental_feature="on"');
    expect(args.filter((arg) => arg.includes("model_reasoning_effort"))).toEqual(['model_reasoning_effort="xhigh"']);
  });

  test("uses codex_exec backend by default and records it on jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main" });
    await waitFor(() => spawn.mock.calls.length === 1);

    expect(spawn.mock.calls[0]?.[1]?.[0]).toBe("exec");
    expect(manager.listJobs()[0]).toMatchObject({ backend: "codex_exec", status: "running" });
  });

  test("codex_app_server backend ignores closed startup probe websockets", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      child.pid = 99999999;
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killed = true;
        child.signalCode = signal ?? null;
        queueMicrotask(() => child.emit("exit", null, signal ?? null));
        return true;
      });
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });

    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 0;
      readonly sent: unknown[] = [];

      constructor(readonly url: string) {
        super();
        sockets.push(this);
        const attempt = sockets.length;
        queueMicrotask(() => {
          if (attempt === 1) {
            this.emit("error", new Error("ECONNREFUSED"));
            this.readyState = 3;
            this.emit("close");
            return;
          }
          this.readyState = FakeWebSocket.OPEN;
          this.emit("open");
        });
      }

      send(data: string): void {
        const message = JSON.parse(data) as { id: number; method: string };
        this.sent.push(message);
        queueMicrotask(() => {
          if (message.method === "initialize") {
            this.emit("message", JSON.stringify({ id: message.id, result: {} }));
          } else if (message.method === "thread/start") {
            this.emit("message", JSON.stringify({ id: message.id, result: { thread: { id: "thread_1" } } }));
          } else if (message.method === "turn/start") {
            this.emit("message", JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } }));
          }
        });
      }

      close(): void {
        this.readyState = 3;
        this.emit("close");
      }
    }
    vi.doMock("ws", () => ({ default: FakeWebSocket }));

    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const config = makeConfig(root, 1);
    config.subagents.backend = "codex_app_server";
    config.subagents.childStartupTimeoutSec = 5;
    const job: SubagentJob = {
      id: "job_appserver_probe",
      profile: "x",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };
    const backend = new CodexAppServerChildAgentBackend(config, fakeLogger() as never);
    const startedPromise = backend.start({
      job,
      assembledPrompt: "hello",
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

    await new Promise((resolve) => setTimeout(resolve, 550));
    const started = await startedPromise;
    expect(sockets).toHaveLength(2);

    let settled: unknown;
    void started.finished.then((finish) => {
      settled = finish;
    });
    sockets[0]!.emit("close");
    await Promise.resolve();
    expect(settled).toBeUndefined();

    sockets[1]!.emit("message", JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "ok" }
    }));
    sockets[1]!.emit("message", JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed", error: null } }
    }));

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("ok");
  });

  test("codex_app_server backend preserves STATUS lines as normal output", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      child.pid = 99999998;
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killed = true;
        child.signalCode = signal ?? null;
        queueMicrotask(() => child.emit("exit", null, signal ?? null));
        return true;
      });
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });

    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventEmitter {
      static OPEN = 1;
      readyState = 0;
      readonly sent: unknown[] = [];

      constructor(readonly url: string) {
        super();
        sockets.push(this);
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.emit("open");
        });
      }

      send(data: string): void {
        const message = JSON.parse(data) as { id: number; method: string };
        this.sent.push(message);
        queueMicrotask(() => {
          if (message.method === "initialize") {
            this.emit("message", JSON.stringify({ id: message.id, result: {} }));
          } else if (message.method === "thread/start") {
            this.emit("message", JSON.stringify({ id: message.id, result: { thread: { id: "thread_1" } } }));
          } else if (message.method === "turn/start") {
            this.emit("message", JSON.stringify({ id: message.id, result: { turn: { id: "turn_1" } } }));
          }
        });
      }

      close(): void {
        this.readyState = 3;
        this.emit("close");
      }
    }
    vi.doMock("ws", () => ({ default: FakeWebSocket }));

    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const config = makeConfig(root, 1);
    config.subagents.backend = "codex_app_server";
    const job: SubagentJob = {
      id: "job_appserver_status",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };
    const backend = new CodexAppServerChildAgentBackend(config, fakeLogger() as never);
    const started = await backend.start({
      job,
      assembledPrompt: "hello",
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

    let settled: unknown;
    void started.finished.then((finish) => {
      settled = finish;
    });

    sockets[0]!.emit("message", JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "STA" }
    }));
    await Promise.resolve();

    sockets[0]!.emit("message", JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "TUS: checking repo; tests next\n" }
    }));
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(job.status).toBe("running");

    sockets[0]!.emit("message", JSON.stringify({
      method: "item/agentMessage/delta",
      params: { threadId: "thread_1", turnId: "turn_1", itemId: "msg_1", delta: "Final result" }
    }));
    sockets[0]!.emit("message", JSON.stringify({
      method: "turn/completed",
      params: { threadId: "thread_1", turn: { id: "turn_1", status: "completed", error: null } }
    }));

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("STATUS: checking repo; tests next\nFinal result");
  });

  test("runtime backend rollback forces queued and new jobs back to codex_exec", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    config.subagents.backend = "codex_app_server";
    const state = {
      saveJob: vi.fn().mockResolvedValue(undefined),
      setSubagentBackendOverride: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const queuedId = await manager.dispatch({ profile: "x", prompt: "queued", route: "return_to_main" });
    expect(manager.listJobs()[0]).toMatchObject({ id: queuedId, backend: "codex_app_server", status: "queued" });

    await manager.setBackendOverride("codex_exec", "test");

    expect(state.setSubagentBackendOverride).toHaveBeenCalledWith("codex_exec", "test");
    expect(manager.backendStatus()).toMatchObject({ configured: "codex_app_server", override: "codex_exec", effective: "codex_exec" });
    expect(manager.listJobs()[0]).toMatchObject({ id: queuedId, backend: "codex_exec", status: "queued" });
  });

  test("Claude backend override round-trips and queued jobs can opt into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const state = {
      saveJob: vi.fn().mockResolvedValue(undefined),
      setSubagentBackendOverride: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const queuedId = await manager.dispatch({ profile: "x", prompt: "queued", route: "return_to_main" });
    await manager.setBackendOverride("claude_agent_sdk", "test");

    expect(state.setSubagentBackendOverride).toHaveBeenCalledWith("claude_agent_sdk", "test");
    expect(manager.backendStatus()).toMatchObject({ configured: "codex_exec", override: "claude_agent_sdk", effective: "claude_agent_sdk" });
    expect(manager.listJobs()[0]).toMatchObject({ id: queuedId, backend: "claude_agent_sdk", status: "queued" });
  });

  test("per-dispatch backend routes one job to Claude without flipping the runtime default", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 2);
    config.subagents.backend = "codex_app_server";
    const appServerBackend = fakeBackend("codex_app_server", { activeTurnId: "turn_1", alive: true });
    const claudeBackend = fakeBackend("claude_agent_sdk", { activeTurnId: "claude-agent-sdk-stream", alive: true });
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() },
      { codex_app_server: appServerBackend, claude_agent_sdk: claudeBackend }
    );

    const defaultId = await manager.dispatch({ profile: "x", prompt: "codex work", route: "return_to_main" });
    const claudeId = await manager.dispatch({
      profile: "x",
      prompt: "claude work",
      route: "return_to_main",
      backend: "claude_agent_sdk",
      model: "claude-opus-4-8"
    });
    await waitFor(() => appServerBackend.starts.length === 1 && claudeBackend.starts.length === 1);

    // Both jobs run concurrently, each on its own backend.
    expect(manager.listJobs().find((job) => job.id === defaultId)).toMatchObject({
      backend: "codex_app_server",
      status: "running"
    });
    expect(manager.listJobs().find((job) => job.id === claudeId)).toMatchObject({
      backend: "claude_agent_sdk",
      backendExplicit: true,
      model: "claude-opus-4-8",
      codexProfile: "",
      modelProvider: "",
      status: "running"
    });
    // The runtime default is untouched by the per-dispatch backend.
    expect(manager.backendStatus()).toMatchObject({ configured: "codex_app_server", effective: "codex_app_server" });

    // Steering routes to the backend each job actually uses.
    await expect(manager.steerJob(claudeId, "steer claude")).resolves.toMatchObject({ status: "success" });
    expect(claudeBackend.steer).toHaveBeenCalledWith(claudeId, "steer claude");
    await expect(manager.steerJob(defaultId, "steer codex")).resolves.toMatchObject({ status: "success" });
    expect(appServerBackend.steer).toHaveBeenCalledWith(defaultId, "steer codex");
    expect(claudeBackend.steer).toHaveBeenCalledTimes(1);
  });

  test("runtime override re-stamps queued default jobs but keeps explicitly routed backends", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    config.subagents.backend = "codex_app_server";
    const state = {
      saveJob: vi.fn().mockResolvedValue(undefined),
      setSubagentBackendOverride: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const defaultId = await manager.dispatch({ profile: "x", prompt: "default", route: "return_to_main" });
    const claudeId = await manager.dispatch({ profile: "x", prompt: "claude", route: "return_to_main", backend: "claude_agent_sdk" });

    await manager.setBackendOverride("codex_exec", "test");

    expect(manager.listJobs().find((job) => job.id === defaultId)).toMatchObject({ backend: "codex_exec", status: "queued" });
    expect(manager.listJobs().find((job) => job.id === claudeId)).toMatchObject({ backend: "claude_agent_sdk", backendExplicit: true, status: "queued" });
  });

  test("a cancel landing while startJob is mid-await keeps the job cancelled and never starts the backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const execBackend = fakeBackend("codex_exec");
    let releaseProfile!: (value: string) => void;
    const profileGate = new Promise<string>((resolve) => {
      releaseProfile = resolve;
    });
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockReturnValue(profileGate) } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() },
      { codex_exec: execBackend }
    );

    // dispatch awaits drain → startJob, which is blocked on the profile gate,
    // so hold the promise and cancel while startJob is mid-await.
    const dispatched = manager.dispatch({ profile: "x", prompt: "work", route: "return_to_main" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const queued = manager.listJobs()[0];
    expect(queued).toBeDefined();
    const cancel = await manager.requestCancel(queued.id, { reason: "user" });
    expect(cancel.status).toBe("success");
    releaseProfile("profile contents");
    await dispatched;

    expect(execBackend.start).not.toHaveBeenCalled();
    expect(manager.listJobs().find((job) => job.id === queued.id)).toMatchObject({ status: "cancelled" });
  });

  test("auto-routes Claude model slugs to claude_agent_sdk when backend is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    config.subagents.backend = "codex_app_server";
    const state = {
      saveJob: vi.fn().mockResolvedValue(undefined),
      setSubagentBackendOverride: vi.fn().mockResolvedValue(undefined)
    };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const slugId = await manager.dispatch({ profile: "x", prompt: "claude", route: "return_to_main", model: "claude-opus-4-8" });
    const aliasId = await manager.dispatch({ profile: "x", prompt: "claude", route: "return_to_main", model: "opus" });

    expect(manager.listJobs().find((job) => job.id === slugId)).toMatchObject({ backend: "claude_agent_sdk", backendExplicit: true, model: "claude-opus-4-8", status: "queued" });
    expect(manager.listJobs().find((job) => job.id === aliasId)).toMatchObject({ backend: "claude_agent_sdk", backendExplicit: true, status: "queued" });
    expect(manager.backendStatus()).toMatchObject({ effective: "codex_app_server" });

    // Auto-routed jobs count as explicit: a later global override must not re-stamp them.
    await manager.setBackendOverride("codex_exec", "test");
    expect(manager.listJobs().find((job) => job.id === slugId)).toMatchObject({ backend: "claude_agent_sdk", status: "queued" });
  });

  test("rejects a Claude model combined with an explicit Codex backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await expect(manager.dispatch({
      profile: "x",
      prompt: "claude",
      route: "return_to_main",
      backend: "codex_exec",
      model: "claude-opus-4-8"
    })).rejects.toThrow(/Claude model but backend=codex_exec/);
    await expect(manager.dispatch({
      profile: "x",
      prompt: "claude",
      route: "return_to_main",
      backend: "codex_app_server",
      model: "fable"
    })).rejects.toThrow(/Claude model but backend=codex_app_server/);
  });

  test("rejects Codex provider fields on Claude-routed dispatches", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    config.subagents.allowProviderOverride = true;
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    await expect(manager.dispatch({
      profile: "x",
      prompt: "claude",
      route: "return_to_main",
      backend: "claude_agent_sdk",
      codexProfile: "openrouter"
    })).rejects.toThrow(/codexProfile is not supported with backend=claude_agent_sdk/);
    await expect(manager.dispatch({
      profile: "x",
      prompt: "claude",
      route: "return_to_main",
      backend: "claude_agent_sdk",
      modelProvider: "openrouter"
    })).rejects.toThrow(/modelProvider is not supported with backend=claude_agent_sdk/);
  });

  test("Claude jobs are steerable only while active and alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    config.subagents.backend = "claude_agent_sdk";
    const claudeBackend = fakeBackend("claude_agent_sdk", { activeTurnId: "claude-agent-sdk-stream", alive: true });
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() },
      { claude_agent_sdk: claudeBackend }
    );

    const id = await manager.dispatch({ profile: "x", prompt: "run", route: "return_to_main" });
    await waitFor(() => claudeBackend.starts.length === 1);

    expect(manager.activeJobSnapshots(5).jobs.find((job) => job.id === id)).toMatchObject({
      backend: "claude_agent_sdk",
      steerable: true
    });
    await expect(manager.steerJob(id.slice(4, 12), "follow up")).resolves.toMatchObject({ status: "success" });
    expect(claudeBackend.steer).toHaveBeenCalledWith(id, "follow up");

    const deadBackend = fakeBackend("claude_agent_sdk", { activeTurnId: "claude-agent-sdk-stream", alive: false });
    const deadConfig = makeConfig(root, 1);
    deadConfig.subagents.backend = "claude_agent_sdk";
    const deadManager = new SubagentManager(
      deadConfig,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() },
      { claude_agent_sdk: deadBackend }
    );
    const deadId = await deadManager.dispatch({ profile: "x", prompt: "run", route: "return_to_main" });
    await waitFor(() => deadBackend.starts.length === 1);
    expect(deadManager.activeJobSnapshots(5).jobs.find((job) => job.id === deadId)).toMatchObject({
      backend: "claude_agent_sdk",
      steerable: false
    });
  });

  test("resolves full job ids, displayed prefixes, and hex prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );
    manager.addJobs([
      { id: "job_e98ad78ae0cf4549a5cf88f1c875c668", profile: "researcher", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_abcd0000000000000000000000000000", profile: "debugger", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" }
    ]);

    expect(manager.resolveJobRef("job_e98ad78ae0cf4549a5cf88f1c875c668")).toMatchObject({ status: "matched", job: { id: "job_e98ad78ae0cf4549a5cf88f1c875c668" } });
    expect(manager.resolveJobRef("job_e98ad78a")).toMatchObject({ status: "matched", job: { id: "job_e98ad78ae0cf4549a5cf88f1c875c668" } });
    expect(manager.resolveJobRef("e98ad78a")).toMatchObject({ status: "matched", job: { id: "job_e98ad78ae0cf4549a5cf88f1c875c668" } });
  });

  test("returns ambiguous and unknown job ref resolutions with candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );
    manager.addJobs([
      { id: "job_deadbeef000000000000000000000000", profile: "researcher", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_deadbabe000000000000000000000000", profile: "debugger", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" }
    ]);

    const ambiguous = manager.resolveJobRef("dead");
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.candidates).toHaveLength(2);
      expect(ambiguous.candidates[0]).toMatchObject({ id: expect.stringMatching(/^job_dead/), ref: expect.any(String), status: expect.any(String) });
    }
    expect(manager.resolveJobRef("feedface")).toEqual({ status: "not_found", ref: "feedface" });
  });

  test("active job snapshots include only queued/running/cancelling jobs with compact refs", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );
    manager.addJobs([
      {
        id: "job_11111111111111111111111111111111",
        profile: "implementer",
        route: "return_to_main",
        status: "running",
        promptPath: "/tmp/p",
        artifactDir: "/tmp/a",
        backend: "codex_app_server",
        activeTurnId: "turn_1",
        startedAt: "2026-05-19T12:00:00.000Z",
        enqueuedAt: "2026-05-19T11:59:00.000Z",
        summary: "Implement snapshot",
        originChatId: 253768951,
        originMessageId: 701
      },
      {
        id: "job_22222222222222222222222222222222",
        profile: "researcher",
        route: "return_to_main",
        status: "queued",
        promptPath: "/tmp/p",
        artifactDir: "/tmp/a",
        backend: "codex_exec",
        enqueuedAt: "2026-05-19T12:02:00.000Z",
        summary: "Research"
      },
      {
        id: "job_33333333333333333333333333333333",
        profile: "debugger",
        route: "return_to_main",
        status: "cancelling",
        promptPath: "/tmp/p",
        artifactDir: "/tmp/a",
        backend: "codex_exec",
        startedAt: "2026-05-19T12:01:00.000Z",
        summary: "Cancel"
      },
      {
        id: "job_44444444444444444444444444444444",
        profile: "reviewer",
        route: "return_to_main",
        status: "completed",
        promptPath: "/tmp/p",
        artifactDir: "/tmp/a",
        backend: "codex_exec",
        startedAt: "2026-05-19T12:00:00.000Z",
        completedAt: "2026-05-19T12:03:00.000Z",
        summary: "Done"
      }
    ]);

    const snapshot = manager.activeJobSnapshots(2, new Date("2026-05-19T12:03:05.000Z").getTime());

    expect(snapshot.omitted).toBe(1);
    expect(snapshot.jobs).toHaveLength(2);
    expect(snapshot.jobs.map((job) => job.id)).toEqual([
      "job_22222222222222222222222222222222",
      "job_33333333333333333333333333333333"
    ]);
    expect(snapshot.jobs[0]).toMatchObject({
      ref: "22222222",
      status: "queued",
      backend: "codex_exec",
      steerable: false,
      createdAt: "2026-05-19T12:02:00.000Z",
      elapsedSec: 65,
      summary: "Research"
    });
    expect(snapshot.jobs.some((job) => job.id === "job_44444444444444444444444444444444")).toBe(false);
  });

  test("cancels queued jobs by removing them from the dispatch queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 0);
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const id = await manager.dispatch({ profile: "x", prompt: "queued", route: "return_to_main" });
    const result = await manager.requestCancel(id.slice(4, 12));

    expect(result).toMatchObject({ status: "success", previousStatus: "queued", job: { id, status: "cancelled", cancelReason: "user" } });
    expect((manager as unknown as { queue: unknown[] }).queue).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(state.saveJob.mock.calls.at(-1)?.[0]).toMatchObject({ id, status: "cancelled", completedAt: expect.any(String) });
  });

  test("running cancellation stays cancelling until the child exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const onReturnToMain = vi.fn().mockResolvedValue(undefined);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain, onSendToUser: vi.fn() }
    );

    const id = await manager.dispatch({ profile: "x", prompt: "running", route: "return_to_main" });
    await waitFor(() => children.length === 1);

    const result = await manager.requestCancel(id.slice(4, 12));

    expect(result).toMatchObject({ status: "success", previousStatus: "running", job: { id, status: "cancelling" } });
    expect((manager as unknown as { running: Map<string, unknown> }).running.has(id)).toBe(true);
    expect(manager.listJobs()[0]).toMatchObject({ id, status: "cancelling", termSentAt: expect.any(String) });

    children[0]!.signalCode = "SIGTERM";
    children[0]!.emit("exit", null, "SIGTERM");
    await waitFor(() => manager.listJobs()[0]?.status === "cancelled");
    await waitFor(() => onReturnToMain.mock.calls.length === 1);

    expect((manager as unknown as { running: Map<string, unknown> }).running.has(id)).toBe(false);
    expect(manager.listJobs()[0]).toMatchObject({ id, status: "cancelled", exitCode: null, signal: "SIGTERM" });
    expect(onReturnToMain).toHaveBeenCalledWith(expect.objectContaining({ id, status: "cancelled" }), expect.stringContaining("was cancelled"));
  });

  test("timeouts finalize as timed_out when the child exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const onReturnToMain = vi.fn().mockResolvedValue(undefined);
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      { saveJob: vi.fn().mockResolvedValue(undefined) } as never,
      fakeLogger() as never,
      { onReturnToMain, onSendToUser: vi.fn() }
    );

    const id = await manager.dispatch({ profile: "x", prompt: "timeout", route: "return_to_main", timeoutSec: 0 });
    await waitFor(() => manager.listJobs()[0]?.status === "cancelling");
    expect(manager.listJobs()[0]).toMatchObject({ id, status: "cancelling", cancelReason: "timeout" });

    children[0]!.signalCode = "SIGTERM";
    children[0]!.emit("exit", null, "SIGTERM");
    await waitFor(() => manager.listJobs()[0]?.status === "timed_out");
    await waitFor(() => onReturnToMain.mock.calls.length === 1);

    expect(manager.listJobs()[0]).toMatchObject({ id, status: "timed_out", exitCode: null, signal: "SIGTERM" });
    expect(onReturnToMain).toHaveBeenCalledWith(expect.objectContaining({ id, status: "timed_out" }), expect.stringContaining("timed out"));
  });

  test("loads persisted jobs and marks stale active jobs abandoned on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { StateStore } = await import("../state.js");
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const state = new StateStore(config);
    await state.init();
    await state.saveJob({ id: "job_11111111111111111111111111111111", profile: "researcher", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a", enqueuedAt: "2026-01-01T00:00:00.000Z" });
    await state.saveJob({ id: "job_22222222222222222222222222222222", profile: "debugger", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: "2026-01-01T00:00:00.000Z", pid: 12345, pgid: 12345 });
    await state.saveJob({ id: "job_33333333333333333333333333333333", profile: "reviewer", route: "return_to_main", status: "cancelling", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: "2026-01-01T00:00:00.000Z", cancelRequestedAt: "2026-01-01T00:01:00.000Z" });
    await state.saveJob({ id: "job_44444444444444444444444444444444", profile: "implementer", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:02:00.000Z" });
    const manager = new SubagentManager(
      config,
      { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") } as never,
      state,
      fakeLogger() as never,
      { onReturnToMain: vi.fn(), onSendToUser: vi.fn() }
    );

    const result = await manager.loadJobs();

    expect(result).toEqual({ loaded: 4, abandoned: 3 });
    expect(manager.listJobs().filter((job) => job.status === "abandoned")).toHaveLength(3);
    expect(manager.listJobs().find((job) => job.id === "job_44444444444444444444444444444444")).toMatchObject({ status: "completed" });
    const stale = JSON.parse(await readFile(join(root, "state", "jobs", "job_22222222222222222222222222222222.json"), "utf8")) as { status: string; abandonedAt?: string; error?: string };
    expect(stale.status).toBe("abandoned");
    expect(stale.abandonedAt).toEqual(expect.any(String));
    expect(stale.error).toContain("not safely recoverable");
  });

  test("failed return_to_main jobs are delivered to the callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawn = vi.fn(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { SubagentManager } = await import("../subagents.js");
    const config = makeConfig(root, 1);
    const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile contents") };
    const state = { saveJob: vi.fn().mockResolvedValue(undefined) };
    const onReturnToMain = vi.fn().mockResolvedValue(undefined);
    const manager = new SubagentManager(
      config,
      behavior as never,
      state as never,
      fakeLogger() as never,
      { onReturnToMain, onSendToUser: vi.fn() }
    );

    await manager.dispatch({
      profile: "x",
      prompt: "a",
      route: "return_to_main",
      originChatId: 253768951,
      originMessageId: 702
    });
    for (let i = 0; i < 20 && children.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const job = manager.listJobs()[0]!;
    await writeFile(join(job.artifactDir, "last-message.md"), "partial failure details");

    children[0]!.emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onReturnToMain).toHaveBeenCalledWith(
      expect.objectContaining({
        id: job.id,
        status: "failed",
        originChatId: 253768951,
        originMessageId: 702
      }),
      expect.stringContaining("partial failure details")
    );
    expect(onReturnToMain.mock.calls[0]?.[1]).toContain("failed");
  });
});
