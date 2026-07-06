import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ENV_OVERRIDE_SPECS,
  configEnvValueKind,
  type AppConfig,
  type EnvOverrideSpec,
} from "./config.js";
import { childSecretEnvNames } from "./env.js";

/**
 * codex-chat-owned config write interface (plan §6.7). codex-chat validates
 * incoming env entries against its OWN schema (config.ts) and persists them
 * atomically to its OWN env store — Brain no longer reaches into codex-chat's
 * private storage. Secrets transit write-only: never echoed back, never logged.
 */

// Env keys loadConfig reads directly (not via ENV_OVERRIDE_SPECS). Accepted as
// free-form strings; their parser never rejects.
const EXTRA_STRING_ENV_KEYS = [
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ADMIN_USER_IDS",
] as const;

interface KnownConfigKey {
  spec?: EnvOverrideSpec;
  secret: boolean;
}

export interface ConfigEntryValidation {
  sanitized: Record<string, string>;
  fieldErrors?: Record<string, string>;
}

/**
 * The env keys `set_config` accepts, derived from config.ts: typed override
 * keys, the two identity-list keys loadConfig reads directly, and the
 * operator-configured secret env names. Secret names are marked so callers can
 * reason about write-only handling; every value is still validated the same.
 */
export function knownConfigEnvKeys(config: AppConfig): Map<string, KnownConfigKey> {
  const known = new Map<string, KnownConfigKey>();
  for (const spec of ENV_OVERRIDE_SPECS) known.set(spec.name, { spec, secret: false });
  for (const key of EXTRA_STRING_ENV_KEYS) if (!known.has(key)) known.set(key, { secret: false });
  // The operator-configured secret env names loadConfig reads. childSecretEnvNames
  // covers transcription/ingest/slack/codex-provider secrets; the Telegram bot
  // token is a secret in the env store too but is not part of that set.
  const secretNames = [...childSecretEnvNames(config), config.telegram.botTokenEnv];
  for (const name of secretNames) {
    const trimmed = name?.trim();
    if (trimmed) known.set(trimmed, { spec: known.get(trimmed)?.spec, secret: true });
  }
  return known;
}

/**
 * Validate `entries` against the known key registry. Unknown keys and
 * type-invalid values produce field errors (never echoing the offending
 * value); accepted entries are returned as strings ready to persist. An empty
 * string is always accepted and means "clear this key".
 */
export function validateConfigEntries(config: AppConfig, entries: unknown): ConfigEntryValidation {
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { sanitized: {}, fieldErrors: { entries: "entries must be an object of string values" } };
  }
  const known = knownConfigEnvKeys(config);
  const sanitized: Record<string, string> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof rawValue !== "string") {
      fieldErrors[key] = "value must be a string";
      continue;
    }
    const descriptor = known.get(key);
    if (!descriptor) {
      fieldErrors[key] = "unknown configuration key";
      continue;
    }
    const envValueError = validateWritableEnvValue(rawValue);
    if (envValueError) {
      fieldErrors[key] = envValueError;
      continue;
    }
    if (rawValue !== "" && descriptor.spec?.parse) {
      try {
        descriptor.spec.parse(rawValue);
      } catch {
        fieldErrors[key] = `invalid value (expected ${configEnvValueKind(descriptor.spec)})`;
        continue;
      }
    }
    sanitized[key] = rawValue;
  }
  return Object.keys(fieldErrors).length > 0 ? { sanitized, fieldErrors } : { sanitized };
}

/**
 * codex-chat's own env store path — the systemd `EnvironmentFile`. Overridable
 * via `CODEX_CHAT_ENV_FILE` (used by tests and non-default deployments);
 * otherwise `~/.config/codex-chat/env`, matching the systemd installer.
 */
export function resolveEnvStorePath(): string {
  const override = process.env.CODEX_CHAT_ENV_FILE?.trim();
  const raw = override || join(homedir(), ".config", "codex-chat", "env");
  return isAbsolute(raw) ? raw : resolve(raw);
}

const ENV_LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

function validateWritableEnvValue(value: string): string | undefined {
  if (value.includes("'")) return "value may not contain a single quote";
  if (/[\u0000-\u001F\u007F]/.test(value)) return "value may not contain control characters";
  return undefined;
}

function quoteEnvValue(value: string): string {
  const error = validateWritableEnvValue(value);
  if (error) throw new Error("invalid environment value");
  return `'${value}'`;
}

function formatEnvLine(key: string, value: string): string {
  return `${key}=${quoteEnvValue(value)}`;
}

/**
 * Merge `updates` into existing env-file text, preserving unrelated lines
 * (comments, blank lines, and untouched keys) and rewriting only the keys
 * being set. New keys are appended under a managed-by marker.
 */
export function mergeEnvFileText(sourceText: string, updates: Record<string, string>): string {
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const match = ENV_LINE_RE.exec(line);
    const key = match?.[2];
    if (!key || !updateKeys.has(key)) {
      out.push(line);
      continue;
    }
    seen.add(key);
    const value = updates[key] ?? "";
    if (value !== "") out.push(formatEnvLine(key, value));
  }

  const missing = Object.keys(updates).filter((key) => !seen.has(key) && updates[key] !== "");
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1]?.trim() !== "") out.push("");
    out.push("# Managed by codex-chat set_config. Values are write-only.");
    for (const key of missing) out.push(formatEnvLine(key, updates[key] ?? ""));
  }

  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/**
 * Atomically persist env entries to codex-chat's env store: temp file at mode
 * 0600, rename over the target, preserving unrelated existing entries. No-op
 * when there is nothing to write.
 */
export async function persistEnvEntries(filePath: string, updates: Record<string, string>): Promise<void> {
  if (Object.keys(updates).length === 0) return;
  const resolved = isAbsolute(filePath) ? filePath : resolve(filePath);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  let current = "";
  try {
    current = await readFile(resolved, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged = mergeEnvFileText(current, updates);
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, merged, { mode: 0o600 });
  await rename(tmp, resolved);
  await chmod(resolved, 0o600);
}
