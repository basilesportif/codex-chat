import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function makePairingCode(): string {
  return randomBytes(3).readUIntBE(0, 3).toString().padStart(8, "0").slice(0, 6);
}

export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}


export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function atomicWriteText(path: string, value: string, mode = 0o644): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(tmp, value, { mode });
  await rename(tmp, path);
}

export function resolveFrom(baseDir: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(baseDir, candidate);
}

export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function chunkText(text: string, maxLength = 3900): string[] {
  if (text.length <= maxLength) return [text];
  const units = markdownSplitUnits(text);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (unit.length > maxLength) {
      if (current.trim()) {
        chunks.push(current.trimEnd());
        current = "";
      }
      chunks.push(...splitLargeUnit(unit, maxLength));
      continue;
    }
    if (current && current.length + unit.length > maxLength) {
      chunks.push(current.trimEnd());
      current = unit.trimStart();
    } else {
      current += unit;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.filter((chunk) => chunk.length > 0);
}

function markdownSplitUnits(text: string): string[] {
  const lines = text.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const units: string[] = [];
  let buffer = "";
  let inFence = false;
  for (const line of lines) {
    const isFence = line.trimStart().startsWith("```");
    if (!inFence && isFence) {
      if (buffer) units.push(buffer);
      buffer = line;
      inFence = true;
      continue;
    }
    buffer += line;
    if (inFence && isFence) {
      units.push(buffer);
      buffer = "";
      inFence = false;
    } else if (!inFence && line.trim() === "") {
      units.push(buffer);
      buffer = "";
    }
  }
  if (buffer) units.push(buffer);
  return units;
}

function splitLargeUnit(unit: string, maxLength: number): string[] {
  if (unit.trimStart().startsWith("```")) return splitLargeFence(unit, maxLength);
  const chunks: string[] = [];
  let rest = unit;
  while (rest.length > maxLength) {
    let split = rest.lastIndexOf("\n\n", maxLength);
    if (split < maxLength * 0.5) split = rest.lastIndexOf("\n", maxLength);
    if (split < maxLength * 0.5) split = maxLength;
    chunks.push(rest.slice(0, split).trimEnd());
    rest = rest.slice(split).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trimEnd());
  return chunks;
}

function splitLargeFence(unit: string, maxLength: number): string[] {
  const lines = unit.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const opener = lines[0]?.trimEnd() || "```";
  const hasClosing = lines.length > 1 && lines[lines.length - 1]?.trimStart().startsWith("```");
  const body = hasClosing ? lines.slice(1, -1) : lines.slice(1);
  const chunks: string[] = [];
  const reopen = `${opener}\n`;
  const close = "\n```";
  let current = reopen;

  for (const line of body) {
    if (current.length + line.length + close.length > maxLength && current !== reopen) {
      chunks.push(`${current.trimEnd()}${close}`);
      current = reopen;
    }
    if (line.length + reopen.length + close.length > maxLength) {
      let rest = line;
      while (rest.length > 0) {
        const available = Math.max(1, maxLength - current.length - close.length);
        current += rest.slice(0, available);
        rest = rest.slice(available);
        if (rest.length > 0) {
          chunks.push(`${current.trimEnd()}${close}`);
          current = reopen;
        }
      }
    } else {
      current += line;
    }
  }

  if (current !== reopen) chunks.push(`${current.trimEnd()}${close}`);
  return chunks;
}


export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}


/**
 * Send `signal` to a child process — preferring its process group so detached
 * children get the signal too. Falls back to signaling the child directly if
 * the group kill fails. All errors swallowed (process may already be dead).
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  try {
    if (pid && pid > 0) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already dead */ }
  }
}
