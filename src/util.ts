import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

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

export async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return sha256Buffer(data);
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
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function atomicWriteText(path: string, value: string, mode = 0o644): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
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
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLength) {
    let split = rest.lastIndexOf("\n\n", maxLength);
    if (split < maxLength * 0.5) split = rest.lastIndexOf("\n", maxLength);
    if (split < maxLength * 0.5) split = maxLength;
    chunks.push(rest.slice(0, split).trimEnd());
    rest = rest.slice(split).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export async function writeStreamToFile(stream: NodeJS.ReadableStream, destination: string): Promise<void> {
  await ensureDir(dirname(destination));
  await pipeline(stream, createWriteStream(destination));
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}

export async function fileSize(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

export function redact(value: string, secrets: Array<string | undefined>): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && secret.length > 3) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function parseNumberList(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => (typeof value === "number" ? value : Number(value)))
    .filter((value) => Number.isSafeInteger(value));
}
