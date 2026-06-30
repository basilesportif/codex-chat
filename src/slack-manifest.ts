import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const REQUIRED_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read"
];
const REQUIRED_BOT_EVENTS = ["app_mention", "message.groups", "message.im", "message.mpim"];
const SECRET_PATTERNS = [/xox[abprs]-[A-Za-z0-9-]{12,}/, /xapp-[A-Za-z0-9-]{12,}/];

export interface RenderSlackManifestOptions {
  rootDir: string;
  baseUrl: string;
  eventsPath: string;
  manifestPath?: string;
}

export interface SlackManifestValidationResult {
  ok: boolean;
  errors: string[];
}

function assertNoSlackSecrets(text: string, label: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`${label} appears to contain a Slack token; refusing to use it`);
  }
}

export function buildSlackEventsUrl(baseUrl: string, eventsPath: string): string {
  if (!eventsPath.startsWith("/")) throw new Error(`Slack events path must start with /: ${eventsPath}`);
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:") throw new Error(`Slack base URL must be HTTPS: ${baseUrl}`);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}${eventsPath}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function validateSlackManifest(manifest: unknown, expectedEventsPath = "/api/slack/events"): SlackManifestValidationResult {
  const errors: string[] = [];
  const record = manifest && typeof manifest === "object" ? manifest as Record<string, unknown> : {};
  const display = record.display_information as Record<string, unknown> | undefined;
  const features = record.features as Record<string, unknown> | undefined;
  const botUser = features?.bot_user as Record<string, unknown> | undefined;
  const oauth = record.oauth_config as Record<string, unknown> | undefined;
  const scopes = oauth?.scopes as Record<string, unknown> | undefined;
  const settings = record.settings as Record<string, unknown> | undefined;
  const eventSubscriptions = settings?.event_subscriptions as Record<string, unknown> | undefined;
  const botScopes = new Set(Array.isArray(scopes?.bot) ? scopes.bot.map(String) : []);
  const botEvents = new Set(Array.isArray(eventSubscriptions?.bot_events) ? eventSubscriptions.bot_events.map(String) : []);

  if (!display?.name) errors.push("display_information.name is required");
  if (!botUser?.display_name) errors.push("features.bot_user.display_name is required");
  for (const scope of REQUIRED_BOT_SCOPES) if (!botScopes.has(scope)) errors.push(`oauth_config.scopes.bot is missing ${scope}`);
  for (const event of REQUIRED_BOT_EVENTS) if (!botEvents.has(event)) errors.push(`settings.event_subscriptions.bot_events is missing ${event}`);

  const requestUrl = eventSubscriptions?.request_url;
  if (typeof requestUrl !== "string" || requestUrl.length === 0) {
    errors.push("settings.event_subscriptions.request_url must be a non-empty string");
  } else {
    try {
      const parsed = new URL(requestUrl);
      if (parsed.protocol !== "https:") errors.push("settings.event_subscriptions.request_url must be HTTPS");
      if (parsed.pathname !== expectedEventsPath) errors.push(`settings.event_subscriptions.request_url path must be ${expectedEventsPath}`);
    } catch {
      errors.push("settings.event_subscriptions.request_url must be a valid URL");
    }
  }
  if (settings?.socket_mode_enabled !== false) errors.push("settings.socket_mode_enabled must be false for HTTP Events API delivery");
  const interactivity = settings?.interactivity as Record<string, unknown> | undefined;
  if (interactivity?.is_enabled !== false) errors.push("settings.interactivity.is_enabled must be false for the current adapter");

  try {
    assertNoSlackSecrets(JSON.stringify(manifest), "manifest");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { ok: errors.length === 0, errors };
}

export async function renderSlackManifest(options: RenderSlackManifestOptions): Promise<{ manifest: unknown; text: string; requestUrl: string; validation: SlackManifestValidationResult }> {
  const manifestPath = options.manifestPath ?? resolve(options.rootDir, "slack-app", "manifest.json");
  const sourceText = await readFile(manifestPath, "utf8");
  assertNoSlackSecrets(sourceText, manifestPath);
  const manifest = JSON.parse(sourceText) as Record<string, unknown>;
  const settings = manifest.settings as Record<string, unknown> | undefined;
  const eventSubscriptions = settings?.event_subscriptions as Record<string, unknown> | undefined;
  if (!settings || !eventSubscriptions) throw new Error("manifest is missing settings.event_subscriptions");
  const requestUrl = buildSlackEventsUrl(options.baseUrl, options.eventsPath);
  eventSubscriptions.request_url = requestUrl;
  const validation = validateSlackManifest(manifest, options.eventsPath);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSlackSecrets(text, "rendered manifest");
  return { manifest, text, requestUrl, validation };
}
