import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig, type AppConfig } from "../config.js";
import {
  knownConfigEnvKeys,
  mergeEnvFileText,
  persistEnvEntries,
  resolveEnvStorePath,
  validateConfigEntries,
} from "../config-store.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function loadTestConfig(): Promise<AppConfig> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-config-store-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1
[service]
workspace = "${root}"
logLevel = "silent"
`);
  return loadConfig(join(configDir, "codex-chat.toml"));
}

function parseSystemdEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue = ""] = match;
    out[key] = rawValue.startsWith("'") && rawValue.endsWith("'") ? rawValue.slice(1, -1) : rawValue;
  }
  return out;
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CODEX_CHAT_ENV_FILE;
  delete process.env.CODEX_CHAT_API_ENABLED;
  delete process.env.CODEX_CHAT_API_PORT;
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("validateConfigEntries", () => {
  test("accepts known typed and secret keys, returns them sanitized", async () => {
    const config = await loadTestConfig();
    const slackValue = ["fake", "slack"].join("-");
    const telegramValue = ["123", "fake"].join(":");
    const result = validateConfigEntries(config, {
      CODEX_CHAT_CODEX_MODEL: "gpt-5.5",
      CODEX_CHAT_API_PORT: "49346",
      SLACK_SIGNING_SECRET: slackValue,
      TELEGRAM_BOT_TOKEN: telegramValue,
    });
    expect(result.fieldErrors).toBeUndefined();
    expect(result.sanitized).toEqual({
      CODEX_CHAT_CODEX_MODEL: "gpt-5.5",
      CODEX_CHAT_API_PORT: "49346",
      SLACK_SIGNING_SECRET: slackValue,
      TELEGRAM_BOT_TOKEN: telegramValue,
    });
  });

  test("rejects unknown keys and invalid typed values without echoing values", async () => {
    const config = await loadTestConfig();
    const result = validateConfigEntries(config, {
      NOT_A_REAL_KEY: "whatever",
      CODEX_CHAT_API_PORT: "not-a-number",
    });
    expect(result.fieldErrors).toEqual({
      NOT_A_REAL_KEY: "unknown configuration key",
      CODEX_CHAT_API_PORT: "invalid value (expected number)",
    });
    expect(JSON.stringify(result.fieldErrors)).not.toContain("not-a-number");
    expect(result.sanitized).toEqual({});
  });

  test("accepts empty string as a clear and rejects non-string values", async () => {
    const config = await loadTestConfig();
    const result = validateConfigEntries(config, {
      SLACK_SIGNING_SECRET: "",
      CODEX_CHAT_API_PORT: 49346 as unknown as string,
    });
    expect(result.sanitized).toEqual({ SLACK_SIGNING_SECRET: "" });
    expect(result.fieldErrors).toEqual({ CODEX_CHAT_API_PORT: "value must be a string" });
  });

  test("rejects values containing control characters or single quotes without echoing values", async () => {
    const config = await loadTestConfig();
    const injected = ["model", "LD_PRELOAD=/tmp/nope"].join("\n");
    const quoted = ["ab", "cd"].join("'");
    const result = validateConfigEntries(config, {
      CODEX_CHAT_CODEX_MODEL: injected,
      SLACK_SIGNING_SECRET: quoted,
    });
    expect(result.fieldErrors).toEqual({
      CODEX_CHAT_CODEX_MODEL: "value may not contain control characters",
      SLACK_SIGNING_SECRET: "value may not contain a single quote",
    });
    expect(JSON.stringify(result.fieldErrors)).not.toContain("LD_PRELOAD");
    expect(JSON.stringify(result.fieldErrors)).not.toContain(quoted);
    expect(result.sanitized).toEqual({});
  });

  test("rejects a non-object entries payload", async () => {
    const config = await loadTestConfig();
    expect(validateConfigEntries(config, "nope").fieldErrors).toEqual({
      entries: "entries must be an object of string values",
    });
  });

  test("secret env names are marked secret in the registry", async () => {
    const config = await loadTestConfig();
    const known = knownConfigEnvKeys(config);
    expect(known.get("SLACK_SIGNING_SECRET")?.secret).toBe(true);
    expect(known.get("TELEGRAM_BOT_TOKEN")?.secret).toBe(true);
    expect(known.get("CODEX_CHAT_CODEX_MODEL")?.secret).toBe(false);
  });
});

describe("resolveEnvStorePath", () => {
  test("honors the CODEX_CHAT_ENV_FILE override", () => {
    process.env.CODEX_CHAT_ENV_FILE = "/tmp/some/codex-chat/env";
    expect(resolveEnvStorePath()).toBe("/tmp/some/codex-chat/env");
  });
});

describe("mergeEnvFileText", () => {
  test("rewrites existing keys and preserves unrelated lines", () => {
    const source = "# comment\nTELEGRAM_BOT_TOKEN=old\nOTHER_KEY=keep\n";
    const merged = mergeEnvFileText(source, { TELEGRAM_BOT_TOKEN: "new" });
    expect(merged).toContain("# comment");
    expect(merged).toContain("OTHER_KEY=keep");
    expect(merged).toContain("TELEGRAM_BOT_TOKEN='new'");
    expect(merged).not.toContain("TELEGRAM_BOT_TOKEN=old");
  });

  test("appends new keys under a managed marker", () => {
    const slackValue = ["fake", "slack"].join("-");
    const merged = mergeEnvFileText("EXISTING=1\n", { SLACK_SIGNING_SECRET: slackValue });
    expect(merged).toContain("EXISTING=1");
    expect(merged).toContain("# Managed by codex-chat set_config");
    expect(merged).toContain(`SLACK_SIGNING_SECRET='${slackValue}'`);
  });

  test("clears existing keys by removing their env lines", () => {
    const source = "CODEX_CHAT_API_ENABLED='true'\nCODEX_CHAT_API_PORT='49200'\nOTHER_KEY=keep\n";
    const merged = mergeEnvFileText(source, { CODEX_CHAT_API_ENABLED: "", CODEX_CHAT_API_PORT: "" });
    expect(merged).toBe("OTHER_KEY=keep\n");
  });

  test("writes plain single-quoted values that round-trip through systemd-style parsing", () => {
    const fakeValue = ["fake", "value"].join("-");
    const merged = mergeEnvFileText("", {
      SLACK_SIGNING_SECRET: fakeValue,
      CODEX_CHAT_CODEX_MODEL: "gpt-5.5",
    });
    expect(merged).toContain(`SLACK_SIGNING_SECRET='${fakeValue}'`);
    expect(merged).not.toContain(`"'"`);
    expect(parseSystemdEnvText(merged)).toMatchObject({
      SLACK_SIGNING_SECRET: fakeValue,
      CODEX_CHAT_CODEX_MODEL: "gpt-5.5",
    });
  });
});

describe("persistEnvEntries", () => {
  test("atomically writes 0600, preserving unrelated entries and round-tripping secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-env-store-"));
    tempDirs.push(root);
    const envPath = join(root, "codex-chat", "env");
    await mkdir(join(root, "codex-chat"), { recursive: true });
    await writeFile(envPath, "UNRELATED=leave-me\nTELEGRAM_BOT_TOKEN=old\n");
    const telegramValue = ["123", "new"].join(":");
    const slackValue = ["fake", "slack"].join("-");

    await persistEnvEntries(envPath, { TELEGRAM_BOT_TOKEN: telegramValue, SLACK_SIGNING_SECRET: slackValue });

    const text = await readFile(envPath, "utf8");
    expect(text).toContain("UNRELATED=leave-me");
    expect(text).toContain(`TELEGRAM_BOT_TOKEN='${telegramValue}'`);
    expect(text).toContain(`SLACK_SIGNING_SECRET='${slackValue}'`);
    const info = await stat(envPath);
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("is a no-op when there is nothing to write", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-chat-env-store-"));
    tempDirs.push(root);
    const envPath = join(root, "env");
    await persistEnvEntries(envPath, {});
    await expect(stat(envPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("persists empty-string clears as deleted lines so fresh config loads defaults", async () => {
    const config = await loadTestConfig();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-env-store-"));
    tempDirs.push(root);
    const envPath = join(root, "env");

    await persistEnvEntries(envPath, { CODEX_CHAT_API_ENABLED: "true", CODEX_CHAT_API_PORT: "49200" });
    Object.assign(process.env, parseSystemdEnvText(await readFile(envPath, "utf8")));
    const overridden = await loadConfig(config.configPath);
    expect(overridden.api.enabled).toBe(true);
    expect(overridden.api.port).toBe(49200);

    await persistEnvEntries(envPath, { CODEX_CHAT_API_ENABLED: "", CODEX_CHAT_API_PORT: "" });
    const text = await readFile(envPath, "utf8");
    expect(text).not.toContain("CODEX_CHAT_API_ENABLED=");
    expect(text).not.toContain("CODEX_CHAT_API_PORT=");

    delete process.env.CODEX_CHAT_API_ENABLED;
    delete process.env.CODEX_CHAT_API_PORT;
    Object.assign(process.env, parseSystemdEnvText(text));
    const fresh = await loadConfig(config.configPath);
    expect(fresh.api.enabled).toBe(false);
    expect(fresh.api.port).toBe(49346);
  });

  test("leaves the env file untouched when validation rejects an injected value", async () => {
    const config = await loadTestConfig();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-env-store-"));
    tempDirs.push(root);
    const envPath = join(root, "env");
    const original = "UNRELATED=keep\n";
    await writeFile(envPath, original);

    const result = validateConfigEntries(config, {
      CODEX_CHAT_CODEX_MODEL: ["gpt-5.5", "LD_PRELOAD=/tmp/nope"].join("\n"),
    });
    if (!result.fieldErrors) await persistEnvEntries(envPath, result.sanitized);

    await expect(readFile(envPath, "utf8")).resolves.toBe(original);
  });
});
