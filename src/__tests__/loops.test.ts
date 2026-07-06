import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { buildManagedCronText, formatLoopsStatus, generateCronLines, loadLoopsConfig, LoopManager, runLoopCli, type LoopsConfig } from "../loops.js";
import { StateStore } from "../state.js";

const tempDirs: string[] = [];

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { workspace: rootDir, stateDir: "data/state", ipcSocket: "data/run/codex-chat.sock" },
    transcription: { apiKeyEnv: "CUSTOM_TRANSCRIPTION_API_KEY" },
    loops: {
      enabled: true,
      path: "config/loops.json",
      namespace: "testbot",
      runnerCommand: "/usr/local/bin/codex-chat loop run"
    }
  } as AppConfig;
}

async function writeLoops(body: unknown): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-loops-"));
  tempDirs.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "loops.json"), JSON.stringify(body, null, 2));
  return testConfig(root);
}

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CUSTOM_TRANSCRIPTION_API_KEY;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loops config", () => {
  test("accepts a valid loops schema", async () => {
    const config = await writeLoops({
      version: 1,
      loops: [{
        id: "daily",
        enabled: true,
        schedule: "15 9 * * *",
        type: "prompt",
        prompt: "Summarize the day",
        model: "gpt-5.4",
        effort: "high"
      }]
    });

    const loops = await loadLoopsConfig(config);

    expect(loops.loops[0]?.id).toBe("daily");
    expect(loops.loops[0]?.model).toBe("gpt-5.4");
    expect(loops.loops[0]?.effort).toBe("high");
    expect(loops.defaults.route).toBe("return_to_main");
  });

  test("catches missing required loop fields", async () => {
    const config = await writeLoops({
      version: 1,
      loops: [{ id: "broken", enabled: true, type: "prompt" }]
    });

    await expect(loadLoopsConfig(config)).rejects.toThrow();
  });

  test("validates cron expressions", async () => {
    const config = await writeLoops({
      version: 1,
      loops: [{ id: "broken-cron", enabled: true, schedule: "not cron", type: "prompt" }]
    });

    await expect(loadLoopsConfig(config)).rejects.toThrow(/Invalid cron expression/);
  });

  test("generates and replaces only the managed cron block", () => {
    const config = testConfig("/tmp/codex-chat-test");
    const loops: LoopsConfig = {
      version: 1,
      namespace: "testbot",
      defaults: { timezone: "Etc/UTC", timeoutSec: 1800, route: "return_to_main", lock: false },
      loops: [{
        id: "health",
        enabled: true,
        schedule: "*/5 * * * *",
        type: "command",
        command: "codex-chat",
        args: ["health"],
        route: "store_only"
      }]
    };

    const lines = generateCronLines(config, loops);
    const next = buildManagedCronText([
      "MAILTO=tim@example.com",
      "# BEGIN testbot managed loops",
      "old managed line",
      "# END testbot managed loops",
      "0 0 * * * echo outside"
    ].join("\n"), "testbot", lines);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("*/5 * * * * CODEX_CHAT_CONFIG=");
    expect(lines[0]).toContain("/usr/local/bin/codex-chat --config /tmp/codex-chat-test/config/codex-chat.toml loop run health");
    expect(next).toContain("MAILTO=tim@example.com");
    expect(next).toContain("0 0 * * * echo outside");
    expect(next).toContain(lines[0] as string);
    expect(next).not.toContain("old managed line");
  });

  test("does not add an empty managed cron block when no loops are enabled", () => {
    const next = buildManagedCronText("", "testbot", []);

    expect(next).toBe("");
  });

  test("removes an obsolete managed cron block when no loops are enabled", () => {
    const next = buildManagedCronText([
      "MAILTO=tim@example.com",
      "# BEGIN testbot managed loops",
      "*/5 * * * * old-command",
      "# END testbot managed loops"
    ].join("\n"), "testbot", []);

    expect(next).toBe("MAILTO=tim@example.com\n");
  });
});


async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const testLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
} as never;

async function createLoopManager(config: AppConfig, callbacks: Partial<ConstructorParameters<typeof LoopManager>[3]> = {}) {
  const state = new StateStore(config);
  await state.init();
  const manager = new LoopManager(config, state, testLogger, {
    enqueueMain: async () => undefined,
    sendAdmins: async () => undefined,
    dispatchSubagent: async () => undefined,
    ...callbacks
  });
  return { manager, state };
}

async function processSpooled(config: AppConfig, callbacks: Partial<ConstructorParameters<typeof LoopManager>[3]> = {}) {
  const { manager } = await createLoopManager(config, callbacks);
  await manager.processSpooled();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

test("strips OpenAI and transcription env from loop command subprocesses", async () => {
  process.env.OPENAI_API_KEY = "sk-test-parent-openai";
  process.env.CUSTOM_TRANSCRIPTION_API_KEY = "sk-test-parent-transcription";
  const script = "console.log(JSON.stringify({ openai: Boolean(process.env.OPENAI_API_KEY), transcription: Boolean(process.env.CUSTOM_TRANSCRIPTION_API_KEY), other: process.env.OTHER_VAR || null }))";
  const config = await writeLoops({
    version: 1,
    loops: [{
      id: "env-check",
      enabled: true,
      schedule: "*/5 * * * *",
      type: "command",
      command: process.execPath,
      args: ["-e", script],
      env: {
        OPENAI_API_KEY: "sk-test-loop-override-openai",
        CUSTOM_TRANSCRIPTION_API_KEY: "sk-test-loop-override-transcription",
        OTHER_VAR: "keep-me"
      },
      route: "return_to_main"
    }]
  });
  const state = new StateStore(config);
  await state.init();
  const delivered: string[] = [];
  const manager = new LoopManager(config, state, testLogger, {
    enqueueMain: async (text) => { delivered.push(text); },
    sendAdmins: async () => undefined,
    dispatchSubagent: async () => undefined
  });

  await manager.handleRun("env-check");

  const match = delivered[0]?.match(/\{"openai"[^\n]+\}/);
  expect(match?.[0]).toBeTruthy();
  expect(JSON.parse(match?.[0] ?? "{}")).toEqual({ openai: false, transcription: false, other: "keep-me" });
});

test("marks SIGTERM-interrupted command loops as cancelled during service shutdown without admin notification", async () => {
  let adminNotifications = 0;
  const config = await writeLoops({
    version: 1,
    loops: [{
      id: "restart-health",
      enabled: true,
      schedule: "*/5 * * * *",
      type: "command",
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"],
      route: "store_only",
      notifyOnFailure: true
    }]
  });
  const { manager, state } = await createLoopManager(config, {
    sendAdmins: async () => { adminNotifications += 1; }
  });

  const running = manager.handleRun("restart-health");
  await waitFor(async () => (await state.listLoopRuns()).some((run) => run.loopId === "restart-health" && run.status === "running"));
  manager.prepareForServiceShutdown("test");
  await running;

  const [run] = await state.listLoopRuns();
  expect(run).toMatchObject({
    loopId: "restart-health",
    status: "cancelled",
    error: "Interrupted by service shutdown before completion."
  });
  expect(run?.completedAt).toBeTruthy();
  expect(adminNotifications).toBe(0);
});

test("reconciles stale running loop runs as cancelled on startup", async () => {
  const config = await writeLoops({
    version: 1,
    loops: [{
      id: "daily",
      enabled: true,
      schedule: "*/5 * * * *",
      type: "prompt",
      prompt: "ok",
      route: "store_only"
    }]
  });
  const { manager, state } = await createLoopManager(config);
  await state.saveLoopRun({
    id: "loop_stale",
    loopId: "daily",
    status: "running",
    scheduledAt: "2026-07-06T00:00:00.000Z",
    startedAt: "2026-07-06T00:00:01.000Z",
    route: "store_only"
  });

  await expect(manager.reconcileStaleRunningRuns()).resolves.toBe(1);

  const [run] = await state.listLoopRuns();
  expect(run).toMatchObject({
    id: "loop_stale",
    status: "cancelled",
    error: "Interrupted by service shutdown before completion."
  });
  expect(run?.completedAt).toBeTruthy();
});

test("spools a durable loop run when reading the IPC token fails", async () => {
  const config = await writeLoops({
    version: 1,
    loops: [{
      id: "daily",
      enabled: true,
      schedule: "*/5 * * * *",
      type: "prompt",
      prompt: "ok",
      route: "store_only",
      durable: true
    }]
  });
  await mkdir(join(config.rootDir, "data", "run", "ipc.token"), { recursive: true });

  await runLoopCli(config, "daily");

  const spoolDir = join(config.rootDir, "data", "spool", "loops");
  const [spoolFile] = await readdir(spoolDir);
  expect(spoolFile).toContain("daily");
  const payload = JSON.parse(await readFile(join(spoolDir, spoolFile ?? ""), "utf8")) as { loopId?: string; error?: string };
  expect(payload.loopId).toBe("daily");
  expect(payload.error).toContain("EISDIR");
});

describe("loop spool replay", () => {
  test("deletes spool files after successful replay", async () => {
    const config = await writeLoops({
      version: 1,
      loops: [{
        id: "daily",
        enabled: true,
        schedule: "*/5 * * * *",
        type: "prompt",
        prompt: "ok",
        route: "store_only"
      }]
    });
    const spoolDir = join(config.rootDir, "data", "spool", "loops");
    await mkdir(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, "1000-daily.json");
    await writeFile(spoolFile, JSON.stringify({ loopId: "daily", scheduledAt: new Date().toISOString() }));

    await processSpooled(config);

    expect(await exists(spoolFile)).toBe(false);
    const runs = await readdir(join(config.rootDir, "data", "state", "loop_runs"));
    expect(runs).toHaveLength(1);
  });

  test("quarantines failed spool replays instead of retrying forever", async () => {
    const config = await writeLoops({ version: 1, loops: [] });
    const spoolDir = join(config.rootDir, "data", "spool", "loops");
    await mkdir(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, "1000-missing.json");
    await writeFile(spoolFile, JSON.stringify({ loopId: "missing", scheduledAt: new Date().toISOString() }));

    await processSpooled(config);

    expect(await exists(spoolFile)).toBe(false);
    const quarantined = await readdir(join(config.rootDir, "data", "spool", "loops-quarantine", "failed"));
    expect(quarantined).toContain("1000-missing.json");
  });

  test("quarantines stale spool files before they can notify admins", async () => {
    let adminNotifications = 0;
    const config = await writeLoops({
      version: 1,
      loops: [{
        id: "health",
        enabled: true,
        schedule: "*/15 * * * *",
        type: "prompt",
        prompt: "old alert",
        route: "send_to_admins",
        maxSpoolAgeSec: 60
      }]
    });
    const spoolDir = join(config.rootDir, "data", "spool", "loops");
    await mkdir(spoolDir, { recursive: true });
    const spoolFile = join(spoolDir, "1000-health.json");
    await writeFile(spoolFile, JSON.stringify({ loopId: "health", scheduledAt: "2000-01-01T00:00:00.000Z" }));

    await processSpooled(config, { sendAdmins: async () => { adminNotifications += 1; } });

    expect(adminNotifications).toBe(0);
    expect(await exists(spoolFile)).toBe(false);
    const quarantined = await readdir(join(config.rootDir, "data", "spool", "loops-quarantine", "stale"));
    expect(quarantined).toContain("1000-health.json");
    const runs = await readdir(join(config.rootDir, "data", "state", "loop_runs"));
    expect(runs).toHaveLength(0);
  });
});

describe("loop status formatting", () => {
  test("prints a concise countable loop summary with last run state", async () => {
    const config = await writeLoops({
      version: 1,
      defaults: { timezone: "Etc/UTC", route: "return_to_main", lock: true },
      loops: [
        {
          id: "health",
          enabled: true,
          schedule: "*/5 * * * *",
          type: "command",
          command: "true",
          route: "send_to_admins",
          durable: true,
          suppressEmptyOutput: true
        },
        {
          id: "old",
          enabled: false,
          schedule: "0 0 * * *",
          type: "prompt",
          prompt: "skip",
          lock: false
        }
      ]
    });
    const state = new StateStore(config);
    await state.init();
    await state.saveLoopRun({
      id: "loop_last",
      loopId: "health",
      status: "completed",
      scheduledAt: "2026-05-20T04:00:00.000Z",
      startedAt: "2026-05-20T04:00:01.000Z",
      completedAt: "2026-05-20T04:00:02.000Z",
      route: "send_to_admins"
    });

    const output = await formatLoopsStatus(config, state, new Date("2026-05-20T04:01:00.000Z"));

    expect(output).toContain("Loops: 2 configured (1 enabled, 1 disabled)");
    expect(output).toContain("Enabled:\n1. health — enabled");
    expect(output).toContain("   schedule/timezone: */5 * * * * (Etc/UTC)");
    expect(output).toContain("   type/route: command / send_to_admins");
    expect(output).toContain("   lock/durable: lock=true durable=true");
    expect(output).toContain("   suppressEmptyOutput: true");
    expect(output).toContain("   next run: 2026-05-20T04:05:00.000Z");
    expect(output).toContain("   last run: completed at 2026-05-20T04:00:02.000Z");
    expect(output).toContain("Disabled:\n2. old — disabled");
    expect(output).toContain("   type/route: prompt / return_to_main");
    expect(output).toContain("   lock/durable: lock=false durable=false");
  });
});
