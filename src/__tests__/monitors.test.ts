import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import { loadMonitorsConfig } from "../monitors.js";

const tempDirs: string[] = [];

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    monitors: {
      enabled: true,
      path: "config/monitors.json",
      maxRestartBackoffSec: 300
    }
  } as AppConfig;
}

async function writeMonitors(body: unknown): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-monitors-"));
  tempDirs.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "config", "monitors.json"), JSON.stringify(body, null, 2));
  return testConfig(root);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("monitors config", () => {
  test("accepts a valid monitors schema", async () => {
    const config = await writeMonitors({
      version: 1,
      monitors: [{
        id: "dev-server",
        enabled: true,
        type: "log_file",
        path: "logs/dev.log",
        patterns: [{
          id: "error",
          regex: "Error",
          action: { type: "send_to_main" }
        }]
      }]
    });

    const parsed = await loadMonitorsConfig(config);

    expect(parsed.monitors).toHaveLength(1);
    expect(parsed.monitors[0]?.patterns[0]?.action.type).toBe("send_to_main");
  });

  test("enforces required monitor fields", async () => {
    const config = await writeMonitors({
      version: 1,
      monitors: [{ enabled: true, type: "log_file", path: "logs/dev.log" }]
    });

    await expect(loadMonitorsConfig(config)).rejects.toThrow();
  });

  test("enforces required pattern fields", async () => {
    const config = await writeMonitors({
      version: 1,
      monitors: [{
        id: "dev-server",
        enabled: true,
        type: "log_file",
        path: "logs/dev.log",
        patterns: [{ id: "missing-regex" }]
      }]
    });

    await expect(loadMonitorsConfig(config)).rejects.toThrow();
  });
});
