import type { AppConfig } from "./config.js";

export type ChildEnvSource = Record<string, string | undefined>;

export const ALWAYS_STRIPPED_CHILD_ENV = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES"
] as const;

export const CLAUDE_OAUTH_CHILD_ENV = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES"
] as const;

export const CLAUDE_NON_OAUTH_AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "CLOUD_ML_REGION"
] as const;

export interface ChildEnvOptions {
  allowSecretEnvNames?: readonly string[];
}

/**
 * Secret-bearing env vars that must not be inherited by generic child
 * processes. Codex provider auth is passed only through sanitizeCodexChildProcessEnv,
 * where the operator-configured env var names are allowlisted for Codex itself.
 */
export function childSecretEnvNames(config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack" | "codex">>): string[] {
  const names = new Set<string>(ALWAYS_STRIPPED_CHILD_ENV);
  const transcriptionKeyEnv = config?.transcription?.apiKeyEnv?.trim();
  if (transcriptionKeyEnv) names.add(transcriptionKeyEnv);
  const ingestKeysEnv = config?.ingest?.apiKeysEnv?.trim();
  if (ingestKeysEnv) names.add(ingestKeysEnv);
  const slackSigningSecretEnv = config?.slack?.signingSecretEnv?.trim();
  if (slackSigningSecretEnv) names.add(slackSigningSecretEnv);
  const slackBotTokenEnv = config?.slack?.botTokenEnv?.trim();
  if (slackBotTokenEnv) names.add(slackBotTokenEnv);
  const slackAppTokenEnv = config?.slack?.appTokenEnv?.trim();
  if (slackAppTokenEnv) names.add(slackAppTokenEnv);
  for (const name of config?.codex?.providerApiKeyEnvNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
  }
  return [...names];
}

export function sanitizeChildProcessEnv(
  config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack" | "codex">>,
  baseEnv: ChildEnvSource = process.env,
  overrides?: ChildEnvSource,
  options?: ChildEnvOptions
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const allow = new Set((options?.allowSecretEnvNames ?? []).map((name) => name.trim()).filter(Boolean));
  for (const name of childSecretEnvNames(config)) {
    if (!allow.has(name)) delete env[name];
  }
  return env;
}

export function sanitizeCodexChildProcessEnv(
  config: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack" | "codex">>,
  baseEnv: ChildEnvSource = process.env,
  overrides?: ChildEnvSource
): NodeJS.ProcessEnv {
  return sanitizeChildProcessEnv(config, baseEnv, overrides, {
    allowSecretEnvNames: config.codex?.providerApiKeyEnvNames ?? []
  });
}

export function sanitizeClaudeAgentSdkChildProcessEnv(
  config: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack" | "codex">>,
  baseEnv: ChildEnvSource = process.env,
  overrides?: ChildEnvSource
): NodeJS.ProcessEnv {
  const env = sanitizeChildProcessEnv(config, baseEnv, overrides, {
    allowSecretEnvNames: CLAUDE_OAUTH_CHILD_ENV
  });
  for (const name of CLAUDE_NON_OAUTH_AUTH_ENV) delete env[name];
  for (const name of config.codex?.providerApiKeyEnvNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) delete env[trimmed];
  }
  return env;
}
