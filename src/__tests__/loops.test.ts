import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { buildManagedCronText, generateCronLines, loadLoopsConfig, LoopManager, type LoopsConfig } from "../loops.js";
import { StateStore } from "../state.js";

const tempDirs: string[] = [];

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { workspace: rootDir, stateDir: "data/state" },
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

async function processSpooled(config: AppConfig, callbacks: Partial<ConstructorParameters<typeof LoopManager>[3]> = {}) {
  const state = new StateStore(config);
  await state.init();
  const manager = new LoopManager(config, state, testLogger, {
    enqueueMain: async () => undefined,
    sendAdmins: async () => undefined,
    dispatchSubagent: async () => undefined,
    ...callbacks
  });
  await manager.processSpooled();
}

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
