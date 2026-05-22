#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, copyFileSync, renameSync, appendFileSync, chmodSync } from "node:fs";
import { dirname, extname, join, relative, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";

const MIME_EXTENSIONS = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

function text(value) {
  if (value === undefined || value === null) return null;
  const out = String(value).trim();
  return out || null;
}
function timestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}
function safe(value, fallback = "document") {
  const raw = text(value) || fallback;
  return raw.replace(/[\\/]+/g, " ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._ -]+/g, "").replace(/\s+/g, " ").trim().replace(/^[. -]+|[. -]+$/g, "").slice(0, 96) || fallback;
}
function nearestExisting(candidate) {
  let cur = resolve(candidate);
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return statSync(cur).isFile() ? dirname(cur) : cur;
}
function gitRoot(candidate) {
  let cur = nearestExisting(candidate);
  while (cur) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
function gitIgnored(root, target) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", relative(root, target)], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function assertSafeDestination(target) {
  const root = gitRoot(target);
  if (!root) return;
  if (gitIgnored(root, target)) return;
  throw new Error(`Refusing to save a private document under a non-ignored git worktree path: ${target}`);
}
function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
}
function privateRoot(args) {
  const explicit = args.privateRoot || process.env.CODEX_CHAT_PRIVATE_DIR || process.env.ASSISTANT_PRIVATE_DIR || process.env.BRAIN_PRIVATE_DIR;
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), "data", "private");
}
function ext(args) {
  for (const candidate of [args.filename, args.title, args.originalFilename].map(text).filter(Boolean)) {
    const e = extname(candidate);
    if (e && e.length <= 16) return e.toLowerCase().replace(/[^.a-z0-9]/g, "");
  }
  return MIME_EXTENSIONS[String(args.mimeType || "").toLowerCase()] || "";
}
function destinationFilename(id, args) {
  const e = ext(args);
  let base = basename(text(args.filename) || text(args.title) || text(args.originalFilename) || "document");
  if (e && base.toLowerCase().endsWith(e)) base = base.slice(0, -e.length);
  return `${id}-${safe(base)}${e}`;
}
async function hashFile(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}
function parseArgs(argv) {
  const aliases = {
    "--source": "source", "--path": "source", "--file": "source",
    "--project": "project", "--contact": "contact", "--label": "label",
    "--title": "title", "--as": "title", "--note": "note", "--retention": "retention",
    "--received-at": "receivedAt", "--source-chat": "sourceChat", "--chat": "sourceChat",
    "--source-message": "sourceMessage", "--message": "sourceMessage",
    "--original-filename": "originalFilename", "--mime-type": "mimeType", "--size-bytes": "sizeBytes", "--sha256": "sha256",
    "--private-dir": "privateRoot", "--private-root": "privateRoot", "--filename": "filename",
  };
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (aliases[arg]) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      args[aliases[arg]] = argv[++i];
    } else if (!arg.startsWith("-") && !args.source) {
      args.source = arg;
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}
function usage() {
  return "Usage: node scripts/file-save.mjs --source <path> [--project <label>] [--contact <label>] [--title <title>] [--note <text>] [--retention <policy>] [--received-at <iso>] [--source-chat <id>] [--source-message <id>]";
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return void console.log(usage());
  if (!args.source) throw new Error(usage());
  const sourcePath = resolve(args.source);
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile()) throw new Error(`source path is not a file: ${sourcePath}`);
  const now = new Date();
  const id = `doc_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}_${randomBytes(4).toString("hex")}`;
  const root = privateRoot(args);
  const docsRoot = join(root, "documents");
  const filesRoot = join(docsRoot, "files");
  const metadataPath = join(docsRoot, "metadata.jsonl");
  const originalFilename = text(args.originalFilename) || basename(sourcePath);
  const savedPath = join(filesRoot, now.toISOString().slice(0, 4), now.toISOString().slice(5, 7), destinationFilename(id, { ...args, originalFilename }));
  assertSafeDestination(savedPath);
  assertSafeDestination(metadataPath);
  for (const dir of [root, docsRoot, filesRoot, dirname(savedPath)]) ensurePrivateDir(dir);
  const tmp = `${savedPath}.tmp-${process.pid}`;
  copyFileSync(sourcePath, tmp);
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, savedPath);
  const savedStat = statSync(savedPath);
  const document = {
    schemaVersion: 1,
    id,
    savedAt: now.toISOString(),
    receivedAt: timestamp(args.receivedAt),
    sourcePath,
    originalFilename,
    mimeType: text(args.mimeType),
    sizeBytes: Number(args.sizeBytes || savedStat.size),
    sha256: text(args.sha256) || await hashFile(savedPath),
    savedPath,
    privateRoot: root,
    title: text(args.title),
    note: text(args.note),
    project: text(args.project),
    contact: text(args.contact),
    label: text(args.label),
    retention: text(args.retention),
    source: { chat: text(args.sourceChat), message: text(args.sourceMessage) },
  };
  ensurePrivateDir(dirname(metadataPath));
  appendFileSync(metadataPath, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  try { chmodSync(metadataPath, 0o600); } catch {}
  console.log(JSON.stringify({ ok: true, document, metadataPath }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
