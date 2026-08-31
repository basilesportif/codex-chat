#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_ROOT = "/home/tim/.assistant-claude/workspace";
const CANONICAL_RESOURCE = path.join(
  WORKSPACE_ROOT,
  "data/project-resources/it-consulting-firm/galebach-and-company-conference-listings-canonical.json"
);
const DERIVED_LIST_DIR = path.join(WORKSPACE_ROOT, "data/conference-lists/conference-map");
const DERIVED_CONFERENCES = path.join(DERIVED_LIST_DIR, "conferences.json");
const DERIVED_MANIFEST = path.join(DERIVED_LIST_DIR, "manifest.json");
const WEB_MANIFEST = path.join(WORKSPACE_ROOT, "data/web-pages/manifest.json");
const RUNTIME_PAGE_DIR = "/srv/codex-chat-web/private-pages/conference-map";
const CODEX_CHAT_WEB_DIR = "/home/tim/pkg/tim/codex-chat-web";
const STAGE_DIR = path.join(REPO_ROOT, "data/artifacts/conference-map-maintenance/latest");
const PAGE_ID = "conference-map";
const PAGE_TITLE = "Conference Map";
const DEFAULT_TTL_HOURS = "8760";

const ALLOWED_STAGE_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".woff", ".woff2"]);
const BLOCKED_STAGE_NAMES = new Set([".env", ".git", "node_modules", ".npmrc", ".netrc"]);

function usage() {
  return `Usage: node scripts/conference-map-maintenance.mjs [options]\n\n` +
    `Prune Galebach and Company canonical conference records ending before the configured cutoff,\n` +
    `rebuild the derived conference-map data, and republish the map via codex-chat-web.\n\n` +
    `Options:\n` +
    `  --dry-run              Validate and stage only; do not write canonical/list data or publish.\n` +
    `  --skip-publish         Update canonical/list data but do not call the publisher.\n` +
    `  --cutoff YYYY-MM-DD    Override canonical cutoff for this run.\n` +
    `  --cutoff-today         Use the current UTC date as the cutoff and strictly prune records ending before it.\n` +
    `  --strict-end-date      Do not honor retainInActiveMap exceptions; any valid end date before cutoff is pruned.\n` +
    `  --canonical <path>     Override canonical JSON resource path.\n` +
    `  --stage-dir <path>     Override staging directory.\n` +
    `  --runtime-page <path>  Override existing private runtime page template directory.\n` +
    `  --web-dir <path>       Override codex-chat-web checkout path.\n` +
    `  --json                 Print machine-readable JSON.\n` +
    `  --help                 Show this help.\n`;
}

function parseArgs(argv) {
  const args = {
    canonical: CANONICAL_RESOURCE,
    stageDir: STAGE_DIR,
    runtimePage: RUNTIME_PAGE_DIR,
    webDir: CODEX_CHAT_WEB_DIR,
    dryRun: false,
    skipPublish: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--skip-publish") args.skipPublish = true;
    else if (token === "--cutoff-today") {
      args.cutoff = currentUtcDate();
      args.cutoffSource = "current UTC date";
      args.strictEndDate = true;
    }
    else if (token === "--strict-end-date") args.strictEndDate = true;
    else if (token === "--json") args.json = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--cutoff") {
      args.cutoff = requireValue(argv, ++i, token);
      args.cutoffSource = "override";
    }
    else if (token === "--canonical") args.canonical = requireValue(argv, ++i, token);
    else if (token === "--stage-dir") args.stageDir = requireValue(argv, ++i, token);
    else if (token === "--runtime-page") args.runtimePage = requireValue(argv, ++i, token);
    else if (token === "--web-dir") args.webDir = requireValue(argv, ++i, token);
    else throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, filePath);
}

function normalizeIsoDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function dateKey(value) {
  const normalized = normalizeIsoDate(value);
  return normalized ? Number(normalized.replaceAll("-", "")) : null;
}

function cutoffFromCanonical(store, override) {
  const cutoff = override || store?.cutoff?.keepEventsEndingOnOrAfter || store?.cutoffEndOnOrAfter;
  const normalized = normalizeIsoDate(cutoff);
  if (!normalized) {
    throw new Error("No valid cutoff found. Expected canonical cutoff.keepEventsEndingOnOrAfter or --cutoff YYYY-MM-DD.");
  }
  return normalized;
}

function activeRecordsFromCanonical(store, cutoff, options = {}) {
  if (!store || typeof store !== "object" || !Array.isArray(store.records)) {
    throw new Error("Canonical conference resource must be a JSON object with records[].");
  }
  const cutoffKey = dateKey(cutoff);
  const strictEndDate = options.strictEndDate === true;
  const active = [];
  const pruned = [];
  const retainedByException = [];
  const missingEndDate = [];
  for (const record of store.records) {
    if (record?.retainInActiveMap === true && !strictEndDate) {
      active.push(record);
      retainedByException.push(record);
      continue;
    }
    const endKey = dateKey(record?.end);
    if (endKey !== null && endKey < cutoffKey) pruned.push(record);
    else {
      if (endKey === null) missingEndDate.push(record);
      active.push(record);
    }
  }
  return { active, pruned, retainedByException, missingEndDate };
}

function summarizeFavorites(rows) {
  return rows
    .filter((row) => row?.favorite === true)
    .map((row) => ({
      id: row.id,
      name: row.name,
      dates: row.dates,
      city: row.city,
      region: row.region,
      favoritedAt: row.favoritedAt || null,
      favoriteNote: row.favoriteNote || null,
    }));
}

function mergeDroppedRecords(existing, pruned, cutoff, now) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map((row) => String(row?.id || "").toLowerCase()).filter(Boolean));
  for (const row of pruned) {
    const id = String(row?.id || "").toLowerCase();
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push({
      ...row,
      droppedAt: row.droppedAt || now,
      dropReason: row.dropReason || `Ended before active cutoff ${cutoff}`,
    });
  }
  return out;
}

function updateCanonical(store, active, pruned, cutoff, now) {
  if (pruned.length === 0) {
    return {
      next: store,
      changed: false,
    };
  }
  const favorites = summarizeFavorites(active);
  return {
    changed: true,
    next: {
      ...store,
      updatedAt: now,
      cutoff: {
        ...(store.cutoff || {}),
        keepEventsEndingOnOrAfter: cutoff,
        rule: `Drop conferences whose parsed end date is before ${cutoff}; keep events ending on or after ${cutoff}.`,
      },
      counts: {
        ...(store.counts || {}),
        activeRecordCount: active.length,
        droppedDistinctRecordCount: mergeDroppedRecords(store.droppedRecords, pruned, cutoff, now).length,
        favoriteCount: favorites.length,
      },
      favorites,
      records: active,
      droppedRecords: mergeDroppedRecords(store.droppedRecords, pruned, cutoff, now),
    },
  };
}

function buildDerivedManifest(existing, { canonicalPath, store, active, cutoff, now }) {
  const favorites = summarizeFavorites(active);
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    id: PAGE_ID,
    name: PAGE_TITLE,
    description: "Derived durable copy for the main Galebach and Company conference map, rebuilt from the Galebach and Company canonical conference listings JSON resource.",
    createdAt: existing?.createdAt || "2026-06-05T18:35:00.000Z",
    source: `Derived from ${canonicalPath}${store?.canonicalNoteId ? ` (canonical note ${store.canonicalNoteId}, canonicalKey ${store.canonicalKey || "unknown"})` : ""}.`,
    runtimePageId: PAGE_ID,
    dataFile: "conferences.json",
    mainConferenceMap: true,
    notes: "Do not edit this derived copy as the source of truth. Update the Galebach and Company canonical conference listings JSON resource first, then rebuild and republish the map.",
    updatedAt: now,
    recordCount: active.length,
    favoriteCount: favorites.length,
    favoriteUpdatedAt: existing?.favoriteCount !== favorites.length ? now : (existing?.favoriteUpdatedAt || null),
    canonicalProjectId: store.projectId || existing?.canonicalProjectId,
    canonicalNoteId: store.canonicalNoteId || existing?.canonicalNoteId,
    canonicalKey: store.canonicalKey || existing?.canonicalKey,
    canonicalResourcePath: canonicalPath,
    cutoffEndOnOrAfter: cutoff,
    supersededListIds: store.supersedes?.listIds || existing?.supersededListIds || ["july-conferences-2026", "nashville-tennessee-conferences-june-july-2026"],
  };
}

function assetVersionFromIso(iso) {
  return iso.replace(/\D/g, "").slice(0, 14);
}

async function refreshStageIndex(stageDir, assetVersion) {
  const indexPath = path.join(stageDir, "index.html");
  let html = await readFile(indexPath, "utf8");
  html = html
    .replace(/app\.js(?:\?v=\d+)?/g, `app.js?v=${assetVersion}`)
    .replace(/styles\.css(?:\?v=\d+)?/g, `styles.css?v=${assetVersion}`);
  await writeFile(indexPath, html, { mode: 0o644 });
}

async function stagePagePackage({ runtimePage, stageDir, active, assetVersion }) {
  await access(path.join(runtimePage, "index.html"), fsConstants.R_OK);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true, mode: 0o755 });
  const entries = await readdir(runtimePage, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "conferences.json") continue;
    const src = path.join(runtimePage, entry.name);
    const dest = path.join(stageDir, entry.name);
    if (entry.isDirectory()) await cp(src, dest, { recursive: true, dereference: false, filter: stageFilter });
    else if (entry.isFile()) {
      if (!stageFilter(src, dest)) continue;
      await cp(src, dest, { dereference: false });
    }
  }
  await writeFile(path.join(stageDir, "conferences.json"), `${JSON.stringify(active, null, 2)}\n`, { mode: 0o644 });
  await refreshStageIndex(stageDir, assetVersion);
  return validateStage(stageDir);
}

function stageFilter(src) {
  const name = path.basename(src);
  if (BLOCKED_STAGE_NAMES.has(name)) return false;
  if (name.startsWith(".")) return false;
  return true;
}

async function validateStage(stageDir) {
  const files = [];
  await walk(stageDir, "", files);
  if (!files.includes("index.html")) throw new Error("Staged page package is missing root index.html");
  for (const rel of files) {
    const parts = rel.split(path.sep);
    if (parts.some((part) => part === ".." || BLOCKED_STAGE_NAMES.has(part))) throw new Error(`Unsafe staged path: ${rel}`);
    const ext = path.extname(rel).toLowerCase();
    if (!ALLOWED_STAGE_EXTENSIONS.has(ext)) throw new Error(`Unexpected staged file extension: ${rel}`);
  }
  return { files: files.sort(), fileCount: files.length };
}

async function walk(root, rel, files) {
  const dir = path.join(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) await walk(root, childRel, files);
    else if (entry.isFile()) files.push(childRel);
  }
}

async function hashFile(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function runPublisher({ webDir, stageDir, dryRun }) {
  const args = [
    "--silent",
    "run",
    "publish:page",
    "--",
    "--dir", stageDir,
    "--id", PAGE_ID,
    "--title", PAGE_TITLE,
    "--ttl-hours", DEFAULT_TTL_HOURS,
    "--replace",
    "--source-agent", "codex",
    "--artifact-path", stageDir,
    "--source-json", JSON.stringify({
      operation: "conference-map-maintenance-loop",
      dataSource: DERIVED_CONFERENCES,
      dataListManifest: DERIVED_MANIFEST,
      canonicalResource: CANONICAL_RESOURCE,
    }),
  ];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync("/usr/bin/npm", args, {
    cwd: webDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`codex-chat-web publisher failed (${result.status}): ${result.stderr || result.stdout}`.trim());
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const now = new Date().toISOString();
  const canonicalPath = path.resolve(args.canonical);
  const store = await readJson(canonicalPath);
  const cutoff = cutoffFromCanonical(store, args.cutoff);
  const { active, pruned, retainedByException, missingEndDate } = activeRecordsFromCanonical(store, cutoff, { strictEndDate: args.strictEndDate });
  const { next: nextCanonical, changed: canonicalWouldChange } = updateCanonical(store, active, pruned, cutoff, now);
  const existingManifest = await readJson(DERIVED_MANIFEST).catch(() => ({}));
  const nextManifest = buildDerivedManifest(existingManifest, { canonicalPath, store: nextCanonical, active, cutoff, now });

  const assetVersion = assetVersionFromIso(now);
  const stage = await stagePagePackage({ runtimePage: path.resolve(args.runtimePage), stageDir: path.resolve(args.stageDir), active, assetVersion });

  if (!args.dryRun) {
    if (canonicalWouldChange) await writeJsonAtomic(canonicalPath, nextCanonical);
    await writeJsonAtomic(DERIVED_CONFERENCES, active);
    await writeJsonAtomic(DERIVED_MANIFEST, nextManifest);
  }

  const publish = args.skipPublish ? null : runPublisher({ webDir: path.resolve(args.webDir), stageDir: path.resolve(args.stageDir), dryRun: args.dryRun });

  const summary = {
    ok: true,
    dryRun: args.dryRun,
    cutoffEndOnOrAfter: cutoff,
    cutoffSource: args.cutoffSource || (args.cutoff ? "override" : "canonical resource"),
    strictEndDate: args.strictEndDate === true,
    sourceRecords: store.records.length,
    activeRecords: active.length,
    prunedRecords: pruned.length,
    retainedByExceptionRecords: retainedByException.length,
    missingEndDateRecordsKept: missingEndDate.length,
    missingEndDateRule: "Records without a valid end date are kept; existing convention does not fall back to start date.",
    canonicalUpdated: !args.dryRun && canonicalWouldChange,
    derivedUpdated: !args.dryRun,
    stageDir: path.resolve(args.stageDir),
    assetVersion,
    stagedFiles: stage.fileCount,
    stagedConferencesSha256: await hashFile(path.join(path.resolve(args.stageDir), "conferences.json")),
    published: Boolean(publish && !args.dryRun),
    publish,
  };

  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`conference-map maintenance ${args.dryRun ? "dry-run" : "complete"}`);
    console.log(`cutoff: keep events ending on/after ${cutoff}${summary.strictEndDate ? " (strict end-date pruning)" : ""}`);
    console.log(`records: ${store.records.length} source -> ${active.length} active; ${pruned.length} pruned${canonicalWouldChange ? " (canonical would change)" : ""}`);
    if (retainedByException.length > 0) console.log(`retained by exception: ${retainedByException.length}`);
    if (missingEndDate.length > 0) console.log(`missing/invalid end date: ${missingEndDate.length} kept; no start-date fallback is used`);
    console.log(`staged: ${summary.stageDir} (${stage.fileCount} files)`);
    if (publish) console.log(`publisher: ${publish.dryRun ? "dry-run " : ""}${publish.url}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
