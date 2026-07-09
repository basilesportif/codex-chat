import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { parseIngestApiKeys } from "./ingest-auth.js";
import { ensureDir, pathExists, resolveFrom } from "./util.js";

const effortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const sandboxSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const approvalSchema = z.enum([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
const telegramUserIdSchema = z.union([z.number().int(), z.string().min(1)]);
const subagentBackendSchema = z.enum(["codex_exec", "codex_app_server", "claude_agent_sdk"]);
const serviceTierSchema = z.enum(["standard", "fast"]);
const serviceTierModeSchema = z.enum(["auto", "always", "omit"]);
const claudePermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]);
const claudeSettingSourceSchema = z.enum(["user", "project", "local"]);
const employeeStartupSchema = z.enum(["on_demand", "always"]);
const employeeIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/,
    "Employee IDs may contain only letters, numbers, dot, underscore, and dash",
  );

const employeeMemoryPolicySchema = z
  .object({
    // Placeholder policy: consumed by future Employee compaction/runtime work.
    enabled: z.boolean().default(true),
    persistRawLogs: z.boolean().default(false),
    retentionDays: z.number().int().positive().optional(),
    notes: z.string().default(""),
  })
  .prefault({});

const employeeCompactionPolicySchema = z
  .object({
    // Placeholder policy: no compaction worker is started by this scaffold.
    compactAfterTask: z.boolean().default(true),
    interval: z.string().default("manual"),
    maxBriefingBytes: z.number().int().positive().optional(),
    notes: z.string().default(""),
  })
  .prefault({});

const employeeCapabilitiesPolicySchema = z
  .object({
    // Placeholder allow/deny lists for future tool/account integrations.
    allowed: z.array(z.string()).default([]),
    denied: z.array(z.string()).default([]),
    notes: z.string().default(""),
  })
  .prefault({});

const employeeAclPolicySchema = z
  .object({
    // Placeholder ACL: management surfaces are proposal-only in this scaffold.
    telegramUserIds: z.array(telegramUserIdSchema).default([]),
    adminUserIds: z.array(telegramUserIdSchema).default([]),
    notes: z.string().default(""),
  })
  .prefault({});

const employeeDefinitionSchema = z
  .object({
    enabled: z.boolean().default(false),
    name: z.string().default(""),
    description: z.string().default(""),
    purpose: z.string().default(""),
    directory: z.string().default(""),
    profile: z.string().default(""),
    codexProfile: z.string().default(""),
    modelProvider: z.string().default(""),
    serviceTier: serviceTierSchema.optional(),
    serviceTierMode: serviceTierModeSchema.optional(),
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
    acl: employeeAclPolicySchema,
  })
  .strict();

const claudeSubagentSchema = z.object({
  enabled: z.boolean().default(false),
  pathToClaudeCodeExecutable: z.string().default(""),
  permissionMode: claudePermissionModeSchema.default("bypassPermissions"),
  allowDangerouslySkipPermissions: z.boolean().default(true),
  allowedTools: z.array(z.string()).default(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep"]),
  disallowedTools: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().default(100),
  // Empty by default so SDK subagents do not load user/project settings
  // that could contain apiKeyHelper or other non-OAuth auth sources.
  settingSources: z.array(claudeSettingSourceSchema).default([]),
  fastMode: z.boolean().default(true),
  // How long to wait after a turn result before settling a job that
  // still has outstanding steers. A steer absorbed into the in-flight
  // run produces no extra result message; if the SDK stays silent for
  // this window, the recorded result is treated as final.
  steerSettleGraceMs: z.number().int().positive().default(10_000),
});

export type ClaudeSubagentConfig = z.infer<typeof claudeSubagentSchema>;

/** Fully-defaulted [subagents.claude] config, derived from the schema. */
export function defaultClaudeSubagentConfig(): ClaudeSubagentConfig {
  return claudeSubagentSchema.parse({});
}

// External filesystem locations the behavior pack and subagent prompts refer
// to. Substituted for the {{LOGIC_REPO}} / {{WORKSPACE}} template tokens in
// behavior/**/*.md when their content is assembled into prompts.
const pathsSchema = z.object({
  logicRepo: z.string().default("/home/tim/pkg/tim/assistant-agent-logic"),
  assistantWorkspace: z.string().default("/home/tim/.assistant-claude/workspace"),
});

export type PathsConfig = z.infer<typeof pathsSchema>;

/** Fully-defaulted [paths] config, derived from the schema. */
export function defaultPathsConfig(): PathsConfig {
  return pathsSchema.parse({});
}

const configSchema = z.object({
  version: z.literal(1).default(1),
  service: z.object({
    name: z.string().default("codex-chat"),
    workspace: z.string().default(process.cwd()),
    stateDir: z.string().default("data/state"),
    logLevel: z.string().default("info"),
    timezone: z.string().default("Etc/UTC"),
    ipcSocket: z.string().default("data/run/codex-chat.sock"),
  }).prefault({}),
  codex: z.object({
    binary: z.string().default("codex"),
    transport: z.string().default("app-server"),
    appServerHost: z.string().default("127.0.0.1"),
    appServerPort: z.number().int().min(1).max(65535).default(49345),
    model: z.string().default("gpt-5.6-terra"),
    effort: effortSchema.default("medium"),
    serviceTier: serviceTierSchema.default("fast"),
    serviceTierMode: serviceTierModeSchema.default("auto"),
    profile: z.string().default(""),
    modelProvider: z.string().default(""),
    providerApiKeyEnvNames: z.array(z.string()).default(["OPENROUTER_API_KEY"]),
    sandbox: sandboxSchema.default("danger-full-access"),
    approvalPolicy: approvalSchema.default("never"),
    mainSessionName: z.string().default("codex-chat-main"),
    startupTimeoutSec: z.number().int().positive().default(60),
    turnTimeoutSec: z.number().int().positive().default(3600),
    keepAliveSec: z.number().int().positive().default(60),
    extraConfig: z
      .array(z.string())
      .default(['model_reasoning_effort="medium"']),
    addDirs: z.array(z.string()).default([]),
    maxRestartAttempts: z.number().int().positive().default(8),
    restartBackoffBaseMs: z.number().int().positive().default(2000),
    restartBackoffMaxMs: z.number().int().positive().default(60000),
  }).prefault({}),
  telegram: z.object({
    mode: z.enum(["polling", "webhook"]).default("polling"),
    botTokenEnv: z.string().default("TELEGRAM_BOT_TOKEN"),
    parseMode: z.enum(["plain", "HTML", "MarkdownV2"]).default("plain"),
    pairingEnabledOnEmptyAllowlist: z.boolean().default(true),
    downloadMaxBytes: z.number().int().positive().default(52_428_800),
    sendProgressUpdates: z.boolean().default(true),
    opsChatId: z.number().int().default(0),
    allowlist: z
      .object({
        userIds: z.array(telegramUserIdSchema).default([]),
        chatIds: z.array(z.number().int()).default([]),
        adminUserIds: z.array(telegramUserIdSchema).default([]),
      })
      .prefault({}),
  }).prefault({}),
  slack: z
    .object({
      enabled: z.boolean().default(false),
      eventsPath: z
        .string()
        .regex(
          /^\/[A-Za-z0-9/_-]*$/,
          "Slack events path must be an absolute URL path",
        )
        .default("/api/slack/events"),
      publicBaseUrl: z.string().default("https://brain.decisive-outcomes.com"),
      signingSecretEnv: z.string().default("SLACK_SIGNING_SECRET"),
      botTokenEnv: z.string().default("SLACK_BOT_TOKEN"),
      appTokenEnv: z.string().default("SLACK_APP_TOKEN"),
      context: z
        .object({
          enabled: z.boolean().default(true),
          maxChannelMessages: z.number().int().positive().max(50).default(15),
          maxThreadMessages: z.number().int().positive().max(100).default(30),
          maxMessageChars: z.number().int().positive().max(2_000).default(700),
          maxTotalChars: z.number().int().positive().max(20_000).default(6_000),
          fetchTimeoutMs: z.number().int().positive().max(10_000).default(2_500),
        })
        .prefault({}),
    })
    .prefault({}),
  brain: z.object({
    enforcementEnabled: z.boolean().default(true),
    storePath: z.string().default("/home/tim/.brain/control-plane/capabilities.json"),
    decisionAuditDir: z.string().default("capability_decisions"),
  }).prefault({}),
  api: z.object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(49346),
    allowNonLocalhost: z.boolean().default(false),
  }).prefault({}),
  behavior: z.object({
    dir: z.string().default("behavior"),
    entrypoint: z.string().default("AGENTS.md"),
    reloadOnSighup: z.boolean().default(true),
  }).prefault({}),
  paths: pathsSchema.prefault({}),
  subagents: z.object({
    enabled: z.boolean().default(true),
    backend: subagentBackendSchema.default("codex_exec"),
    maxConcurrent: z.number().int().positive().default(5),
    defaultModel: z.string().default("gpt-5.6-terra"),
    defaultEffort: effortSchema.default("medium"),
    defaultServiceTier: serviceTierSchema.default("fast"),
    defaultCodexProfile: z.string().default(""),
    defaultModelProvider: z.string().default(""),
    serviceTierMode: serviceTierModeSchema.default("auto"),
    allowProviderOverride: z.boolean().default(false),
    allowedCodexProfiles: z.array(z.string()).default([]),
    allowedModelProviders: z.array(z.string()).default([]),
    defaultTimeoutSec: z.number().int().positive().default(1800),
    maxTimeoutSec: z.number().int().positive().default(7200),
    maxPromptBytes: z.number().int().positive().default(262_144),
    artifactDir: z.string().default("data/subagents"),
    childSocketDir: z.string().default("data/run/subagents"),
    childStartupTimeoutSec: z.number().int().positive().default(60),
    childInterruptGraceMs: z.number().int().positive().default(5000),
    allowedProfiles: z.array(z.string()).default([]),
    cleanupArtifacts: z.boolean().default(true),
    claude: claudeSubagentSchema.prefault({}),
  }).prefault({}),
  employees: z.object({
    enabled: z.boolean().default(false),
    rootDir: z.string().default("data/employees"),
    socketDir: z.string().default("data/run/employees"),
    defaultModel: z.string().default("gpt-5.6-terra"),
    defaultEffort: effortSchema.default("medium"),
    maxActive: z.number().int().nonnegative().default(2),
    definitions: z
      .record(employeeIdSchema, employeeDefinitionSchema)
      .default({}),
  }).prefault({}),
  loops: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default("config/loops.json"),
    namespace: z.string().default("codex-chat"),
    runnerCommand: z.string().default("codex-chat loop run"),
  }).prefault({}),
  monitors: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default("config/monitors.json"),
    maxRestartBackoffSec: z.number().int().positive().default(300),
  }).prefault({}),
  files: z.object({
    dir: z.string().default("data/files"),
    artifactDir: z.string().default("data/artifacts"),
    allowedSendRoots: z.array(z.string()).default(["data", process.cwd()]),
  }).prefault({}),
  transcription: z.object({
    enabled: z.boolean().default(true),
    provider: z.enum(["openai"]).default("openai"),
    model: z.string().default("gpt-4o-transcribe"),
    diarizeModel: z.string().default("gpt-4o-transcribe-diarize"),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
    language: z.string().default(""),
    promptPath: z.string().default(""),
  }).prefault({}),
  ingest: z.object({
    apiKeysEnv: z.string().default("CODEXCHAT_INGEST_API_KEYS"),
    apiKeys: z
      .array(z.object({ identity: z.string(), hash: z.string() }))
      .default([]),
    audioMaxMb: z.number().positive().default(100),
  }).prefault({}),
  security: z.object({
    redactSecretsInLogs: z.boolean().default(true),
    requireLocalFileForSend: z.boolean().default(true),
    allowShellActionsFromDirectives: z.boolean().default(false),
  }).prefault({}),
});

export type AppConfig = z.infer<typeof configSchema> & {
  configPath: string;
  rootDir: string;
  telegramBotToken?: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  openaiApiKey?: string;
};
export type EmployeeDefinitionConfig = z.infer<typeof employeeDefinitionSchema>;

// Every default lives on the schema fields above; parsing an empty object
// materializes the fully-defaulted config used as the deepMerge base.
const defaultConfig = configSchema.parse({});

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override))
    return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const old = out[key];
    if (
      old &&
      typeof old === "object" &&
      !Array.isArray(old) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(old, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function setDeep(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let cursor = target;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next))
      cursor[key] = {};
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
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid numeric environment override: ${value}`);
  return parsed;
}

function splitCsvEnv(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)));
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

function uniqueTelegramUserIds(
  values: Array<number | string>,
): Array<number | string> {
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
  "definitions",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeParsedEmployeeConfig(parsed: unknown): unknown {
  if (!isPlainRecord(parsed)) return parsed;
  if (!isPlainRecord(parsed.employees)) return parsed;
  const employees = parsed.employees;
  const existingDefinitions = isPlainRecord(employees.definitions)
    ? employees.definitions
    : {};
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

export type EnvOverrideSpec = {
  name: string;
  path: string[];
  parse?: (value: string) => unknown;
};

export type ConfigEnvValueKind = "string" | "boolean" | "number" | "csv";

/**
 * The canonical set of environment-variable overrides codex-chat understands,
 * mapped to their config paths. Exported so the IPC `set_config` writer can
 * validate incoming keys/types against the same source of truth loadConfig
 * uses — there is no second registry to drift.
 */
export const ENV_OVERRIDE_SPECS: EnvOverrideSpec[] = [
    { name: "CODEX_CHAT_WORKSPACE", path: ["service", "workspace"] },
    { name: "CODEX_CHAT_STATE_DIR", path: ["service", "stateDir"] },
    { name: "CODEX_CHAT_LOG_LEVEL", path: ["service", "logLevel"] },
    { name: "CODEX_CHAT_CODEX_BINARY", path: ["codex", "binary"] },
    { name: "CODEX_CHAT_CODEX_MODEL", path: ["codex", "model"] },
    { name: "CODEX_CHAT_CODEX_EFFORT", path: ["codex", "effort"] },
    { name: "CODEX_CHAT_CODEX_SERVICE_TIER", path: ["codex", "serviceTier"] },
    { name: "CODEX_CHAT_CODEX_SERVICE_TIER_MODE", path: ["codex", "serviceTierMode"] },
    { name: "CODEX_CHAT_CODEX_PROFILE", path: ["codex", "profile"] },
    { name: "CODEX_CHAT_CODEX_MODEL_PROVIDER", path: ["codex", "modelProvider"] },
    { name: "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL", path: ["subagents", "defaultModel"] },
    { name: "CODEX_CHAT_SUBAGENTS_DEFAULT_CODEX_PROFILE", path: ["subagents", "defaultCodexProfile"] },
    { name: "CODEX_CHAT_SUBAGENTS_DEFAULT_MODEL_PROVIDER", path: ["subagents", "defaultModelProvider"] },
    { name: "CODEX_CHAT_SUBAGENTS_SERVICE_TIER_MODE", path: ["subagents", "serviceTierMode"] },
    { name: "CODEX_CHAT_SUBAGENTS_ALLOW_PROVIDER_OVERRIDE", path: ["subagents", "allowProviderOverride"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_SUBAGENTS_ALLOWED_CODEX_PROFILES", path: ["subagents", "allowedCodexProfiles"], parse: splitCsvEnv },
    { name: "CODEX_CHAT_SUBAGENTS_ALLOWED_MODEL_PROVIDERS", path: ["subagents", "allowedModelProviders"], parse: splitCsvEnv },
    { name: "CODEX_CHAT_CODEX_SANDBOX", path: ["codex", "sandbox"] },
    {
      name: "CODEX_CHAT_CODEX_APPROVAL_POLICY",
      path: ["codex", "approvalPolicy"],
    },
    { name: "CODEX_CHAT_SUBAGENTS_BACKEND", path: ["subagents", "backend"] },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_ENABLED", path: ["subagents", "claude", "enabled"], parse: parseBooleanEnv },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_PATH", path: ["subagents", "claude", "pathToClaudeCodeExecutable"] },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_PERMISSION_MODE", path: ["subagents", "claude", "permissionMode"] },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_ALLOWED_TOOLS", path: ["subagents", "claude", "allowedTools"], parse: splitCsvEnv },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_DISALLOWED_TOOLS", path: ["subagents", "claude", "disallowedTools"], parse: splitCsvEnv },
    { name: "CODEX_CHAT_SUBAGENTS_CLAUDE_FAST_MODE", path: ["subagents", "claude", "fastMode"], parse: parseBooleanEnv },
    {
      name: "CODEX_CHAT_API_ENABLED",
      path: ["api", "enabled"],
      parse: parseBooleanEnv,
    },
    { name: "CODEX_CHAT_API_HOST", path: ["api", "host"] },
    {
      name: "CODEX_CHAT_API_PORT",
      path: ["api", "port"],
      parse: parseNumberEnv,
    },
    {
      name: "CODEX_CHAT_API_ALLOW_NON_LOCALHOST",
      path: ["api", "allowNonLocalhost"],
      parse: parseBooleanEnv,
    },
    { name: "CODEX_CHAT_BASE_URL", path: ["slack", "publicBaseUrl"] },
    { name: "CODEX_CHAT_TELEGRAM_MODE", path: ["telegram", "mode"] },
    {
      name: "CODEX_CHAT_SLACK_ENABLED",
      path: ["slack", "enabled"],
      parse: parseBooleanEnv,
    },
    { name: "CODEX_CHAT_SLACK_EVENTS_PATH", path: ["slack", "eventsPath"] },
    { name: "CODEX_CHAT_LOOPS_PATH", path: ["loops", "path"] },
    { name: "CODEX_CHAT_MONITORS_PATH", path: ["monitors", "path"] },
    {
      name: "CODEX_CHAT_TRANSCRIPTION_ENABLED",
      path: ["transcription", "enabled"],
      parse: parseBooleanEnv,
    },
    {
      name: "CODEX_CHAT_TRANSCRIPTION_MODEL",
      path: ["transcription", "model"],
    },
    {
      name: "CODEX_CHAT_TRANSCRIPTION_DIARIZE_MODEL",
      path: ["transcription", "diarizeModel"],
    },
    {
      name: "CODEX_CHAT_TRANSCRIPTION_PROMPT_PATH",
      path: ["transcription", "promptPath"],
    },
    {
      name: "CODEXCHAT_AUDIO_INGEST_MAX_MB",
      path: ["ingest", "audioMaxMb"],
      parse: parseNumberEnv,
    },
];

/** The value shape a given env override expects, derived from its parser. */
export function configEnvValueKind(spec: EnvOverrideSpec): ConfigEnvValueKind {
  if (spec.parse === parseBooleanEnv) return "boolean";
  if (spec.parse === parseNumberEnv) return "number";
  if (spec.parse === splitCsvEnv) return "csv";
  return "string";
}

function collectEnvOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of ENV_OVERRIDE_SPECS) {
    const value = env[spec.name];
    if (value !== undefined)
      setDeep(out, spec.path, spec.parse ? spec.parse(value) : value);
  }
  return out;
}

export async function loadConfig(
  configPath = "config/codex-chat.toml",
): Promise<AppConfig> {
  const absoluteConfigPath = resolve(configPath);
  let parsed: unknown = {};
  if (await pathExists(absoluteConfigPath)) {
    parsed = normalizeParsedEmployeeConfig(
      parseToml(await readFile(absoluteConfigPath, "utf8")),
    );
  }
  const merged = deepMerge(
    deepMerge(defaultConfig, parsed),
    collectEnvOverrides(),
  );
  const config = configSchema.parse(merged);
  const envAllowedUserIds = parseTelegramUserIdEnvList(
    process.env.TELEGRAM_ALLOWED_USER_IDS ?? "",
  );
  const envAdminUserIds = parseTelegramUserIdEnvList(
    process.env.TELEGRAM_ADMIN_USER_IDS ?? "",
  );
  const telegram = {
    ...config.telegram,
    allowlist: {
      ...config.telegram.allowlist,
      userIds: uniqueTelegramUserIds([
        ...config.telegram.allowlist.userIds,
        ...envAllowedUserIds,
      ]),
      adminUserIds: uniqueTelegramUserIds([
        ...config.telegram.allowlist.adminUserIds,
        ...envAdminUserIds,
      ]),
    },
  };
  const rootDir = resolve(dirname(absoluteConfigPath), "..");
  const telegramBotToken = process.env[telegram.botTokenEnv];
  const slackSigningSecret = process.env[config.slack.signingSecretEnv];
  const slackBotToken = process.env[config.slack.botTokenEnv];
  const slackAppToken = process.env[config.slack.appTokenEnv];
  const openaiApiKey = process.env[config.transcription.apiKeyEnv];
  const ingestApiKeys = parseIngestApiKeys(
    process.env[config.ingest.apiKeysEnv],
  );
  const api = {
    ...config.api,
    enabled:
      config.api.enabled ||
      ingestApiKeys.length > 0 ||
      config.slack.enabled,
  };
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
  };
}

export function resolveConfigPath(
  config: AppConfig,
  candidate: string,
): string {
  return resolveFrom(config.rootDir, candidate);
}

export async function ensureConfiguredDirectories(
  config: AppConfig,
): Promise<void> {
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
    "data/locks",
  ];
  for (const dir of dirs) await ensureDir(resolveConfigPath(config, dir));
}

async function writeDefaultConfigIfMissing(
  path = "config/codex-chat.toml",
): Promise<boolean> {
  return copyExampleIfMissing(path, "codex-chat.example.toml");
}

export interface DefaultConfigWriteResult {
  configCreated: boolean;
  loopsCreated: boolean;
  monitorsCreated: boolean;
}

export async function writeDefaultConfigFilesIfMissing(
  path = "config/codex-chat.toml",
): Promise<DefaultConfigWriteResult> {
  const configCreated = await writeDefaultConfigIfMissing(path);
  const config = await loadConfig(path);
  const loopsCreated = await copyExampleIfMissing(
    resolveConfigPath(config, config.loops.path),
    "loops.example.json",
  );
  const monitorsCreated = await copyExampleIfMissing(
    resolveConfigPath(config, config.monitors.path),
    "monitors.example.json",
  );
  return { configCreated, loopsCreated, monitorsCreated };
}

async function copyExampleIfMissing(
  path: string,
  exampleName: string,
): Promise<boolean> {
  if (await pathExists(path)) return false;
  await ensureDir(dirname(path));
  const sample = await readFile(
    new URL(`../config/${exampleName}`, import.meta.url),
    "utf8",
  );
  await writeFile(path, sample);
  return true;
}
