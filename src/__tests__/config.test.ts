import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig, writeDefaultConfigFilesIfMissing } from "../config.js";
import { loadLoopsConfig } from "../loops.js";
import { loadMonitorsConfig } from "../monitors.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };
const overrideEnvNames = [
  "CODEX_CHAT_WORKSPACE",
  "CODEX_CHAT_STATE_DIR",
  "CODEX_CHAT_LOG_LEVEL",
  "CODEX_CHAT_CODEX_BINARY",
  "CODEX_CHAT_CODEX_MODEL",
  "CODEX_CHAT_CODEX_EFFORT",
  "CODEX_CHAT_CODEX_SANDBOX",
  "CODEX_CHAT_CODEX_APPROVAL_POLICY",
  "CODEX_CHAT_SUBAGENTS_BACKEND",
  "CODEX_CHAT_TELEGRAM_MODE",
  "CODEX_CHAT_LOOPS_PATH",
  "CODEX_CHAT_MONITORS_PATH",
  "CODEX_CHAT_TRANSCRIPTION_ENABLED",
  "CODEX_CHAT_TRANSCRIPTION_PROMPT_PATH",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ADMIN_USER_IDS",
  "CUSTOM_TELEGRAM_TOKEN"
];

async function tempConfig(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-config-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const path = join(configDir, "codex-chat.toml");
  await writeFile(path, contents);
  return path;
}

beforeEach(() => {
  for (const name of overrideEnvNames) delete process.env[name];
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config loading", () => {
  test("parses TOML and applies defaults", async () => {
    const path = await tempConfig(`
version = 1

[service]
workspace = "/tmp/codex-chat-workspace"

[codex]
model = "gpt-test"

[telegram.allowlist]
userIds = [12345]
`);

    const config = await loadConfig(path);

    expect(config.codex.model).toBe("gpt-test");
    expect(config.codex.sandbox).toBe("danger-full-access");
    expect(config.subagents.backend).toBe("codex_exec");
    expect(config.telegram.allowlist.userIds).toEqual([12345]);
    expect(config.rootDir).toBe(resolve(path, "../.."));
  });

  test("rejects invalid required config values", async () => {
    const path = await tempConfig("version = 2\n");

    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("uses environment overrides after file values", async () => {
    process.env.CODEX_CHAT_CODEX_MODEL = "from-env";
    process.env.CUSTOM_TELEGRAM_TOKEN = "token-from-custom-env";
    process.env.TELEGRAM_BOT_TOKEN = "token-from-default-env";
    const path = await tempConfig(`
version = 1

[codex]
model = "from-file"

[telegram]
botTokenEnv = "CUSTOM_TELEGRAM_TOKEN"
`);

    const config = await loadConfig(path);

    expect(config.codex.model).toBe("from-env");
    expect(config.subagents.backend).toBe("codex_exec");
    expect(config.telegramBotToken).toBe("token-from-custom-env");
  });

  test("allows app-server subagent backend opt-in from config and env", async () => {
    const path = await tempConfig(`
version = 1

[subagents]
backend = "codex_exec"
`);
    process.env.CODEX_CHAT_SUBAGENTS_BACKEND = "codex_app_server";

    const config = await loadConfig(path);

    expect(config.subagents.backend).toBe("codex_app_server");
  });

  test("adds Telegram user ID lists from environment", async () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = " 222, 333 , external-user ";
    process.env.TELEGRAM_ADMIN_USER_IDS = " 444,555 ";
    const path = await tempConfig(`
version = 1

[telegram.allowlist]
userIds = [111]
adminUserIds = [999]
`);

    const config = await loadConfig(path);

    expect(config.telegram.allowlist.userIds).toEqual([111, 222, 333, "external-user"]);
    expect(config.telegram.allowlist.adminUserIds).toEqual([999, 444, 555]);
  });

  test("creates missing runtime config files from generic examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-setup-"));
    tempDirs.push(root);
    const configPath = join(root, "config", "codex-chat.toml");

    const result = await writeDefaultConfigFilesIfMissing(configPath);
    const config = await loadConfig(configPath);
    const loops = await loadLoopsConfig(config);
    const monitors = await loadMonitorsConfig(config);

    expect(result).toEqual({ configCreated: true, loopsCreated: true, monitorsCreated: true });
    expect(config.telegram.allowlist.userIds).toEqual([]);
    expect(config.telegram.opsChatId).toBe(0);
    expect(loops.loops).toEqual([]);
    expect(monitors.monitors).toEqual([]);
  });

  test("preserves existing runtime config files during setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-setup-existing-"));
    tempDirs.push(root);
    const configDir = join(root, "config");
    await mkdir(configDir, { recursive: true });
    const configPath = join(configDir, "codex-chat.toml");
    await writeFile(configPath, `
version = 1

[telegram]
opsChatId = 123
`);
    await writeFile(join(configDir, "loops.json"), JSON.stringify({ version: 1, loops: [{ id: "local", enabled: true, schedule: "0 * * * *", type: "prompt", prompt: "Keep me" }] }));
    await writeFile(join(configDir, "monitors.json"), JSON.stringify({ version: 1, monitors: [] }));

    const result = await writeDefaultConfigFilesIfMissing(configPath);
    const config = await loadConfig(configPath);
    const loops = await loadLoopsConfig(config);

    expect(result).toEqual({ configCreated: false, loopsCreated: false, monitorsCreated: false });
    expect(config.telegram.opsChatId).toBe(123);
    expect(loops.loops[0]?.id).toBe("local");
  });
});
