#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const manifestPath = process.argv[2] ? resolve(process.argv[2]) : resolve(appDir, "manifest.json");
const metadataPath = process.argv[3] ? resolve(process.argv[3]) : resolve(appDir, "install-metadata.example.json");

const requiredScopes = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "reactions:write"
];
const requiredEvents = ["app_mention", "message.groups", "message.im", "message.mpim"];

const secretPatterns = [/xox[abprs]-[A-Za-z0-9-]{12,}/, /xapp-[A-Za-z0-9-]{12,}/];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  for (const pattern of secretPatterns) {
    assert(!pattern.test(text), `${path} appears to contain a Slack token; keep secrets out of slack-app`);
  }
  return JSON.parse(text);
}

function includesAll(actual, expected, label) {
  const values = new Set(actual ?? []);
  for (const item of expected) assert(values.has(item), `${label} is missing ${item}`);
}

function validateRequestUrl(url, label) {
  assert(typeof url === "string" && url.length > 0, `${label} must be a non-empty string`);
  const parsed = new URL(url);
  assert(parsed.protocol === "https:", `${label} must be HTTPS for Slack Events API delivery`);
  assert(parsed.pathname === "/api/slack/events", `${label} path must be /api/slack/events unless config is changed with it`);
}

const manifest = await readJson(manifestPath);
assert(manifest.display_information?.name, "manifest display_information.name is required");
assert(manifest.features?.bot_user?.display_name, "manifest bot_user.display_name is required");
includesAll(manifest.oauth_config?.scopes?.bot, requiredScopes, "manifest bot scopes");
includesAll(manifest.settings?.event_subscriptions?.bot_events, requiredEvents, "manifest bot events");
validateRequestUrl(manifest.settings?.event_subscriptions?.request_url, "manifest request_url");
assert(manifest.settings?.socket_mode_enabled === false, "Phase 2 manifest should keep socket_mode_enabled=false");
assert(manifest.settings?.interactivity?.is_enabled === false, "Phase 2 manifest should keep interactivity disabled");

const metadata = await readJson(metadataPath);
assert(metadata.schema === "codex-chat/slack-install-metadata/v1", "install metadata schema mismatch");
assert(metadata.bot_install?.bot_token_env === "SLACK_BOT_TOKEN", "install metadata should name SLACK_BOT_TOKEN env var, not a token");
assert(metadata.bot_install?.signing_secret_env === "SLACK_SIGNING_SECRET", "install metadata should name SLACK_SIGNING_SECRET env var, not a secret");
includesAll(metadata.scopes?.bot, requiredScopes, "install metadata bot scopes");
includesAll(metadata.events?.bot_events, requiredEvents, "install metadata bot events");
validateRequestUrl(metadata.events?.request_url, "install metadata request_url");

console.log(`Slack app manifest and metadata template look valid: ${manifestPath}`);
