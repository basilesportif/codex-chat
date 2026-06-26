import type { AppConfig } from "./config.js";

export type ChildEnvSource = Record<string, string | undefined>;

export const ALWAYS_STRIPPED_CHILD_ENV = ["OPENAI_API_KEY"] as const;

/**
 * Secret-bearing env vars that must not be inherited by non-transcription
 * child processes. The service process may keep these so OpenAITranscriber can
 * read the configured transcription key, but Codex, loops, monitors, deploys,
 * and other subprocesses run without them by default.
 */
export function childSecretEnvNames(config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "admin" | "ingest" | "slack">>): string[] {
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
  const clerkSecretKeyEnv = config?.admin?.clerkSecretKeyEnv?.trim();
  if (clerkSecretKeyEnv) names.add(clerkSecretKeyEnv);
  return [...names];
}

export function sanitizeChildProcessEnv(
  config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "admin" | "ingest" | "slack">>,
  baseEnv: ChildEnvSource = process.env,
  overrides?: ChildEnvSource
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  for (const name of childSecretEnvNames(config)) delete env[name];
  return env;
}
