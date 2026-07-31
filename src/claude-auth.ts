import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import {
  CLAUDE_NON_OAUTH_AUTH_ENV,
  CLAUDE_OAUTH_CHILD_ENV,
  sanitizeClaudeAgentSdkChildProcessEnv,
  type ChildEnvSource
} from "./env.js";
import { scrubSecrets } from "./log-buffer.js";
import { pathExists } from "./util.js";

export { CLAUDE_NON_OAUTH_AUTH_ENV, CLAUDE_OAUTH_CHILD_ENV };
export type { ChildEnvSource };

export interface ClaudeCredentialFile {
  path: string;
  exists: boolean;
}

export interface ClaudeOAuthReadiness {
  safeEnv: NodeJS.ProcessEnv;
  oauthEnvPresent: boolean;
  credentialFiles: ClaudeCredentialFile[];
  strippedNonOAuthEnv: string[];
}

export class ClaudeOAuthReadinessError extends Error {
  constructor(
    message: string,
    readonly readiness: ClaudeOAuthReadiness
  ) {
    super(message);
    this.name = "ClaudeOAuthReadinessError";
  }
}

export interface ClaudeAccountSummary {
  apiProvider?: string;
  apiKeySource?: string;
  tokenSource?: string;
  subscriptionType?: string;
  emailPresent: boolean;
  organizationPresent: boolean;
}

interface ClaudeAccountInfo {
  apiProvider?: string;
  apiKeySource?: string;
  tokenSource?: string;
  subscriptionType?: string;
  email?: string;
  organization?: string;
}

export interface ClaudeInitializationSummary {
  account: ClaudeAccountSummary;
  fastModeState?: unknown;
}

interface ClaudeInitializationQuery {
  initializationResult(): Promise<{
    account?: ClaudeAccountInfo;
    fast_mode_state?: unknown;
  }>;
}

export function buildSanitizedClaudeEnv(
  config: AppConfig,
  baseEnv: ChildEnvSource = process.env,
  overrides?: ChildEnvSource
): NodeJS.ProcessEnv {
  return sanitizeClaudeAgentSdkChildProcessEnv(config, baseEnv, overrides);
}

export async function credentialFiles(env: NodeJS.ProcessEnv): Promise<ClaudeCredentialFile[]> {
  const configuredDir = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
  const configDir = configuredDir || join(homedir(), ".claude");
  const credentialsPath = join(configDir, ".credentials.json");
  return [{ path: credentialsPath, exists: await pathExists(credentialsPath) }];
}

export async function checkClaudeOAuthReadiness(
  config: AppConfig,
  options: {
    baseEnv?: ChildEnvSource;
    overrides?: ChildEnvSource;
    enabled?: boolean;
    disabledError?: string;
  } = {}
): Promise<ClaudeOAuthReadiness> {
  const baseEnv = options.baseEnv ?? process.env;
  const safeEnv = buildSanitizedClaudeEnv(config, baseEnv, options.overrides);
  const readiness: ClaudeOAuthReadiness = {
    safeEnv,
    oauthEnvPresent: Boolean(safeEnv.CLAUDE_CODE_OAUTH_TOKEN),
    credentialFiles: await credentialFiles(safeEnv),
    strippedNonOAuthEnv: strippedNonOAuthEnvNames(config, safeEnv, baseEnv)
  };

  if (options.enabled === false) {
    throw new ClaudeOAuthReadinessError(
      options.disabledError ?? "Claude Agent SDK is disabled. Configure Claude subscription OAuth before enabling it.",
      readiness
    );
  }
  if (!readiness.oauthEnvPresent && !readiness.credentialFiles.some((candidate) => candidate.exists)) {
    throw new ClaudeOAuthReadinessError(
      "Claude Agent SDK backend requires subscription OAuth: run `claude auth login` or provide CLAUDE_CODE_OAUTH_TOKEN.",
      readiness
    );
  }
  const leaked = CLAUDE_NON_OAUTH_AUTH_ENV.filter((name) => safeEnv[name]);
  if (leaked.length > 0) {
    throw new ClaudeOAuthReadinessError(
      `Claude Agent SDK sanitized environment still contains non-OAuth auth variables: ${leaked.join(", ")}`,
      readiness
    );
  }
  return readiness;
}

export function accountSummary(account: ClaudeAccountInfo): ClaudeAccountSummary {
  return {
    apiProvider: account.apiProvider,
    apiKeySource: account.apiKeySource,
    tokenSource: account.tokenSource,
    subscriptionType: account.subscriptionType,
    emailPresent: Boolean(account.email),
    organizationPresent: Boolean(account.organization)
  };
}

export async function verifyClaudeOAuthInitialization(
  query: ClaudeInitializationQuery,
  timeoutMs: number,
  onInitialized?: (summary: ClaudeInitializationSummary) => void | Promise<void>
): Promise<ClaudeInitializationSummary> {
  const initialized = await withTimeout(
    query.initializationResult(),
    timeoutMs,
    `Claude Agent SDK initialization did not complete within ${timeoutMs}ms. Check Claude OAuth login and network connectivity.`
  );
  const summary: ClaudeInitializationSummary = {
    account: accountSummary(initialized.account ?? {}),
    fastModeState: initialized.fast_mode_state
  };
  await onInitialized?.(summary);
  if (summary.account.apiProvider && summary.account.apiProvider !== "firstParty") {
    throw new Error(
      `Claude Agent SDK backend requires first-party subscription OAuth; SDK reported apiProvider=${summary.account.apiProvider}.`
    );
  }
  if (
    summary.account.apiKeySource &&
    summary.account.apiKeySource !== "oauth" &&
    summary.account.apiKeySource !== "none"
  ) {
    throw new Error(
      `Claude Agent SDK backend requires OAuth credentials; SDK reported apiKeySource=${summary.account.apiKeySource}.`
    );
  }
  return summary;
}

export function redactClaudeSecrets(
  value: string,
  config: Pick<AppConfig, "codex">,
  env: ChildEnvSource = process.env
): string {
  const secretNames = new Set<string>([
    ...CLAUDE_OAUTH_CHILD_ENV,
    ...CLAUDE_NON_OAUTH_AUTH_ENV,
    ...(config.codex.providerApiKeyEnvNames ?? [])
  ]);
  let result = scrubSecrets(value);
  for (const name of secretNames) {
    const secret = env[name]?.trim();
    if (secret && secret.length >= 4) result = result.split(secret).join(`[REDACTED:${name}]`);
  }
  return result;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function strippedNonOAuthEnvNames(
  config: AppConfig,
  safeEnv: NodeJS.ProcessEnv,
  baseEnv: ChildEnvSource
): string[] {
  const stripped = new Set<string>();
  for (const name of CLAUDE_NON_OAUTH_AUTH_ENV) {
    if (baseEnv[name] && !safeEnv[name]) stripped.add(name);
  }
  for (const name of config.codex.providerApiKeyEnvNames ?? []) {
    const trimmed = name.trim();
    if (trimmed && baseEnv[trimmed] && !safeEnv[trimmed]) stripped.add(trimmed);
  }
  return [...stripped].sort();
}
