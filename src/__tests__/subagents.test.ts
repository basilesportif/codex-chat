import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { SubagentJob } from "../types.js";

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
      model: "gpt-test",
      extraConfig: []
    },
    subagents: {
      enabled: true,
      backend: "codex_exec",
      maxConcurrent,
      defaultModel: "",
      defaultEffort: "medium",
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

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
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

    await manager.dispatch({ profile: "x", prompt: "a", route: "return_to_main", model: "gpt-5.5", effort: "xhigh", summary: "test task" });

    const saved = state.saveJob.mock.calls[0]?.[0];
    expect(saved).toMatchObject({ model: "gpt-5.5", effort: "xhigh", summary: "test task", status: "queued" });
    expect(manager.listJobs()[0]).toMatchObject({ model: "gpt-5.5", effort: "xhigh", summary: "test task" });
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
    await new Promise((resolve) => setTimeout(resolve, 10));

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain('experimental_feature="on"');
    expect(args.filter((arg) => arg.includes("model_reasoning_effort"))).toEqual(['model_reasoning_effort="xhigh"']);
  });

  test("uses configured codex_exec backend and records it on jobs", async () => {
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
