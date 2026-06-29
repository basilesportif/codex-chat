import type { AppConfig } from "./config.js";

export type ChildEnvSource = Record<string, string | undefined>;

export const ALWAYS_STRIPPED_CHILD_ENV = ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

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
