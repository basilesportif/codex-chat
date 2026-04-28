import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ensureDir, pathExists, resolveFrom } from "./util.js";

const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const approvalSchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const telegramUserIdSchema = z.union([z.number().int(), z.string().min(1)]);

const configSchema = z.object({
  version: z.literal(1).default(1),
  service: z.object({
    name: z.string().default("codex-chat"),
    workspace: z.string().default(process.cwd()),
    stateDir: z.string().default("data/state"),
    logLevel: z.string().default("info"),
    timezone: z.string().default("Etc/UTC"),
    ipcSocket: z.string().default("data/run/codex-chat.sock")
  }),
  codex: z.object({
    binary: z.string().default("codex"),
    transport: z.string().default("app-server"),
    appServerHost: z.string().default("127.0.0.1"),
    appServerPort: z.number().int().min(1).max(65535).default(49345),
    model: z.string().default("gpt-5.5"),
    effort: effortSchema.default("medium"),
    profile: z.string().default(""),
    sandbox: sandboxSchema.default("danger-full-access"),
    approvalPolicy: approvalSchema.default("never"),
    mainSessionName: z.string().default("codex-chat-main"),
    startupTimeoutSec: z.number().int().positive().default(60),
    turnTimeoutSec: z.number().int().positive().default(3600),
    keepAliveSec: z.number().int().positive().default(60),
    extraConfig: z.array(z.string()).default(['model_reasoning_effort="medium"']),
    addDirs: z.array(z.string()).default([]),
    maxRestartAttempts: z.number().int().positive().default(8),
    restartBackoffBaseMs: z.number().int().positive().default(2000),
    restartBackoffMaxMs: z.number().int().positive().default(60000)
  }),
  telegram: z.object({
    mode: z.enum(["polling", "webhook"]).default("polling"),
    botTokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
    parseMode: z.enum(["plain", "HTML", "MarkdownV2"]).default("plain"),
    pairingEnabledOnEmptyAllowlist: z.boolean().default(true),
    downloadMaxBytes: z.number().int().positive().default(52_428_800),
    sendProgressUpdates: z.boolean().default(true),
    opsChatId: z.number().int().default(0),
    allowlist: z.object({
      userIds: z.array(telegramUserIdSchema).default([]),
      chatIds: z.array(z.number().int()).default([]),
      adminUserIds: z.array(telegramUserIdSchema).default([])
    }).default({ userIds: [], chatIds: [], adminUserIds: [] })
  }),
  behavior: z.object({
    dir: z.string().default("behavior"),
    entrypoint: z.string().default("AGENTS.md"),
    reloadOnSighup: z.boolean().default(true)
  }),
  subagents: z.object({
    enabled: z.boolean().default(true),
    maxConcurrent: z.number().int().positive().default(5),
    defaultModel: z.string().default(""),
    defaultEffort: effortSchema.default("medium"),
    defaultTimeoutSec: z.number().int().positive().default(1800),
    maxTimeoutSec: z.number().int().positive().default(7200),
    maxPromptBytes: z.number().int().positive().default(262_144),
    artifactDir: z.string().default("data/subagents"),
    allowedProfiles: z.array(z.string()).default([]),
    cleanupArtifacts: z.boolean().default(true)
  }),
  loops: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default("config/loops.json"),
    namespace: z.string().default("codex-chat"),
    runnerCommand: z.string().default("codex-chat loop run")
  }),
  monitors: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default("config/monitors.json"),
    maxRestartBackoffSec: z.number().int().positive().default(300)
  }),
  files: z.object({
    dir: z.string().default("data/files"),
    artifactDir: z.string().default("data/artifacts"),
    allowedSendRoots: z.array(z.string()).default(["data", process.cwd()])
  }),
  transcription: z.object({
    enabled: z.boolean().default(true),
    provider: z.enum(["openai"]).default("openai"),
    model: z.string().default("gpt-4o-mini-transcribe"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    language: z.string().default("")
  }),
  security: z.object({
    redactSecretsInLogs: z.boolean().default(true),
    requireLocalFileForSend: z.boolean().default(true),
    allowShellActionsFromDirectives: z.boolean().default(false)
  })
});

export type AppConfig = z.infer<typeof configSchema> & {
  configPath: string;
  rootDir: string;
  telegramBotToken?: string;
  openaiApiKey?: string;
};

const defaultConfig = configSchema.parse({
  version: 1,
  service: {
    name: "codex-chat",
    workspace: process.cwd(),
    stateDir: "data/state",
    logLevel: "info",
    timezone: "Etc/UTC",
    ipcSocket: "data/run/codex-chat.sock"
  },
  codex: {
    binary: "codex",
    transport: "app-server",
    appServerHost: "127.0.0.1",
    appServerPort: 49345,
    model: "gpt-5.5",
    effort: "medium",
    profile: "",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    mainSessionName: "codex-chat-main",
    startupTimeoutSec: 60,
    turnTimeoutSec: 3600,
    keepAliveSec: 60,
    extraConfig: ['model_reasoning_effort="medium"'],
    addDirs: [],
    maxRestartAttempts: 8,
    restartBackoffBaseMs: 2000,
    restartBackoffMaxMs: 60000
  },
  telegram: {
    mode: "polling",
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    parseMode: "plain",
    pairingEnabledOnEmptyAllowlist: true,
    downloadMaxBytes: 52_428_800,
    sendProgressUpdates: true,
    opsChatId: 0,
    allowlist: { userIds: [], chatIds: [], adminUserIds: [] }
  },
  behavior: {
    dir: "behavior",
    entrypoint: "AGENTS.md",
    reloadOnSighup: true
  },
  subagents: {
    enabled: true,
    maxConcurrent: 5,
    defaultModel: "",
    defaultEffort: "medium",
    defaultTimeoutSec: 1800,
    maxTimeoutSec: 7200,
    maxPromptBytes: 262_144,
    artifactDir: "data/subagents",
    allowedProfiles: [],
    cleanupArtifacts: true
  },
  loops: {
    enabled: true,
    path: "config/loops.json",
    namespace: "codex-chat",
    runnerCommand: "codex-chat loop run"
  },
  monitors: {
    enabled: true,
    path: "config/monitors.json",
    maxRestartBackoffSec: 300
  },
  files: {
    dir: "data/files",
    artifactDir: "data/artifacts",
    allowedSendRoots: ["data", process.cwd()]
  },
  transcription: {
    enabled: true,
    provider: "openai",
    model: "gpt-4o-mini-transcribe",
    apiKeyEnv: "OPENAI_API_KEY",
    language: ""
  },
  security: {
    redactSecretsInLogs: true,
    requireLocalFileForSend: true,
    allowShellActionsFromDirectives: false
  }
});

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const old = out[key];
    if (old && typeof old === "object" && !Array.isArray(old) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = deepMerge(old, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function setDeep(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1] as string] = value;
}

function parseBooleanEnv(value: string): boolean {
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean environment override: ${value}`);
}

function parseTelegramUserIdEnvList(value: string): Array<number | string> {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (/^\d+$/.test(part)) {
        const numeric = Number(part);
        if (Number.isSafeInteger(numeric)) return numeric;
      }
      return part;
    });
}

function uniqueTelegramUserIds(values: Array<number | string>): Array<number | string> {
  const seen = new Set<string>();
  const out: Array<number | string> = [];
  for (const value of values) {
    const key = String(value).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function collectEnvOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const specs: Array<{ name: string; path: string[]; parse?: (value: string) => unknown }> = [
    { name: "CODEX_CHAT_WORKSPACE", path: ["service", "workspace"] },
    { name: "CODEX_CHAT_STATE_DIR", path: ["service", "stateDir"] },
    { name: "CODEX_CHAT_LOG_LEVEL", path: ["service", "logLevel"] },
    { name: "CODEX_CHAT_CODEX_BINARY", path: ["codex", "binary"] },
    { name: "CODEX_CHAT_CODEX_MODEL", path: ["codex", "model"] },
    { name: "CODEX_CHAT_CODEX_EFFORT", path: ["codex", "effort"] },
    { name: "CODEX_CHAT_CODEX_SANDBOX", path: ["codex", "sandbox"] },
    { name: "CODEX_CHAT_CODEX_APPROVAL_POLICY", path: ["codex", "approvalPolicy"] },
    { name: "CODEX_CHAT_TELEGRAM_MODE", path: ["telegram", "mode"] },
    { name: "CODEX_CHAT_LOOPS_PATH", path: ["loops", "path"] },
    { name: "CODEX_CHAT_MONITORS_PATH", path: ["monitors", "path"] },
    { name: "CODEX_CHAT_TRANSCRIPTION_ENABLED", path: ["transcription", "enabled"], parse: parseBooleanEnv }
  ];
  for (const spec of specs) {
    const value = env[spec.name];
    if (value !== undefined) setDeep(out, spec.path, spec.parse ? spec.parse(value) : value);
  }
  return out;
}

export async function loadConfig(configPath = "config/codex-chat.toml"): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  let parsed: unknown = {};
  if (await pathExists(absoluteConfigPath)) {
    parsed = parseToml(await readFile(absoluteConfigPath, "utf8"));
  }
  const merged = deepMerge(deepMerge(defaultConfig, parsed), collectEnvOverrides());
  const config = configSchema.parse(merged);
  const envAllowedUserIds = parseTelegramUserIdEnvList(process.env.TELEGRAM_ALLOWED_USER_IDS ?? "");
  const envAdminUserIds = parseTelegramUserIdEnvList(process.env.TELEGRAM_ADMIN_USER_IDS ?? "");
  const telegram = {
    ...config.telegram,
    allowlist: {
      ...config.telegram.allowlist,
      userIds: uniqueTelegramUserIds([...config.telegram.allowlist.userIds, ...envAllowedUserIds]),
      adminUserIds: uniqueTelegramUserIds([...config.telegram.allowlist.adminUserIds, ...envAdminUserIds])
    }
  };
  const rootDir = resolve(dirname(absoluteConfigPath), "..");
  const telegramBotToken = process.env[telegram.botTokenEnv];
  const openaiApiKey = process.env[config.transcription.apiKeyEnv];
  return { ...config, telegram, configPath: absoluteConfigPath, rootDir, telegramBotToken, openaiApiKey };
}

export function resolveConfigPath(config: AppConfig, candidate: string): string {
  return resolveFrom(config.rootDir, candidate);
}

export async function ensureConfiguredDirectories(config: AppConfig): Promise<void> {
  const dirs = [
    config.service.stateDir,
    config.files.dir,
    config.files.artifactDir,
    config.subagents.artifactDir,
    "data/logs",
    "data/run",
    "data/spool/loops",
    "data/locks"
  ];
  for (const dir of dirs) await ensureDir(resolveConfigPath(config, dir));
}

export async function writeDefaultConfigIfMissing(path = "config/codex-chat.toml"): Promise<boolean> {
  if (await pathExists(path)) return false;
  await ensureDir(dirname(path));
  const sample = await readFile(new URL("../config/codex-chat.toml", import.meta.url), "utf8").catch(() => "");
  await writeFile(path, sample);
  return true;
}
