import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export interface CodexProfileConfig {
  model?: string;
  modelProvider?: string;
  appServerConfig: string[];
}

export async function loadCodexProfileConfig(profile: string): Promise<CodexProfileConfig> {
  const safe = profile.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(safe)) return { appServerConfig: [] };
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const path = join(codexHome, `${safe}.config.toml`);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { appServerConfig: [] };
  }

  const model = stringValue(parsed.model);
  const modelProvider = stringValue(parsed.model_provider);
  const appServerConfig: string[] = [];
  if (modelProvider) appServerConfig.push(`model_provider=${tomlString(modelProvider)}`);

  const providers = recordValue(parsed.model_providers);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const provider = recordValue(providerConfig);
    for (const [key, value] of Object.entries(provider)) {
      const configValue = tomlPrimitive(value);
      if (configValue === undefined) continue;
      appServerConfig.push(`model_providers.${providerId}.${key}=${configValue}`);
    }
  }

  return { model, modelProvider, appServerConfig };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function tomlPrimitive(value: unknown): string | undefined {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
