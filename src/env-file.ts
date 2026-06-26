import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureDir, pathExists } from "./util.js";

const ENV_LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/;

export function expandHomePath(path: string, home = process.env.HOME ?? ""): string {
  if (path === "~") return home || path;
  if (path.startsWith("~/")) return home ? join(home, path.slice(2)) : path;
  return path;
}

export function resolveEnvFilePath(path: string): string {
  const expanded = expandHomePath(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function shellQuoteEnvValue(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatEnvLine(key: string, value: string): string {
  return `${key}=${shellQuoteEnvValue(value)}`;
}

export function mergeEnvFileText(sourceText: string, updates: Record<string, string>): string {
  const updateKeys = new Set(Object.keys(updates));
  const seen = new Set<string>();
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out = lines.map((line) => {
    const match = ENV_LINE_RE.exec(line);
    const key = match?.[2];
    if (!key || !updateKeys.has(key)) return line;
    seen.add(key);
    return formatEnvLine(key, updates[key] ?? "");
  });

  const missing = Object.keys(updates).filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (out.length > 0 && out[out.length - 1]?.trim() !== "") out.push("");
    out.push("# Managed by codex-chat admin page.");
    for (const key of missing) out.push(formatEnvLine(key, updates[key] ?? ""));
  }

  return `${out.join("\n")}\n`;
}

export async function writeMergedEnvFile(path: string, updates: Record<string, string>): Promise<void> {
  const resolved = resolveEnvFilePath(path);
  await ensureDir(dirname(resolved));
  const current = await pathExists(resolved) ? await readFile(resolved, "utf8") : "";
  const merged = mergeEnvFileText(current, updates);
  const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, merged, { mode: 0o600 });
  await rename(tmp, resolved);
  await chmod(resolved, 0o600);
}

export function parseEnvKeys(sourceText: string): Set<string> {
  const keys = new Set<string>();
  for (const line of sourceText.split(/\r?\n/)) {
    const match = ENV_LINE_RE.exec(line);
    if (match?.[2]) keys.add(match[2]);
  }
  return keys;
}

export async function readEnvKeyPresence(path: string, keys: readonly string[]): Promise<Record<string, boolean>> {
  const resolved = resolveEnvFilePath(path);
  const text = await pathExists(resolved) ? await readFile(resolved, "utf8") : "";
  const present = parseEnvKeys(text);
  return Object.fromEntries(keys.map((key) => [key, present.has(key)]));
}
