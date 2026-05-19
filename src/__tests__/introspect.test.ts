import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  parseAgentsCommand,
  parseAgentKillCommand,
  parseAgentSteerCommand,
  parseSubagentBackendCommand,
  parseHelpCommand,
  HELP_TEXT,
  ServiceSupervisor,
} from "../service.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import type { SubagentJob } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// parseAgentsCommand
// ---------------------------------------------------------------------------

describe("parseAgentsCommand", () => {
  test("matches 'agents'", () => {
    expect(parseAgentsCommand("agents")).toEqual({ isAgents: true, lastN: 0 });
  });

  test("matches 'subagents'", () => {
    expect(parseAgentsCommand("subagents")).toEqual({ isAgents: true, lastN: 0 });
  });

  test("matches 'sub'", () => {
    expect(parseAgentsCommand("sub")).toEqual({ isAgents: true, lastN: 0 });
  });

  test("matches 'agent' (singular)", () => {
    expect(parseAgentsCommand("agent")).toEqual({ isAgents: true, lastN: 0 });
  });

  test("matches 'agents 10'", () => {
    expect(parseAgentsCommand("agents 10")).toEqual({ isAgents: true, lastN: 10 });
  });

  test("matches 'subagents 3'", () => {
    expect(parseAgentsCommand("subagents 3")).toEqual({ isAgents: true, lastN: 3 });
  });

  test("matches 'sub 3'", () => {
    expect(parseAgentsCommand("sub 3")).toEqual({ isAgents: true, lastN: 3 });
  });

  test("case insensitive", () => {
    expect(parseAgentsCommand("AGENTS")).toEqual({ isAgents: true, lastN: 0 });
    expect(parseAgentsCommand("Subagents 5")).toEqual({ isAgents: true, lastN: 5 });
    expect(parseAgentsCommand("SUB 5")).toEqual({ isAgents: true, lastN: 5 });
  });

  test("clamps lastN at 200", () => {
    expect(parseAgentsCommand("agents 9999")).toEqual({ isAgents: true, lastN: 200 });
  });

  test("does not match 'agent kill foo'", () => {
    expect(parseAgentsCommand("agent kill foo")).toEqual({ isAgents: false, lastN: 0 });
  });

  test("does not match random text", () => {
    expect(parseAgentsCommand("list all agents")).toEqual({ isAgents: false, lastN: 0 });
  });
});

// ---------------------------------------------------------------------------
// parseAgentKillCommand
// ---------------------------------------------------------------------------

describe("parseAgentKillCommand", () => {
  test("matches 'agent kill abc123'", () => {
    expect(parseAgentKillCommand("agent kill abc123")).toEqual({ isKill: true, jobId: "abc123" });
  });

  test("matches 'subagent kill def456'", () => {
    expect(parseAgentKillCommand("subagent kill def456")).toEqual({ isKill: true, jobId: "def456" });
  });

  test("matches 'agents kill xyz'", () => {
    expect(parseAgentKillCommand("agents kill xyz")).toEqual({ isKill: true, jobId: "xyz" });
  });

  test("case insensitive", () => {
    expect(parseAgentKillCommand("AGENT KILL abc")).toEqual({ isKill: true, jobId: "abc" });
  });

  test("does not match 'agent kill' without id", () => {
    expect(parseAgentKillCommand("agent kill")).toEqual({ isKill: false, jobId: "" });
  });

  test("does not match 'agents'", () => {
    expect(parseAgentKillCommand("agents")).toEqual({ isKill: false, jobId: "" });
  });
});

describe("parseAgentSteerCommand", () => {
  test("matches steering commands with free-form text", () => {
    expect(parseAgentSteerCommand("agent steer abc123 please focus on tests")).toEqual({
      isSteer: true,
      jobId: "abc123",
      text: "please focus on tests"
    });
    expect(parseAgentSteerCommand("subagent tell job_deadbeef add more logging")).toEqual({
      isSteer: true,
      jobId: "job_deadbeef",
      text: "add more logging"
    });
  });

  test("does not match incomplete steering commands", () => {
    expect(parseAgentSteerCommand("agent steer abc123")).toEqual({ isSteer: false, jobId: "", text: "" });
  });
});

describe("parseSubagentBackendCommand", () => {
  test("parses status, recovery, app-server opt-in, and clear commands", () => {
    expect(parseSubagentBackendCommand("agent backend")).toEqual({ isBackend: true, action: "status" });
    expect(parseSubagentBackendCommand("agent backend exec")).toEqual({ isBackend: true, action: "set", backend: "codex_exec" });
    expect(parseSubagentBackendCommand("subagent backend app-server")).toEqual({ isBackend: true, action: "set", backend: "codex_app_server" });
    expect(parseSubagentBackendCommand("agents backend config")).toEqual({ isBackend: true, action: "clear" });
  });
});

// ---------------------------------------------------------------------------
// parseHelpCommand
// ---------------------------------------------------------------------------

describe("parseHelpCommand", () => {
  test("matches 'help'", () => {
    expect(parseHelpCommand("help")).toBe(true);
  });

  test("case insensitive", () => {
    expect(parseHelpCommand("HELP")).toBe(true);
    expect(parseHelpCommand("Help")).toBe(true);
  });

  test("does not match 'help me'", () => {
    expect(parseHelpCommand("help me")).toBe(false);
  });

  test("does not match empty string", () => {
    expect(parseHelpCommand("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HELP_TEXT content
// ---------------------------------------------------------------------------

describe("HELP_TEXT", () => {
  test("contains all expected commands", () => {
    expect(HELP_TEXT).toContain("logs");
    expect(HELP_TEXT).toContain("introspect");
    expect(HELP_TEXT).toContain("agents");
    expect(HELP_TEXT).toContain("subagents (sub)");
    expect(HELP_TEXT).toContain("agent kill");
    expect(HELP_TEXT).toContain("agent steer");
    expect(HELP_TEXT).toContain("agent backend exec");
    expect(HELP_TEXT).toContain("agent backend app-server");
    expect(HELP_TEXT).toContain("help");
    expect(HELP_TEXT).toContain("update");
    expect(HELP_TEXT).toContain("deploy");
  });
});


describe("dispatch_subagent status", () => {
  test("sends model and effort status before dispatch", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const sendText = vi.fn().mockResolvedValue(undefined);
    const dispatchFromDirective = vi.fn().mockResolvedValue("job_123");
    (service as unknown as { telegram: { sendText: typeof sendText } }).telegram.sendText = sendText;
    (service as unknown as { subagents: { dispatchFromDirective: typeof dispatchFromDirective } }).subagents.dispatchFromDirective = dispatchFromDirective;

    await (service as unknown as { executeDirective(action: unknown, origin: unknown): Promise<void> }).executeDirective(
      {
        type: "dispatch_subagent",
        idempotencyKey: "dispatch-status-test",
        profile: "researcher",
        route: "return_to_main",
        summary: "inspect routing",
        prompt: "Inspect routing behavior",
        model: "gpt-5.5",
        effort: "high"
      },
      { source: "telegram", text: "x", attachments: [], receivedAt: new Date().toISOString(), chatId: 123, messageId: 456 }
    );

    expect(sendText).toHaveBeenCalledWith(123, "Sub: inspect routing\nresearcher · gpt-5.5 · high", 456);
    expect(dispatchFromDirective).toHaveBeenCalled();
  });
});

describe("cancel_job directive", () => {
  test("fails and surfaces no-match cancellation attempts", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const enqueueSynthetic = vi.spyOn(service, "enqueueSynthetic").mockResolvedValue();

    const status = await (service as unknown as { executeDirective(action: unknown, origin: unknown): Promise<string> }).executeDirective(
      { type: "cancel_job", idempotencyKey: "cancel-missing", jobId: "feedface" },
      { source: "telegram", text: "x", attachments: [], receivedAt: new Date().toISOString(), chatId: 123, messageId: 456 }
    );

    expect(status).toBe("failed");
    expect(enqueueSynthetic).toHaveBeenCalledWith(expect.stringContaining('Directive action cancel_job failed: No subagent job matched "feedface".'), { source: "system" });
  });

  test("fails and surfaces ambiguous cancellation attempts", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const subagents = (service as unknown as { subagents: SubagentManager }).subagents;
    subagents.addJobs([
      { id: "job_dead1111000000000000000000000000", profile: "debugger", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_dead2222000000000000000000000000", profile: "reviewer", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" }
    ]);
    const enqueueSynthetic = vi.spyOn(service, "enqueueSynthetic").mockResolvedValue();

    const status = await (service as unknown as { executeDirective(action: unknown, origin: unknown): Promise<string> }).executeDirective(
      { type: "cancel_job", idempotencyKey: "cancel-ambiguous", jobId: "dead" },
      { source: "telegram", text: "x", attachments: [], receivedAt: new Date().toISOString(), chatId: 123, messageId: 456 }
    );

    expect(status).toBe("failed");
    expect(enqueueSynthetic).toHaveBeenCalledWith(expect.stringContaining('Directive action cancel_job failed: Ambiguous subagent job ref "dead" matches 2 jobs.'), { source: "system" });
  });
});

// ---------------------------------------------------------------------------
// formatJobsDetailed
// ---------------------------------------------------------------------------

async function loadTestConfig() {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-intro-"));
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
transport = "app-server"
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

describe("formatJobsDetailed", () => {
  test("returns summary with zero jobs", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const result = (service as unknown as { formatJobsDetailed(n: number): string }).formatJobsDetailed(0);
    expect(result).toContain("0 running");
    expect(result).toContain("0 queued");
    expect(result).toContain("0 completed");
  });

  test("shows running and completed sections when jobs exist", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 30_000).toISOString();
    const jobs: SubagentJob[] = [
      { id: "job_abc123def", profile: "researcher", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: now, model: "gpt-5.5", effort: "high", summary: "research task" },
      { id: "job_ghi789jkl", profile: "debugger", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: past, completedAt: now, model: "gpt-5.5", effort: "xhigh", summary: "debug task" },
    ];
    (service as unknown as { subagents: { listJobs(): SubagentJob[] } }).subagents.listJobs = () => jobs;
    const result = (service as unknown as { formatJobsDetailed(n: number): string }).formatJobsDetailed(0);
    expect(result).toContain("1 running");
    expect(result).toContain("1 terminal");
    expect(result).toContain("1 completed");
    expect(result).toContain("[job_abc123de]");
    expect(result).toContain("researcher");
    expect(result).toContain("cancel: agent kill abc123de");
    expect(result).toContain("[job_ghi789jk]");
    expect(result).toContain("debugger");
    expect(result).toContain("model=gpt-5.5");
    expect(result).toContain("effort=xhigh");
    expect(result).toContain("research task");
    expect(result).toContain("completed debugger");
  });

  test("formats running and finished durations as minutes and seconds", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const now = new Date("2026-04-29T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();
    const jobs: SubagentJob[] = [
      { id: "job_run007xxx", profile: "runner", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: ago(7) },
      { id: "job_done065xx", profile: "finisher", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: ago(65), completedAt: now.toISOString() },
      { id: "job_fail3725x", profile: "debugger", route: "return_to_main", status: "failed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: ago(3725), completedAt: now.toISOString() },
      { id: "job_stop007xx", profile: "reviewer", route: "return_to_main", status: "cancelled", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: ago(7), completedAt: now.toISOString() },
    ];
    (service as unknown as { subagents: { listJobs(): SubagentJob[] } }).subagents.listJobs = () => jobs;
    const result = (service as unknown as { formatJobsDetailed(n: number): string }).formatJobsDetailed(0);
    expect(result).toContain("[job_run007xx] running runner - 0:07");
    expect(result).toContain("[job_done065x] completed finisher - done in 1:05");
    expect(result).toContain("[job_fail3725] failed debugger - done in 62:05");
    expect(result).toContain("[job_stop007x] cancelled reviewer - done in 0:07");
  });

  test("respects lastN parameter for completed jobs", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const past = (offset: number) => new Date(Date.now() - offset * 1000).toISOString();
    const now = new Date().toISOString();
    const jobs: SubagentJob[] = Array.from({ length: 10 }, (_, i) => ({
      id: `job_${String(i).padStart(6, "0")}xxxx`,
      profile: "researcher",
      route: "return_to_main" as const,
      status: "completed" as const,
      promptPath: "/tmp/p",
      artifactDir: "/tmp/a",
      startedAt: past(100 + i),
      completedAt: now
    }));
    (service as unknown as { subagents: { listJobs(): SubagentJob[] } }).subagents.listJobs = () => jobs;
    const result = (service as unknown as { formatJobsDetailed(n: number): string }).formatJobsDetailed(3);
    expect(result).toContain("last 3");
    // Only 3 job entries in recently completed section
    const matches = result.match(/completed researcher/g);
    expect(matches?.length).toBe(3);
  });

  test("agents output includes usable cancel refs", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    const jobs: SubagentJob[] = [
      { id: "job_e98ad78ae0cf4549a5cf88f1c875c668", profile: "implementer", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: new Date().toISOString(), summary: "fix cancellation" },
      { id: "job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", profile: "reviewer", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a", enqueuedAt: new Date().toISOString() }
    ];
    (service as unknown as { subagents: { listJobs(): SubagentJob[] } }).subagents.listJobs = () => jobs;

    const detailed = (service as unknown as { formatJobsDetailed(n: number): string }).formatJobsDetailed(0);
    const compact = service.formatJobs();

    expect(detailed).toContain("[job_e98ad78a]");
    expect(detailed).toContain("cancel: agent kill e98ad78a");
    expect(compact).toContain("ref=e98ad78a");
    expect(compact).toContain('cancel="agent kill e98ad78a"');
  });
});

// ---------------------------------------------------------------------------
// addJobs / loadJobs stubs
// ---------------------------------------------------------------------------

import { SubagentManager } from "../subagents.js";

function makeSubagentConfig(rootDir: string) {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { workspace: rootDir, stateDir: "state" },
    codex: { binary: "/bin/true", sandbox: "danger-full-access", approvalPolicy: "never", profile: "", model: "gpt-test", extraConfig: [] },
    subagents: {
      enabled: true,
      maxConcurrent: 5,
      defaultModel: "",
      defaultEffort: "medium",
      defaultTimeoutSec: 60,
      maxTimeoutSec: 60,
      maxPromptBytes: 1_000_000,
      artifactDir: "data/subagents",
      allowedProfiles: [],
      cleanupArtifacts: false
    }
  } as never;
}

function makeManager(rootDir: string) {
  const config = makeSubagentConfig(rootDir);
  const behavior = { readSubagentProfile: vi.fn().mockResolvedValue("profile") };
  const state = { saveJob: vi.fn().mockResolvedValue(undefined), listJobs: vi.fn().mockResolvedValue([]) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const manager = new SubagentManager(config, behavior as never, state as never, logger as never, { onReturnToMain: vi.fn(), onSendToUser: vi.fn() });
  return { manager, logger, state };
}

describe("SubagentManager.addJobs and loadJobs", () => {
  test("addJobs bulk-inserts jobs into the in-memory map", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { manager } = makeManager(root);

    const jobs: SubagentJob[] = [
      { id: "job_aaa", profile: "researcher", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_bbb", profile: "debugger", route: "return_to_main", status: "failed", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
    ];

    manager.addJobs(jobs);
    const listed = manager.listJobs();
    expect(listed.map((j) => j.id)).toContain("job_aaa");
    expect(listed.map((j) => j.id)).toContain("job_bbb");
  });

  test("addJobs with empty array is a no-op", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { manager } = makeManager(root);
    manager.addJobs([]);
    expect(manager.listJobs()).toHaveLength(0);
  });

  test("loadJobs hydrates persisted jobs and logs counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { manager, logger, state } = makeManager(root);
    state.listJobs.mockResolvedValue([
      { id: "job_active", profile: "researcher", route: "return_to_main", status: "running", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_done", profile: "debugger", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a" }
    ]);

    const result = await manager.loadJobs();

    expect(result).toEqual({ loaded: 2, abandoned: 1 });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: "subagents", event: "load_jobs", loaded: 2, abandoned: 1 }),
      "loaded persisted subagent jobs"
    );
    expect(manager.listJobs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "job_active", status: "abandoned" }),
      expect.objectContaining({ id: "job_done", status: "completed" })
    ]));
  });

  test("listJobs returns jobs sorted by startedAt descending", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-sub-"));
    tempDirs.push(root);
    const { manager } = makeManager(root);

    const jobs: SubagentJob[] = [
      { id: "job_older", profile: "researcher", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: "2024-01-01T00:00:00.000Z" },
      { id: "job_newer", profile: "debugger", route: "return_to_main", status: "completed", promptPath: "/tmp/p", artifactDir: "/tmp/a", startedAt: "2024-06-01T00:00:00.000Z" },
    ];

    manager.addJobs(jobs);
    const listed = manager.listJobs();
    expect(listed[0]?.id).toBe("job_newer");
    expect(listed[1]?.id).toBe("job_older");
  });
});

// ---------------------------------------------------------------------------
// Service command routing via enqueueUserEvent
// ---------------------------------------------------------------------------

describe("service command routing", () => {
  test("'help' command is intercepted and sends HELP_TEXT to Telegram", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const enqueueForCodex = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 1,
      text: "help",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(sendText).toHaveBeenCalledWith(253768951, HELP_TEXT, 1);
    expect(enqueueForCodex).not.toHaveBeenCalled();
  });

  test("'agents' command is intercepted and bypasses Codex", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const runTurn = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 2,
      text: "agents",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(sendText).toHaveBeenCalledWith(253768951, expect.stringContaining("Subagents:"), 2);
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("'sub' command is intercepted and bypasses Codex", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const runTurn = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 3,
      text: "sub",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(sendText).toHaveBeenCalledWith(253768951, expect.stringContaining("Subagents:"), 3);
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("'agent kill <id>' command is intercepted and calls cancelJob", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const cancelJob = vi.spyOn(service, "cancelJob").mockResolvedValue("Cancelled job_abc123.");
    const runTurn = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 3,
      text: "agent kill abc123",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(cancelJob).toHaveBeenCalledWith("abc123");
    expect(sendText).toHaveBeenCalledWith(253768951, "Cancelled job_abc123.", 3);
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("'agent steer <id> <text>' command is intercepted and calls steerJob", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const steerJob = vi.spyOn(service, "steerJob").mockResolvedValue("Steered subagent job_abc123 (debugger).");
    const runTurn = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 4,
      text: "agent steer abc123 please stop and summarize",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(steerJob).toHaveBeenCalledWith("abc123", "please stop and summarize");
    expect(sendText).toHaveBeenCalledWith(253768951, "Steered subagent job_abc123 (debugger).", 4);
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("'agent backend exec' is an admin Telegram rollback path", async () => {
    const config = await loadTestConfig();
    config.telegram.allowlist.adminUserIds = [253768951];
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const sendText = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const runTurn = vi.spyOn(service as unknown as { runTurn(e: unknown): void }, "runTurn");

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      messageId: 5,
      text: "agent backend exec",
      attachments: [],
      receivedAt: new Date().toISOString()
    });

    expect(sendText).toHaveBeenCalledWith(253768951, expect.stringContaining("Recovery active"), 5);
    expect((service as unknown as { subagents: SubagentManager }).subagents.backendStatus()).toMatchObject({ effective: "codex_exec", override: "codex_exec" });
    expect(runTurn).not.toHaveBeenCalled();
  });

  test("cancelJob resolves prefixes and reports ambiguous, unknown, and terminal refs", async () => {
    const config = await loadTestConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const subagents = (service as unknown as { subagents: SubagentManager }).subagents;
    subagents.addJobs([
      { id: "job_abcd1111000000000000000000000000", profile: "researcher", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_dead1111000000000000000000000000", profile: "debugger", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" },
      { id: "job_dead2222000000000000000000000000", profile: "reviewer", route: "return_to_main", status: "queued", promptPath: "/tmp/p", artifactDir: "/tmp/a" }
    ]);

    await expect(service.cancelJob("abcd1111")).resolves.toContain("Cancelled queued subagent job_abcd1111000000000000000000000000");
    await expect(service.cancelJob("abcd1111")).resolves.toContain("already cancelled");
    await expect(service.cancelJob("dead")).resolves.toContain("Ambiguous subagent ref");
    await expect(service.cancelJob("feedface")).resolves.toContain('No subagent job matched "feedface"');
  });
});
