import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";

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
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.pid = Math.floor(Math.random() * 100000) + 1000;
  child.exitCode = null;
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
      maxConcurrent,
      defaultModel: "",
      defaultEffort: "medium",
      defaultTimeoutSec: 60,
      maxTimeoutSec: 60,
      maxPromptBytes: 1_000_000,
      artifactDir: "data/subagents",
      allowedProfiles: [],
      cleanupArtifacts: false
    }
  } as AppConfig;
}

afterEach(async () => {
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
