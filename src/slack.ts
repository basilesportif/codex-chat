import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { slackTargetChannelId, slackTargetThreadTs, withSlackRuntimeContext } from "./runtime.js";
import type { OutputTarget, UserEvent } from "./types.js";
import { nowIso } from "./util.js";

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_TOLERANCE_SEC = 5 * 60;
const SLACK_TEXT_MAX_CHARS = 38_000;

export interface SlackSignatureVerificationInput {
  signingSecret?: string;
  body: Buffer | string;
  timestampHeader?: string;
  signatureHeader?: string;
  nowMs?: number;
}

export type SlackSignatureVerificationResult =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "missing_headers" | "invalid_timestamp" | "stale_timestamp" | "invalid_signature" };

export interface SlackAuthorizationSnapshot {
  enterprise_id?: string | null;
  team_id?: string | null;
  user_id?: string | null;
  is_bot?: boolean | null;
}

export interface SlackEventEnvelope {
  type?: string;
  token?: string;
  challenge?: string;
  team_id?: string;
  enterprise_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackMessageLikeEvent;
  authorizations?: SlackAuthorizationSnapshot[];
}

export interface SlackMessageLikeEvent {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  team?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
}

export type SlackEventNormalizationResult =
  | { status: "event"; event: UserEvent; eventId: string }
  | { status: "ignored"; eventId?: string; reason: string };

export interface SlackSendTextResult {
  channel?: string;
  ts?: string;
}

export function verifySlackRequestSignature(input: SlackSignatureVerificationInput): SlackSignatureVerificationResult {
  if (!input.signingSecret) return { ok: false, reason: "missing_secret" };
  if (!input.timestampHeader || !input.signatureHeader) return { ok: false, reason: "missing_headers" };
  if (!/^\d+$/.test(input.timestampHeader)) return { ok: false, reason: "invalid_timestamp" };

  const timestampSec = Number(input.timestampHeader);
  if (!Number.isSafeInteger(timestampSec)) return { ok: false, reason: "invalid_timestamp" };
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestampSec) > SLACK_SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  const basestring = `${SLACK_SIGNATURE_VERSION}:${timestampSec}:${body.toString("utf8")}`;
  const expected = `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", input.signingSecret).update(basestring).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(input.signatureHeader, "utf8");
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true };
}

export function slackSignatureForTest(signingSecret: string, body: string | Buffer, timestampSec: number): string {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const basestring = `${SLACK_SIGNATURE_VERSION}:${timestampSec}:${buffer.toString("utf8")}`;
  return `${SLACK_SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;
}

export function normalizeSlackEventCallback(envelope: SlackEventEnvelope, receivedAt = nowIso()): SlackEventNormalizationResult {
  const slackEvent = envelope.event;
  const eventId = envelope.event_id ?? derivedSlackEventId(envelope);
  if (!slackEvent) return { status: "ignored", eventId, reason: "missing_event" };
  if (!isSupportedSlackEvent(slackEvent)) return { status: "ignored", eventId, reason: `unsupported_${slackEvent.type ?? "unknown"}` };
  if (isSlackBotOrSystemMessage(slackEvent)) return { status: "ignored", eventId, reason: "bot_or_system_message" };

  const teamId = envelope.team_id ?? slackEvent.team ?? envelope.authorizations?.find((item) => item.team_id)?.team_id ?? undefined;
  const channelId = slackEvent.channel;
  const userId = slackEvent.user;
  const messageTs = slackEvent.ts ?? slackEvent.event_ts;
  if (!teamId || !channelId || !userId || !messageTs) {
    return { status: "ignored", eventId, reason: "missing_required_metadata" };
  }
  const resolvedEventId = eventId ?? `${teamId}:${channelId}:${messageTs}`;

  const botUserId = envelope.authorizations?.find((item) => item.is_bot || item.user_id)?.user_id ?? undefined;
  const channelType = slackEvent.channel_type ?? slackChannelTypeFromId(channelId);
  const text = normalizeSlackText(slackEvent.text ?? "", botUserId, slackEvent.type === "app_mention");
  if (!text) return { status: "ignored", eventId, reason: "empty_text" };
  const threadTs = slackEvent.thread_ts ?? (channelType === "channel" ? messageTs : undefined);
  const enterpriseId = envelope.enterprise_id ?? envelope.authorizations?.find((item) => item.enterprise_id)?.enterprise_id ?? undefined;

  const event: UserEvent = withSlackRuntimeContext({
    source: "slack",
    username: slackEvent.username,
    text,
    attachments: [],
    receivedAt,
    metadata: {
      slackEventId: resolvedEventId,
      slackEventTime: envelope.event_time,
      slackEventType: slackEvent.type,
      slackTeamId: teamId,
      slackEnterpriseId: enterpriseId,
      slackApiAppId: envelope.api_app_id,
      slackChannelId: channelId,
      slackChannelType: channelType,
      slackUserId: userId,
      slackBotUserId: botUserId,
      slackMessageTs: messageTs,
      slackThreadTs: threadTs,
      slackRawTextLength: slackEvent.text?.length ?? 0
    }
  }, {
    teamId,
    enterpriseId,
    channelId,
    channelType,
    userId,
    userName: slackEvent.username,
    botUserId,
    messageTs,
    threadTs,
    eventId: resolvedEventId,
    eventTime: envelope.event_time,
    receivedAt
  });

  return { status: "event", event, eventId: resolvedEventId };
}

export function normalizeSlackText(text: string, botUserId?: string, stripBotMention = false): string {
  let normalized = text.replace(/\u00a0/g, " ").trim();
  if (stripBotMention && botUserId) {
    const mention = new RegExp(`<@${escapeRegExp(botUserId)}>(?:\\s|:|,)*`, "g");
    normalized = normalized.replace(mention, " ");
  } else if (stripBotMention) {
    normalized = normalized.replace(/<@[A-Z0-9]+>(?:\s|:|,)*/g, " ");
  }
  return normalized.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export class SlackGateway {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = globalThis.fetch
  ) {}

  async sendText(target: OutputTarget | undefined, text: string): Promise<SlackSendTextResult[]> {
    const channel = slackTargetChannelId(target);
    if (!target || target.surfaceKind !== "slack" || !channel) {
      throw new Error(`Unsupported or missing Slack text output target: ${target?.surfaceKind ?? "none"}`);
    }
    if (!this.config.slackBotToken) {
      throw new Error(`${this.config.slack.botTokenEnv} is required to send Slack messages`);
    }

    const threadTs = slackTargetThreadTs(target);
    const chunks = chunkSlackText(text);
    const results: SlackSendTextResult[] = [];
    for (const chunk of chunks) {
      const body: Record<string, unknown> = { channel, text: chunk };
      if (threadTs) body.thread_ts = threadTs;
      const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.slackBotToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => undefined) as { ok?: boolean; error?: string; channel?: string; ts?: string } | undefined;
      if (!response.ok || payload?.ok !== true) {
        const error = payload?.error ?? `http_${response.status}`;
        this.logger.warn({ component: "slack", event: "send_text_failed", channel, threadTs, error }, "Slack send_text failed");
        throw new Error(`Slack chat.postMessage failed: ${error}`);
      }
      results.push({ channel: payload.channel, ts: payload.ts });
    }
    return results;
  }
}

function isSupportedSlackEvent(event: SlackMessageLikeEvent): boolean {
  if (event.type === "app_mention") return true;
  if (event.type !== "message") return false;
  const channelType = event.channel_type ?? (event.channel ? slackChannelTypeFromId(event.channel) : undefined);
  return channelType === "im" || channelType === "mpim" || channelType === "group";
}

function isSlackBotOrSystemMessage(event: SlackMessageLikeEvent): boolean {
  if (!event.user) return true;
  if (event.bot_id) return true;
  if (!event.subtype) return false;
  return event.subtype !== "thread_broadcast";
}

function derivedSlackEventId(envelope: SlackEventEnvelope): string | undefined {
  const event = envelope.event;
  if (!event?.channel || !(event.ts ?? event.event_ts)) return undefined;
  const teamId = envelope.team_id ?? event.team ?? "unknown-team";
  return `${teamId}:${event.channel}:${event.ts ?? event.event_ts}`;
}

function slackChannelTypeFromId(channelId: string): string | undefined {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  if (channelId.startsWith("C")) return "channel";
  return undefined;
}

function chunkSlackText(text: string): string[] {
  const normalized = text || " ";
  if (normalized.length <= SLACK_TEXT_MAX_CHARS) return [normalized];
  const chunks: string[] = [];
  for (let index = 0; index < normalized.length; index += SLACK_TEXT_MAX_CHARS) {
    chunks.push(normalized.slice(index, index + SLACK_TEXT_MAX_CHARS));
  }
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
