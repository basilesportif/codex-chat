import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import { slackTargetChannelId, slackTargetThreadTs, withSlackRuntimeContext } from "./runtime.js";
import type { OutputTarget, UserEvent } from "./types.js";
import { nowIso } from "./util.js";

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_TOLERANCE_SEC = 5 * 60;
const SLACK_TEXT_MAX_CHARS = 38_000;
const SLACK_USER_INFO_CACHE_TTL_MS = 60 * 60_000;
const SLACK_USER_INFO_NEGATIVE_CACHE_TTL_MS = 5 * 60_000;

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

export type SlackReactionResult =
  | { ok: true }
  | { ok: false; error: string; status?: number; retryAfterSec?: number };

export interface SlackHistoryMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
}

export type SlackHistoryFetchResult =
  | { ok: true; messages: SlackHistoryMessage[]; responseMetadata?: Record<string, unknown> }
  | { ok: false; error: string; status?: number; retryAfterSec?: number };

export interface SlackUserInfo {
  displayName?: string;
  realName?: string;
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
  const eventThreadTs = slackEvent.thread_ts;
  const sourceThreadTs = eventThreadTs && eventThreadTs !== messageTs ? eventThreadTs : undefined;
  const shouldAttachRootMentionThread = slackEvent.type === "app_mention" && isSlackChannelLike(channelType) && !sourceThreadTs;
  const threadTs = eventThreadTs ?? (shouldAttachRootMentionThread ? messageTs : undefined);
  const enterpriseId = envelope.enterprise_id ?? envelope.authorizations?.find((item) => item.enterprise_id)?.enterprise_id ?? undefined;
  const sourceKind = slackSourceKindFromEvent({ channelType, sourceThreadTs });

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
      slackEventThreadTs: eventThreadTs,
      slackSourceThreadTs: sourceThreadTs,
      slackThreadTs: threadTs,
      slackReplyThreadTs: threadTs,
      slackSourceKind: sourceKind,
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
  private readonly userInfoCache = new Map<string, { expiresAt: number; value?: SlackUserInfo }>();

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

  async getUserInfo(userId: string, timeoutMs = 2_500): Promise<SlackUserInfo | undefined> {
    const cached = this.userInfoCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (!this.config.slackBotToken) {
      this.cacheUserInfo(userId, undefined);
      this.logger.warn({ component: "slack", event: "user_info_failed", userId, error: `${this.config.slack.botTokenEnv} is required for Slack users.info` }, "Slack users.info failed");
      return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(slackApiUrlWithQuery("users.info", { user: userId }), {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.slackBotToken}`
        },
        signal: controller.signal
      });
      const payload = await response.json().catch(() => undefined) as {
        ok?: boolean;
        error?: string;
        user?: {
          name?: string;
          real_name?: string;
          profile?: {
            display_name?: string;
            real_name?: string;
          };
        };
      } | undefined;
      if (!response.ok || payload?.ok !== true || !payload.user) {
        const error = payload?.error ?? `http_${response.status}`;
        this.logger.warn({ component: "slack", event: "user_info_failed", userId, status: response.status, error }, "Slack users.info failed");
        this.cacheUserInfo(userId, undefined);
        return undefined;
      }
      const realName = payload.user.profile?.real_name || payload.user.real_name || undefined;
      const displayName = payload.user.profile?.display_name || payload.user.profile?.real_name || payload.user.real_name || payload.user.name || undefined;
      const value = displayName || realName ? { displayName, realName } : undefined;
      this.cacheUserInfo(userId, value);
      return value;
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error ? error.message : String(error);
      this.logger.warn({ component: "slack", event: "user_info_failed", userId, error: reason }, "Slack users.info failed");
      this.cacheUserInfo(userId, undefined);
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  cachedUserInfo(userId: string): SlackUserInfo | undefined {
    const cached = this.userInfoCache.get(userId);
    return cached && cached.expiresAt > Date.now() ? cached.value : undefined;
  }

  async addReaction(input: {
    channel: string;
    timestamp: string;
    name: string;
    timeoutMs?: number;
  }): Promise<SlackReactionResult> {
    if (!this.config.slackBotToken) return { ok: false, error: `${this.config.slack.botTokenEnv} is required to add Slack reactions` };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 2_500);
    try {
      const response = await this.fetchImpl("https://slack.com/api/reactions.add", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.slackBotToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name
        }),
        signal: controller.signal
      });
      const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"));
      const payload = await response.json().catch(() => undefined) as { ok?: boolean; error?: string } | undefined;
      if (!response.ok || payload?.ok !== true) {
        const error = payload?.error ?? (response.status === 429 ? "rate_limited" : `http_${response.status}`);
        const logPayload = {
          component: "slack",
          event: "reaction_add_failed",
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.name,
          status: response.status,
          retryAfterSec,
          error
        };
        if (error === "already_reacted") {
          this.logger.debug(logPayload, "Slack immediate reaction already exists");
        } else {
          this.logger.warn(logPayload, "Slack immediate reaction failed");
        }
        return { ok: false, error, status: response.status, retryAfterSec };
      }
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error ? error.message : String(error);
      this.logger.warn({
        component: "slack",
        event: "reaction_add_failed",
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.name,
        error: reason
      }, "Slack immediate reaction failed");
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchConversationHistory(input: {
    channel: string;
    latest?: string;
    inclusive?: boolean;
    limit?: number;
    timeoutMs?: number;
  }): Promise<SlackHistoryFetchResult> {
    return this.fetchMessages("conversations.history", {
      channel: input.channel,
      latest: input.latest,
      inclusive: input.inclusive ?? true,
      limit: input.limit
    }, input.timeoutMs);
  }

  async fetchConversationReplies(input: {
    channel: string;
    threadTs: string;
    latest?: string;
    inclusive?: boolean;
    limit?: number;
    timeoutMs?: number;
  }): Promise<SlackHistoryFetchResult> {
    return this.fetchMessages("conversations.replies", {
      channel: input.channel,
      ts: input.threadTs,
      latest: input.latest,
      inclusive: input.inclusive ?? true,
      limit: input.limit
    }, input.timeoutMs, "GET");
  }

  private async fetchMessages(
    method: "conversations.history" | "conversations.replies",
    body: Record<string, unknown>,
    timeoutMs = 2_500,
    httpMethod: "GET" | "POST" = "POST",
  ): Promise<SlackHistoryFetchResult> {
    if (!this.config.slackBotToken) return { ok: false, error: `${this.config.slack.botTokenEnv} is required for Slack context hydration` };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestBody = pruneUndefined(body);
      const url = httpMethod === "GET"
        ? slackApiUrlWithQuery(method, requestBody)
        : `https://slack.com/api/${method}`;
      const response = await this.fetchImpl(url, {
        method: httpMethod,
        headers: httpMethod === "GET" ? {
          authorization: `Bearer ${this.config.slackBotToken}`
        } : {
          authorization: `Bearer ${this.config.slackBotToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: httpMethod === "POST" ? JSON.stringify(requestBody) : undefined,
        signal: controller.signal
      });
      const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"));
      const payload = await response.json().catch(() => undefined) as {
        ok?: boolean;
        error?: string;
        messages?: SlackHistoryMessage[];
        response_metadata?: Record<string, unknown>;
      } | undefined;
      if (!response.ok || payload?.ok !== true) {
        const error = payload?.error ?? (response.status === 429 ? "rate_limited" : `http_${response.status}`);
        this.logger.warn(
          {
            component: "slack",
            event: "history_fetch_failed",
            method,
            channel: typeof body.channel === "string" ? body.channel : undefined,
            status: response.status,
            retryAfterSec,
            error
          },
          "Slack context history fetch failed"
        );
        return { ok: false, error, status: response.status, retryAfterSec };
      }
      return { ok: true, messages: payload.messages ?? [], responseMetadata: payload.response_metadata };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : error instanceof Error ? error.message : String(error);
      this.logger.warn(
        {
          component: "slack",
          event: "history_fetch_failed",
          method,
          channel: typeof body.channel === "string" ? body.channel : undefined,
          error: reason
        },
        "Slack context history fetch failed"
      );
      return { ok: false, error: reason };
    } finally {
      clearTimeout(timeout);
    }
  }

  private cacheUserInfo(userId: string, value: SlackUserInfo | undefined): void {
    this.userInfoCache.set(userId, {
      value,
      expiresAt: Date.now() + (value ? SLACK_USER_INFO_CACHE_TTL_MS : SLACK_USER_INFO_NEGATIVE_CACHE_TTL_MS)
    });
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

function isSlackChannelLike(channelType: string | undefined): boolean {
  return channelType === "channel" || channelType === "group";
}

function slackSourceKindFromEvent(input: { channelType?: string; sourceThreadTs?: string }): string {
  if (input.sourceThreadTs) return "thread";
  if (input.channelType === "im") return "dm";
  if (input.channelType === "mpim") return "mpim";
  if (input.channelType === "group") return "private_channel_root";
  if (input.channelType === "channel") return "public_channel_root";
  return "unknown_conversation";
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

function pruneUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function slackApiUrlWithQuery(method: string, query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, String(value));
  }
  return `https://slack.com/api/${method}?${params.toString()}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
