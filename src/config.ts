import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { parseIngestApiKeys } from "./ingest-auth.js";
import { ensureDir, pathExists, resolveFrom } from "./util.js";

const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const sandboxSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const approvalSchema = z.enum(["untrusted", "on-failure", "on-request", "never"]);
const telegramUserIdSchema = z.union([z.number().int(), z.string().min(1)]);
const subagentBackendSchema = z.enum(["codex_exec", "codex_app_server"]);
const serviceTierSchema = z.enum(["standard", "fast"]);
const employeeStartupSchema = z.enum(["on_demand", "always"]);
const employeeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/, "Employee IDs may contain only letters, numbers, dot, underscore, and dash");

const employeeMemoryPolicySchema = z.object({
  // Placeholder policy: consumed by future Employee compaction/runtime work.
  enabled: z.boolean().default(true),
  persistRawLogs: z.boolean().default(false),
  retentionDays: z.number().int().positive().optional(),
  notes: z.string().default("")
}).default({ enabled: true, persistRawLogs: false, notes: "" });

const employeeCompactionPolicySchema = z.object({
  // Placeholder policy: no compaction worker is started by this scaffold.
  compactAfterTask: z.boolean().default(true),
  interval: z.string().default("manual"),
  maxBriefingBytes: z.number().int().positive().optional(),
  notes: z.string().default("")
}).default({ compactAfterTask: true, interval: "manual", notes: "" });

const employeeCapabilitiesPolicySchema = z.object({
  // Placeholder allow/deny lists for future tool/account integrations.
  allowed: z.array(z.string()).default([]),
  denied: z.array(z.string()).default([]),
  notes: z.string().default("")
}).default({ allowed: [], denied: [], notes: "" });

const employeeAclPolicySchema = z.object({
  // Placeholder ACL: management surfaces are proposal-only in this scaffold.
  telegramUserIds: z.array(telegramUserIdSchema).default([]),
  adminUserIds: z.array(telegramUserIdSchema).default([]),
  notes: z.string().default("")
}).default({ telegramUserIds: [], adminUserIds: [], notes: "" });

const employeeDefinitionSchema = z.object({
  enabled: z.boolean().default(false),
  name: z.string().default(""),
  description: z.string().default(""),
  purpose: z.string().default(""),
  directory: z.string().default(""),
  profile: z.string().default(""),
  model: z.string().default(""),
  effort: effortSchema.optional(),
  startup: employeeStartupSchema.default("on_demand"),
  warmupPrompt: z.string().default(""),
  warmupFile: z.string().default(""),
  gitRemote: z.string().default(""),
  gitBranch: z.string().default("main"),
  persistRawLogs: z.boolean().default(false),
  compactAfterTask: z.boolean().default(true),
  memory: employeeMemoryPolicySchema,
  compaction: employeeCompactionPolicySchema,
  capabilities: employeeCapabilitiesPolicySchema,
  acl: employeeAclPolicySchema
}).strict();

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
    serviceTier: serviceTierSchema.default("fast"),
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
  slack: z.object({
    enabled: z.boolean().default(false),
    eventsPath: z.string().regex(/^\/[A-Za-z0-9/_-]*$/, "Slack events path must be an absolute URL path").default("/api/slack/events"),
    signingSecretEnv: z.string().default("SLACK_SIGNING_SECRET"),
    botTokenEnv: z.string().default("SLACK_BOT_TOKEN"),
    appTokenEnv: z.string().default("SLACK_APP_TOKEN")
  }).default({
    enabled: false,
    eventsPath: "/api/slack/events",
    signingSecretEnv: "SLACK_SIGNING_SECRET",
    botTokenEnv: "SLACK_BOT_TOKEN",
    appTokenEnv: "SLACK_APP_TOKEN"
  }),
  api: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(49346),
    allowNonLocalhost: z.boolean().default(false)
  }),
  admin: z.object({
    enabled: z.boolean().default(false),
    routePath: z.string().regex(/^\/[A-Za-z0-9/_-]*\/$/, "Admin route path must be an absolute path ending in /").default("/admin/codex-chat/"),
    envFile: z.string().default("~/.config/codex-chat/env"),
    serviceName: z.string().default("codex-chat.service"),
    publicBaseUrl: z.string().default("https://me.galebach.com"),
    clerkPublishableKeyEnv: z.string().default("CLERK_PUBLISHABLE_KEY"),
    clerkSecretKeyEnv: z.string().default("CLERK_SECRET_KEY"),
    clerkSignInUrlEnv: z.string().default("CLERK_SIGN_IN_URL"),
    clerkAllowedEmailsEnv: z.string().default("CLERK_ALLOWED_EMAILS")
  }).default({
    enabled: false,
    routePath: "/admin/codex-chat/",
    envFile: "~/.config/codex-chat/env",
    serviceName: "codex-chat.service",
    publicBaseUrl: "https://me.galebach.com",
    clerkPublishableKeyEnv: "CLERK_PUBLISHABLE_KEY",
    clerkSecretKeyEnv: "CLERK_SECRET_KEY",
    clerkSignInUrlEnv: "CLERK_SIGN_IN_URL",
    clerkAllowedEmailsEnv: "CLERK_ALLOWED_EMAILS"
  }),
  behavior: z.object({
    dir: z.string().default("behavior"),
    entrypoint: z.string().default("AGENTS.md"),
    reloadOnSighup: z.boolean().default(true)
  }),
  subagents: z.object({
    enabled: z.boolean().default(true),
    backend: subagentBackendSchema.default("codex_exec"),
    maxConcurrent: z.number().int().positive().default(5),
    defaultModel: z.string().default(""),
    defaultEffort: effortSchema.default("medium"),
    defaultServiceTier: serviceTierSchema.default("fast"),
    defaultTimeoutSec: z.number().int().positive().default(1800),
    maxTimeoutSec: z.number().int().positive().default(7200),
    maxPromptBytes: z.number().int().positive().default(262_144),
    artifactDir: z.string().default("data/subagents"),
    childSocketDir: z.string().default("data/run/subagents"),
    childStartupTimeoutSec: z.number().int().positive().default(60),
    childInterruptGraceMs: z.number().int().positive().default(5000),
    allowedProfiles: z.array(z.string()).default([]),
    cleanupArtifacts: z.boolean().default(true)
  }),
  employees: z.object({
    enabled: z.boolean().default(false),
    rootDir: z.string().default("data/employees"),
    socketDir: z.string().default("data/run/employees"),
    defaultModel: z.string().default("gpt-5.5"),
    defaultEffort: effortSchema.default("medium"),
    maxActive: z.number().int().nonnegative().default(2),
    definitions: z.record(employeeIdSchema, employeeDefinitionSchema).default({})
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
    model: z.string().default("gpt-4o-transcribe"),
    diarizeModel: z.string().default("gpt-4o-transcribe-diarize"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    language: z.string().default(""),
    promptPath: z.string().default("")
  }),
  ingest: z.object({
    apiKeysEnv: z.string().default("CODEXCHAT_INGEST_API_KEYS"),
    apiKeys: z.array(z.object({ identity: z.string(), hash: z.string() })).default([]),
    audioMaxMb: z.number().positive().default(100)
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
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  openaiApiKey?: string;
  clerkPublishableKey?: string;
  clerkSecretKey?: string;
  clerkSignInUrl?: string;
  clerkAllowedEmails?: string;
};
export type EmployeeDefinitionConfig = z.infer<typeof employeeDefinitionSchema>;

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
    serviceTier: "fast",
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
  slack: {
    enabled: false,
    eventsPath: "/api/slack/events",
    signingSecretEnv: "SLACK_SIGNING_SECRET",
    botTokenEnv: "SLACK_BOT_TOKEN",
    appTokenEnv: "SLACK_APP_TOKEN"
  },
  api: {
    enabled: false,
    host: "127.0.0.1",
    port: 49346,
    allowNonLocalhost: false
  },
  admin: {
    enabled: false,
    routePath: "/admin/codex-chat/",
    envFile: "~/.config/codex-chat/env",
    serviceName: "codex-chat.service",
    publicBaseUrl: "https://me.galebach.com",
    clerkPublishableKeyEnv: "CLERK_PUBLISHABLE_KEY",
    clerkSecretKeyEnv: "CLERK_SECRET_KEY",
    clerkSignInUrlEnv: "CLERK_SIGN_IN_URL",
    clerkAllowedEmailsEnv: "CLERK_ALLOWED_EMAILS"
  },
  behavior: {
    dir: "behavior",
    entrypoint: "AGENTS.md",
    reloadOnSighup: true
  },
  subagents: {
    enabled: true,
    backend: "codex_exec",
    maxConcurrent: 5,
    defaultModel: "",
    defaultEffort: "medium",
    defaultServiceTier: "fast",
    defaultTimeoutSec: 1800,
    maxTimeoutSec: 7200,
    maxPromptBytes: 262_144,
    artifactDir: "data/subagents",
    childSocketDir: "data/run/subagents",
    childStartupTimeoutSec: 60,
    childInterruptGraceMs: 5000,
    allowedProfiles: [],
    cleanupArtifacts: true
  },
  employees: {
    enabled: false,
    rootDir: "data/employees",
    socketDir: "data/run/employees",
    defaultModel: "gpt-5.5",
    defaultEffort: "medium",
    maxActive: 2,
    definitions: {}
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
    model: "gpt-4o-transcribe",
    diarizeModel: "gpt-4o-transcribe-diarize",
    apiKeyEnv: "OPENAI_API_KEY",
    language: "",
    promptPath: ""
  },
  ingest: {
    apiKeysEnv: "CODEXCHAT_INGEST_API_KEYS",
    apiKeys: [],
    audioMaxMb: 100
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

function parseNumberEnv(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric environment override: ${value}`);
  return parsed;
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

const employeeTopLevelKeys = new Set([
  "enabled",
  "rootDir",
  "socketDir",
  "defaultModel",
  "defaultEffort",
  "maxActive",
  "definitions"
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeParsedEmployeeConfig(parsed: unknown): unknown {
  if (!isPlainRecord(parsed)) return parsed;
  if (!isPlainRecord(parsed.employees)) return parsed;
  const employees = parsed.employees;
  const existingDefinitions = isPlainRecord(employees.definitions) ? employees.definitions : {};
  const definitions: Record<string, unknown> = { ...existingDefinitions };
  let changed = Object.keys(existingDefinitions).length > 0;

  // Support the plan's TOML shape:
  //
  //   [employees.email-calendar]
  //   enabled = true
  //
  // Internally we normalize dynamic child tables into employees.definitions so
  // the validated AppConfig type stays explicit and safe.
  for (const [key, value] of Object.entries(employees)) {
    if (employeeTopLevelKeys.has(key)) continue;
    if (!isPlainRecord(value)) continue;
    definitions[key] = value;
    delete employees[key];
    changed = true;
  }
  if (changed) employees.definitions = definitions;
  return parsed;
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
    { name: "CODEX_CHAT_CODEX_SERVICE_TIER", path: ["codex", "serviceTier"] },
    { name: "CODEX_CHAT_CODEX_SANDBOX", path: ["codex", "sandbox"] },
    { name: "CODEX_CHAT_CODEX_APPROVAL_POLICY", path: ["codex", "approvalPolicy"] },
    { name: "CODEX_CHAT_SUBAGENTS_BACKEND", path: ["subagents", "backend"] },
    { name: "CODEX_CHAT_API_ENABLED", path: ["api", "enabled"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_API_HOST", path: ["api", "host"] },
    { name: "CODEX_CHAT_API_PORT", path: ["api", "port"], parse: parseNumberEnv },
    { name: "CODEX_CHAT_API_ALLOW_NON_LOCALHOST", path: ["api", "allowNonLocalhost"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_ADMIN_ENABLED", path: ["admin", "enabled"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_ADMIN_ROUTE_PATH", path: ["admin", "routePath"] },
    { name: "CODEX_CHAT_ADMIN_ENV_FILE", path: ["admin", "envFile"] },
    { name: "CODEX_CHAT_ADMIN_SERVICE_NAME", path: ["admin", "serviceName"] },
    { name: "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL", path: ["admin", "publicBaseUrl"] },
    { name: "CODEX_CHAT_BASE_URL", path: ["admin", "publicBaseUrl"] },
    { name: "CODEX_CHAT_TELEGRAM_MODE", path: ["telegram", "mode"] },
    { name: "CODEX_CHAT_SLACK_ENABLED", path: ["slack", "enabled"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_SLACK_EVENTS_PATH", path: ["slack", "eventsPath"] },
    { name: "CODEX_CHAT_LOOPS_PATH", path: ["loops", "path"] },
    { name: "CODEX_CHAT_MONITORS_PATH", path: ["monitors", "path"] },
    { name: "CODEX_CHAT_TRANSCRIPTION_ENABLED", path: ["transcription", "enabled"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_TRANSCRIPTION_MODEL", path: ["transcription", "model"] },
    { name: "CODEX_CHAT_TRANSCRIPTION_DIARIZE_MODEL", path: ["transcription", "diarizeModel"] },
    { name: "CODEX_CHAT_TRANSCRIPTION_PROMPT_PATH", path: ["transcription", "promptPath"] },
    { name: "CODEXCHAT_AUDIO_INGEST_MAX_MB", path: ["ingest", "audioMaxMb"], parse: parseNumberEnv }
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
    parsed = normalizeParsedEmployeeConfig(parseToml(await readFile(absoluteConfigPath, "utf8")));
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
  const slackSigningSecret = process.env[config.slack.signingSecretEnv];
  const slackBotToken = process.env[config.slack.botTokenEnv];
  const slackAppToken = process.env[config.slack.appTokenEnv];
  const openaiApiKey = process.env[config.transcription.apiKeyEnv];
  const clerkPublishableKey = process.env[config.admin.clerkPublishableKeyEnv];
  const clerkSecretKey = process.env[config.admin.clerkSecretKeyEnv];
  const clerkSignInUrl = process.env[config.admin.clerkSignInUrlEnv];
  const clerkAllowedEmails = process.env[config.admin.clerkAllowedEmailsEnv];
  const ingestApiKeys = parseIngestApiKeys(process.env[config.ingest.apiKeysEnv]);
  const api = { ...config.api, enabled: config.api.enabled || ingestApiKeys.length > 0 || config.slack.enabled || config.admin.enabled };
  const ingest = { ...config.ingest, apiKeys: ingestApiKeys };
  return {
    ...config,
    api,
    ingest,
    telegram,
    configPath: absoluteConfigPath,
    rootDir,
    telegramBotToken,
    slackSigningSecret,
    slackBotToken,
    slackAppToken,
    openaiApiKey,
    clerkPublishableKey,
    clerkSecretKey,
    clerkSignInUrl,
    clerkAllowedEmails
  };
}

export function resolveConfigPath(config: AppConfig, candidate: string): string {
  return resolveFrom(config.rootDir, candidate);
}

export async function ensureConfiguredDirectories(config: AppConfig): Promise<void> {
  const dirs = [
    config.service.stateDir,
    config.files.dir,
    config.files.artifactDir,
    "data/files/audio-ingest",
    config.subagents.artifactDir,
    config.subagents.childSocketDir,
    config.employees.rootDir,
    config.employees.socketDir,
    "data/logs",
    "data/run",
    "data/spool/loops",
    "data/locks"
  ];
  for (const dir of dirs) await ensureDir(resolveConfigPath(config, dir));
}

export async function writeDefaultConfigIfMissing(path = "config/codex-chat.toml"): Promise<boolean> {
  return copyExampleIfMissing(path, "codex-chat.example.toml");
}

export interface DefaultConfigWriteResult {
  configCreated: boolean;
  loopsCreated: boolean;
  monitorsCreated: boolean;
}

export async function writeDefaultConfigFilesIfMissing(path = "config/codex-chat.toml"): Promise<DefaultConfigWriteResult> {
  const configCreated = await writeDefaultConfigIfMissing(path);
  const config = await loadConfig(path);
  const loopsCreated = await copyExampleIfMissing(resolveConfigPath(config, config.loops.path), "loops.example.json");
  const monitorsCreated = await copyExampleIfMissing(resolveConfigPath(config, config.monitors.path), "monitors.example.json");
  return { configCreated, loopsCreated, monitorsCreated };
}

async function copyExampleIfMissing(path: string, exampleName: string): Promise<boolean> {
  if (await pathExists(path)) return false;
  await ensureDir(dirname(path));
  const sample = await readFile(new URL(`../config/${exampleName}`, import.meta.url), "utf8");
  await writeFile(path, sample);
  return true;
}
