#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://me.galebach.com";
const DEFAULT_EVENTS_PATH = "/api/slack/events";
const DEFAULT_FILENAME = "codex-chat.slack.manifest.json";
const secretPatterns = [/xox[abprs]-[A-Za-z0-9-]{12,}/, /xapp-[A-Za-z0-9-]{12,}/];

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");

function usage() {
  return `Usage: node slack-app/scripts/render-manifest.mjs [options]\n\nRenders slack-app/manifest.json with a deploy-specific Events API URL.\nWithout --output or --output-dir, the rendered manifest is written to stdout.\n\nOptions:\n  --base-url URL       Public codex-chat origin (default: ${DEFAULT_BASE_URL})\n  --events-path PATH   Slack Events API path (default: ${DEFAULT_EVENTS_PATH})\n  --events-url URL     Full Slack Events API URL; overrides base/path\n  --output FILE        Write manifest to FILE (supports ~ and relative paths)\n  --output-dir DIR     Write ${DEFAULT_FILENAME} under DIR (supports ~ and relative paths)\n  --manifest FILE      Source manifest template (default: slack-app/manifest.json)\n  -h, --help           Show this help\n\nEnvironment overrides are also supported: SLACK_EVENTS_URL, CODEX_CHAT_BASE_URL,\nand SLACK_EVENTS_PATH. CLI flags take precedence over environment values.\n`;
}

function fail(message) {
  console.error(`render-manifest: ${message}`);
  process.exit(1);
}

function normalizePath(value, label) {
  if (!value || typeof value !== "string") fail(`${label} must be a non-empty path`);
  let path = value;
  if (path === "~") {
    path = process.env.HOME ?? fail(`${label} uses ~ but HOME is not set`);
  } else if (path.startsWith("~/")) {
    const home = process.env.HOME ?? fail(`${label} uses ~ but HOME is not set`);
    path = join(home, path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function normalizeEventsPath(value) {
  const path = value || DEFAULT_EVENTS_PATH;
  if (!path.startsWith("/")) fail(`events path must start with /: ${path}`);
  if (/^https?:\/\//i.test(path)) fail("events path must be a path, not a URL; use --events-url for full URLs");
  return path;
}

function joinUrl(baseUrl, eventsPath) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    fail(`base URL is invalid: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:") fail(`base URL must be HTTPS for Slack: ${baseUrl}`);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${eventsPath}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function validateRequestUrl(url, expectedEventsPath) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(`events URL is invalid: ${url}`);
  }
  if (parsed.protocol !== "https:") fail(`events URL must be HTTPS for Slack: ${url}`);
  if (parsed.pathname !== expectedEventsPath) {
    fail(`events URL path must be ${expectedEventsPath}; got ${parsed.pathname}`);
  }
  return parsed.toString();
}

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
  const key = arg.slice(2);
  if (!["base-url", "events-path", "events-url", "output", "output-dir", "manifest"].includes(key)) {
    fail(`unknown option: ${arg}`);
  }
  const value = args[i + 1];
  if (!value || value.startsWith("--")) fail(`${arg} requires a value`);
  options[key] = value;
  i += 1;
}

if (options.output && options["output-dir"]) fail("use either --output or --output-dir, not both");

const manifestPath = options.manifest ? normalizePath(options.manifest, "manifest") : resolve(appDir, "manifest.json");
const eventsPath = normalizeEventsPath(options["events-path"] ?? process.env.SLACK_EVENTS_PATH ?? DEFAULT_EVENTS_PATH);
const eventsUrl = options["events-url"] ?? process.env.SLACK_EVENTS_URL ?? joinUrl(options["base-url"] ?? process.env.CODEX_CHAT_BASE_URL ?? DEFAULT_BASE_URL, eventsPath);
const requestUrl = validateRequestUrl(eventsUrl, eventsPath);
const outputPath = options.output
  ? normalizePath(options.output, "output")
  : options["output-dir"]
    ? join(normalizePath(options["output-dir"], "output-dir"), DEFAULT_FILENAME)
    : null;

const sourceText = await readFile(manifestPath, "utf8");
for (const pattern of secretPatterns) {
  if (pattern.test(sourceText)) fail(`${manifestPath} appears to contain a Slack token; keep secrets out of slack-app`);
}

const manifest = JSON.parse(sourceText);
if (!manifest.settings?.event_subscriptions) fail("manifest is missing settings.event_subscriptions");
manifest.settings.event_subscriptions.request_url = requestUrl;

const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
for (const pattern of secretPatterns) {
  if (pattern.test(rendered)) fail("rendered manifest appears to contain a Slack token; refusing to write it");
}

if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered, { mode: 0o644 });
  console.error(`Rendered Slack manifest to ${outputPath}`);
} else {
  process.stdout.write(rendered);
}
