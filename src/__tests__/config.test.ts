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
  "CODEX_CHAT_CODEX_SERVICE_TIER",
  "CODEX_CHAT_CODEX_SERVICE_TIER_MODE",
  "CODEX_CHAT_CODEX_PROFILE",
  "CODEX_CHAT_CODEX_MODEL_PROVIDER",
  "CODEX_CHAT_CODEX_SANDBOX",
  "CODEX_CHAT_CODEX_APPROVAL_POLICY",
  "CODEX_CHAT_SUBAGENTS_BACKEND",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE",
  "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER",
  "CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE",
  "CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE",
  "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES",
  "CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS",
  "CODEX_CHAT_API_ENABLED",
  "CODEX_CHAT_API_HOST",
  "CODEX_CHAT_API_PORT",
  "CODEX_CHAT_API_ALLOW_NON_LOCALHOST",
  "CODEX_CHAT_BASE_URL",
  "CODEX_CHAT_TELEGRAM_MODE",
  "CODEX_CHAT_SLACK_ENABLED",
  "CODEX_CHAT_SLACK_EVENTS_PATH",
  "CODEX_CHAT_LOOPS_PATH",
  "CODEX_CHAT_MONITORS_PATH",
  "CODEX_CHAT_TRANSCRIPTION_ENABLED",
  "CODEX_CHAT_TRANSCRIPTION_MODEL",
  "CODEX_CHAT_TRANSCRIPTION_DIARIZE_MODEL",
  "CODEX_CHAT_TRANSCRIPTION_PROMPT_PATH",
  "CODEXCHAT_INGEST_API_KEYS",
  "CODEXCHAT_AUDIO_INGEST_MAX_MB",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ADMIN_USER_IDS",
  "CUSTOM_TELEGRAM_TOKEN",
  "CUSTOM_SLACK_SIGNING_SECRET",
  "CUSTOM_SLACK_BOT_TOKEN",
  "CUSTOM_SLACK_APP_TOKEN",
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
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
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
    expect(config.codex.serviceTier).toBe("fast");
    expect(config.codex.serviceTierMode).toBe("auto");
    expect(config.codex.modelProvider).toBe("");
    expect(config.subagents.defaultServiceTier).toBe("fast");
    expect(config.subagents.backend).toBe("codex_exec");
    expect(config.api.enabled).toBe(false);
    expect(config.slack.enabled).toBe(false);
    expect(config.slack.eventsPath).toBe("/api/slack/events");
    expect(config.slack.context.enabled).toBe(true);
    expect(config.slack.context.maxChannelMessages).toBe(15);
    expect(config.ingest.audioMaxMb).toBe(100);
    expect(config.transcription.model).toBe("gpt-4o-transcribe");
    expect(config.transcription.diarizeModel).toBe("gpt-4o-transcribe-diarize");
    expect(config.telegram.allowlist.userIds).toEqual([12345]);
    expect(config.rootDir).toBe(resolve(path, "../.."));
  });

  test("rejects invalid required config values", async () => {
    const path = await tempConfig("version = 2\n");

    await expect(loadConfig(path)).rejects.toThrow();
  });

  test("uses environment overrides after file values", async () => {
    process.env.CODEX_CHAT_CODEX_MODEL = "from-env";
    process.env.CODEX_CHAT_CODEX_SERVICE_TIER = "standard";
    process.env.CODEX_CHAT_SLACK_ENABLED = "true";
    process.env.CODEX_CHAT_SLACK_EVENTS_PATH = "/api/custom-slack/events";
    process.env.CUSTOM_TELEGRAM_TOKEN = "token-from-custom-env";
    process.env.TELEGRAM_BOT_TOKEN = "token-from-default-env";
    process.env.CUSTOM_SLACK_SIGNING_SECRET = "slack-signing-secret";
    process.env.CUSTOM_SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.CODEX_CHAT_BASE_URL = "https://brain.decisive-outcomes.com";
    const path = await tempConfig(`
version = 1

[codex]
model = "from-file"

[telegram]
botTokenEnv = "CUSTOM_TELEGRAM_TOKEN"

[slack]
signingSecretEnv = "CUSTOM_SLACK_SIGNING_SECRET"
botTokenEnv = "CUSTOM_SLACK_BOT_TOKEN"
`);

    const config = await loadConfig(path);

    expect(config.codex.model).toBe("from-env");
    expect(config.codex.serviceTier).toBe("standard");
    expect(config.subagents.backend).toBe("codex_exec");
    expect(config.telegramBotToken).toBe("token-from-custom-env");
    expect(config.slack.enabled).toBe(true);
    expect(config.slack.eventsPath).toBe("/api/custom-slack/events");
    expect(config.api.enabled).toBe(true);
    expect(config.slack.publicBaseUrl).toBe("https://brain.decisive-outcomes.com");
    expect(config.slackSigningSecret).toBe("slack-signing-secret");
    expect(config.slackBotToken).toBe("xoxb-test-token");
  });

  test("allows transcription model env overrides", async () => {
    process.env.CODEX_CHAT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe-custom";
    process.env.CODEX_CHAT_TRANSCRIPTION_DIARIZE_MODEL =
      "gpt-4o-transcribe-diarize-custom";
    const path = await tempConfig("version = 1\n");

    const config = await loadConfig(path);

    expect(config.transcription.model).toBe("gpt-4o-transcribe-custom");
    expect(config.transcription.diarizeModel).toBe(
      "gpt-4o-transcribe-diarize-custom",
    );
  });



  test("loads provider/profile config fields and environment overrides", async () => {
    process.env.CODEX_CHAT_CODEX_PROFILE = "main-profile";
    process.env.CODEX_CHAT_CODEX_MODEL_PROVIDER = "openrouter";
    process.env.CODEX_CHAT_CODEX_SERVICE_TIER_MODE = "omit";
    process.env.CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";
    process.env.CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE = "openrouter";
    process.env.CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER = "openrouter";
    process.env.CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE = "omit";
    process.env.CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE = "true";
    process.env.CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES = "openrouter, local";
    process.env.CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS = "openrouter";
    const path = await tempConfig("version = 1\n");

    const config = await loadConfig(path);

    expect(config.codex.profile).toBe("main-profile");
    expect(config.codex.modelProvider).toBe("openrouter");
    expect(config.codex.serviceTierMode).toBe("omit");
    expect(config.subagents.defaultModel).toBe("anthropic/claude-sonnet-4.5");
    expect(config.subagents.defaultCodexProfile).toBe("openrouter");
    expect(config.subagents.defaultModelProvider).toBe("openrouter");
    expect(config.subagents.serviceTierMode).toBe("omit");
    expect(config.subagents.allowProviderOverride).toBe(true);
    expect(config.subagents.allowedCodexProfiles).toEqual(["openrouter", "local"]);
    expect(config.subagents.allowedModelProviders).toEqual(["openrouter"]);
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

  test("loads audio ingest keys from environment without storing raw keys", async () => {
    process.env.CODEXCHAT_INGEST_API_KEYS = "iphone:first-secret,second-secret";
    process.env.CODEXCHAT_AUDIO_INGEST_MAX_MB = "42";
    const path = await tempConfig("version = 1\n");

    const config = await loadConfig(path);

    expect(config.api.enabled).toBe(true);
    expect(config.ingest.audioMaxMb).toBe(42);
    expect(config.ingest.apiKeys).toHaveLength(2);
    expect(config.ingest.apiKeys[0]).toMatchObject({ identity: "iphone" });
    expect(config.ingest.apiKeys.map((key) => key.hash)).not.toContain(
      "first-secret",
    );
  });

  test("parses dynamic Employee config tables into definitions", async () => {
    const path = await tempConfig(`
version = 1

[employees]
enabled = true
rootDir = "employee-root"
socketDir = "employee-sockets"
defaultModel = "gpt-employee-default"
defaultEffort = "low"
maxActive = 1

[employees.email-calendar]
enabled = true
name = "Email/calendar"
directory = "/tmp/email-calendar-employee"
profile = "email-calendar"
model = "gpt-employee"
effort = "high"
startup = "on_demand"
warmupPrompt = "Read the briefing."
warmupFile = "warmup.md"
persistRawLogs = false
compactAfterTask = true

[employees.email-calendar.memory]
enabled = true
persistRawLogs = false
notes = "summaries only"

[employees.email-calendar.capabilities]
allowed = ["draft_replies"]
denied = ["calendar_mutations"]
`);

    const config = await loadConfig(path);
    const employee = config.employees.definitions["email-calendar"];

    expect(config.employees.enabled).toBe(true);
    expect(config.employees.rootDir).toBe("employee-root");
    expect(config.employees.maxActive).toBe(1);
    expect(employee?.enabled).toBe(true);
    expect(employee?.name).toBe("Email/calendar");
    expect(employee?.directory).toBe("/tmp/email-calendar-employee");
    expect(employee?.profile).toBe("email-calendar");
    expect(employee?.model).toBe("gpt-employee");
    expect(employee?.effort).toBe("high");
    expect(employee?.memory.notes).toBe("summaries only");
    expect(employee?.capabilities.allowed).toEqual(["draft_replies"]);
    expect(employee?.capabilities.denied).toEqual(["calendar_mutations"]);
  });

  test("rejects unsafe Employee IDs", async () => {
    const path = await tempConfig(`
version = 1

[employees]
enabled = true

[employees."../outside"]
enabled = true
`);

    await expect(loadConfig(path)).rejects.toThrow(/Employee IDs/);
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

    expect(config.telegram.allowlist.userIds).toEqual([
      111,
      222,
      333,
      "external-user",
    ]);
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

    expect(result).toEqual({
      configCreated: true,
      loopsCreated: true,
      monitorsCreated: true,
    });
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
    await writeFile(
      configPath,
      `
version = 1

[telegram]
opsChatId = 123
`,
    );
    await writeFile(
      join(configDir, "loops.json"),
      JSON.stringify({
        version: 1,
        loops: [
          {
            id: "local",
            enabled: true,
            schedule: "0 * * * *",
            type: "prompt",
            prompt: "Keep me",
          },
        ],
      }),
    );
    await writeFile(
      join(configDir, "monitors.json"),
      JSON.stringify({ version: 1, monitors: [] }),
    );

    const result = await writeDefaultConfigFilesIfMissing(configPath);
    const config = await loadConfig(configPath);
    const loops = await loadLoopsConfig(config);

    expect(result).toEqual({
      configCreated: false,
      loopsCreated: false,
      monitorsCreated: false,
    });
    expect(config.telegram.opsChatId).toBe(123);
    expect(loops.loops[0]?.id).toBe("local");
  });
});
