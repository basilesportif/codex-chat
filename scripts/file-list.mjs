#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

function text(value) { if (value === undefined || value === null) return null; const out = String(value).trim(); return out || null; }
function privateRoot(args) {
  return resolve(args.privateRoot || process.env.CODEX_CHAT_PRIVATE_DIR || process.env.ASSISTANT_PRIVATE_DIR || process.env.BRAIN_PRIVATE_DIR || join(process.cwd(), "data", "private"));
}
function parseArgs(argv) {
  const aliases = { "--query": "query", "--project": "project", "--contact": "contact", "--label": "label", "--limit": "limit", "--private-dir": "privateRoot", "--private-root": "privateRoot" };
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (aliases[arg]) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      args[aliases[arg]] = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}
function usage() { return "Usage: node scripts/file-list.mjs [--query <text>] [--project <label>] [--contact <label>] [--limit <n>]"; }
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function matchesExact(value, expected) { return String(value || "").toLowerCase() === expected.toLowerCase(); }
function main() {
  const args = parseArgs(process.argv);
  if (args.help) return void console.log(usage());
  const root = privateRoot(args);
  const metadataPath = join(root, "documents", "metadata.jsonl");
  let documents = readJsonl(metadataPath);
  const query = text(args.query), project = text(args.project), contact = text(args.contact), label = text(args.label);
  if (query) {
    const lower = query.toLowerCase();
    documents = documents.filter((doc) => [doc.id, doc.title, doc.note, doc.project, doc.contact, doc.label, doc.originalFilename, doc.savedPath, doc.sourcePath].filter(Boolean).some((value) => String(value).toLowerCase().includes(lower)));
  }
  if (project) documents = documents.filter((doc) => matchesExact(doc.project, project));
  if (contact) documents = documents.filter((doc) => matchesExact(doc.contact, contact));
  if (label) documents = documents.filter((doc) => matchesExact(doc.label, label));
  documents.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
  const limit = Number(args.limit || 50);
  if (Number.isFinite(limit) && limit > 0) documents = documents.slice(0, limit);
  console.log(JSON.stringify({ ok: true, count: documents.length, documents, metadataPath, privateRoot: root }, null, 2));
}

try { main(); } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message }, null, 2)); process.exit(1); }
