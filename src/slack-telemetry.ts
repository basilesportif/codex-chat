import type { OutputTarget } from "./types.js";
import type { SlackEventEnvelope, SlackMessageLikeEvent, SlackSendTextResult } from "./slack.js";
import { slackTargetChannelId, slackTargetThreadTs } from "./runtime.js";
import type { HydratedSlackContext, SlackSourceKind } from "./slack-context.js";
import { nowIso } from "./util.js";

export type SlackTelemetryDirection = "inbound" | "outbound" | "context" | "subagent" | "capability";
export type SlackTelemetryOutcome =
  | "accepted"
  | "ignored"
  | "rejected"
  | "duplicate"
  | "url_verification"
  | "attempt"
  | "success"
  | "failure"
  | "hydrated"
  | "fallback"
  | "callback_routed"
  | "allowed"
  | "denied";

export interface SlackTelemetryObservation {
  schemaVersion: 1;
  observedAt: string;
  direction: SlackTelemetryDirection;
  outcome: SlackTelemetryOutcome;
  reason?: string;
  eventId?: string;
  envelopeType?: string;
  eventType?: string;
  teamId?: string;
  enterpriseId?: string;
  apiAppId?: string;
  channelId?: string;
  channelType?: string;
  userId?: string;
  botUserId?: string;
  messageTs?: string;
  threadTs?: string;
  slackEventTime?: number;
  textLength?: number;
  responseStatus?: number;
  outboundResultCount?: number;
  outboundResultChannels?: string[];
  outboundResultTs?: string[];
  sourceKind?: SlackSourceKind;
  selectedSources?: string[];
  messagesIncluded?: number;
  contextTruncated?: boolean;
  fallbackCodes?: string[];
  promptExposed?: boolean;
  outputThreadTsPresent?: boolean;
  conversationSessionId?: string;
  correlationId?: string;
  jobId?: string;
  capabilityId?: string;
  capabilityAction?: string;
  decisionStage?: string;
  grantIds?: string[];
  personId?: string;
  identityId?: string;
}

export interface SlackTelemetrySummary {
  schemaVersion: 1;
  updatedAt?: string;
  counters: Record<string, number>;
  lastInboundEvent?: SlackTelemetryObservation;
  lastAcceptedEvent?: SlackTelemetryObservation;
  lastIgnoredOrRejected?: SlackTelemetryObservation;
  lastOutboundAttempt?: SlackTelemetryObservation;
  lastOutboundSuccess?: SlackTelemetryObservation;
  lastOutboundFailure?: SlackTelemetryObservation;
  lastContextDecision?: SlackTelemetryObservation;
  lastSubagentRouting?: SlackTelemetryObservation;
}

export interface SlackTelemetryStatus extends SlackTelemetrySummary {
  health: {
    state: "unknown" | "observing" | "attention" | "degraded" | "stale";
    summary: string;
    generatedAt: string;
  };
  recentCanary: {
    status: "not_observable";
    summary: string;
  };
}

export function emptySlackTelemetrySummary(): SlackTelemetrySummary {
  return {
    schemaVersion: 1,
    counters: {},
  };
}

export function updateSlackTelemetrySummary(
  current: SlackTelemetrySummary | undefined,
  observation: SlackTelemetryObservation,
): SlackTelemetrySummary {
  const summary: SlackTelemetrySummary = {
    ...emptySlackTelemetrySummary(),
    ...(current && current.schemaVersion === 1 ? current : {}),
    counters: { ...(current?.counters ?? {}) },
    updatedAt: observation.observedAt,
  };
  const counterKey = `${observation.direction}.${observation.outcome}`;
  summary.counters[counterKey] = (summary.counters[counterKey] ?? 0) + 1;
  if (observation.direction === "inbound") summary.lastInboundEvent = observation;
  if (observation.direction === "inbound" && observation.outcome === "accepted") summary.lastAcceptedEvent = observation;
  if (observation.direction === "inbound" && (observation.outcome === "ignored" || observation.outcome === "rejected" || observation.outcome === "duplicate")) {
    summary.lastIgnoredOrRejected = observation;
  }
  if (observation.direction === "outbound" && observation.outcome === "attempt") summary.lastOutboundAttempt = observation;
  if (observation.direction === "outbound" && observation.outcome === "success") summary.lastOutboundSuccess = observation;
  if (observation.direction === "outbound" && observation.outcome === "failure") summary.lastOutboundFailure = observation;
  if (observation.direction === "context") summary.lastContextDecision = observation;
  if (observation.direction === "subagent") summary.lastSubagentRouting = observation;
  return summary;
}

export function slackTelemetryStatus(summary: SlackTelemetrySummary, now = new Date()): SlackTelemetryStatus {
  const generatedAt = now.toISOString();
  const updatedAtMs = summary.updatedAt ? Date.parse(summary.updatedAt) : NaN;
  const lastFailureMs = summary.lastOutboundFailure?.observedAt ? Date.parse(summary.lastOutboundFailure.observedAt) : NaN;
  const lastSuccessMs = summary.lastOutboundSuccess?.observedAt ? Date.parse(summary.lastOutboundSuccess.observedAt) : NaN;
  const lastAcceptedMs = summary.lastAcceptedEvent?.observedAt ? Date.parse(summary.lastAcceptedEvent.observedAt) : NaN;
  const lastRejectedMs = summary.lastIgnoredOrRejected?.observedAt ? Date.parse(summary.lastIgnoredOrRejected.observedAt) : NaN;
  let state: SlackTelemetryStatus["health"]["state"] = "unknown";
  let healthSummary = "No Slack telemetry observations have been recorded yet.";
  if (Number.isFinite(updatedAtMs)) {
    const ageMs = now.getTime() - updatedAtMs;
    const stale = ageMs > 24 * 60 * 60_000;
    const latestFailureIsUnrecovered = Number.isFinite(lastFailureMs) && (!Number.isFinite(lastSuccessMs) || lastFailureMs > lastSuccessMs);
    const latestRejectIsUnrecovered = Number.isFinite(lastRejectedMs)
      && summary.lastIgnoredOrRejected?.reason !== "duplicate_event"
      && (!Number.isFinite(lastAcceptedMs) || lastRejectedMs > lastAcceptedMs);
    if (latestFailureIsUnrecovered) {
      state = "degraded";
      healthSummary = `Last Slack outbound reply failed: ${summary.lastOutboundFailure?.reason ?? "unknown_failure"}.`;
    } else if (latestRejectIsUnrecovered) {
      state = "attention";
      healthSummary = `Last Slack inbound event was not accepted: ${summary.lastIgnoredOrRejected?.reason ?? "unknown_reason"}.`;
    } else if (stale) {
      state = "stale";
      healthSummary = `Last Slack telemetry observation is older than 24h (${summary.updatedAt}).`;
    } else {
      state = "observing";
      healthSummary = "Slack telemetry is recording recent accepted inbound events and/or outbound replies.";
    }
  }
  return {
    ...summary,
    health: {
      state,
      summary: healthSummary,
      generatedAt,
    },
    recentCanary: {
      status: "not_observable",
      summary: "No dedicated Slack canary marker is recorded yet; use last accepted inbound and outbound reply telemetry as observational signals.",
    },
  };
}

export function slackInboundTelemetryObservation(input: {
  envelope?: SlackEventEnvelope;
  outcome: Extract<SlackTelemetryOutcome, "accepted" | "ignored" | "rejected" | "duplicate" | "url_verification">;
  reason?: string;
  eventId?: string;
  responseStatus?: number;
  observedAt?: string;
}): SlackTelemetryObservation {
  const event = input.envelope?.event;
  return sanitizeSlackTelemetryObservation({
    schemaVersion: 1,
    observedAt: input.observedAt ?? nowIso(),
    direction: "inbound",
    outcome: input.outcome,
    reason: input.reason,
    eventId: input.eventId ?? input.envelope?.event_id,
    envelopeType: input.envelope?.type,
    eventType: event?.type,
    teamId: input.envelope?.team_id ?? event?.team ?? input.envelope?.authorizations?.find((item) => item.team_id)?.team_id ?? undefined,
    enterpriseId: input.envelope?.enterprise_id ?? input.envelope?.authorizations?.find((item) => item.enterprise_id)?.enterprise_id ?? undefined,
    apiAppId: input.envelope?.api_app_id,
    channelId: event?.channel,
    channelType: event?.channel_type ?? channelTypeFromId(event?.channel),
    userId: event?.user,
    botUserId: input.envelope?.authorizations?.find((item) => item.is_bot || item.user_id)?.user_id ?? undefined,
    messageTs: event?.ts ?? event?.event_ts,
    threadTs: event?.thread_ts,
    slackEventTime: input.envelope?.event_time,
    textLength: safeTextLength(event),
    responseStatus: input.responseStatus,
  });
}

export function slackOutboundTelemetryObservation(input: {
  target?: OutputTarget;
  outcome: Extract<SlackTelemetryOutcome, "attempt" | "success" | "failure">;
  reason?: string;
  results?: SlackSendTextResult[];
  observedAt?: string;
}): SlackTelemetryObservation {
  return sanitizeSlackTelemetryObservation({
    schemaVersion: 1,
    observedAt: input.observedAt ?? nowIso(),
    direction: "outbound",
    outcome: input.outcome,
    reason: input.reason,
    channelId: slackTargetChannelId(input.target),
    threadTs: slackTargetThreadTs(input.target),
    teamId: input.target?.teamId,
    responseStatus: undefined,
    outboundResultCount: input.results?.length,
    outboundResultChannels: uniqueDefined(input.results?.map((result) => result.channel)),
    outboundResultTs: uniqueDefined(input.results?.map((result) => result.ts)),
  });
}

export function slackContextTelemetryObservation(input: {
  event: {
    outputTarget?: OutputTarget;
    conversationSessionId?: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  };
  context: HydratedSlackContext;
  promptExposed: boolean;
  observedAt?: string;
}): SlackTelemetryObservation {
  const sourceOnly = input.context.selectedSources.every((source) => source === "source_event_only");
  return sanitizeSlackTelemetryObservation({
    schemaVersion: 1,
    observedAt: input.observedAt ?? nowIso(),
    direction: "context",
    outcome: input.context.fallbackCodes.length > 0 && sourceOnly ? "fallback" : "hydrated",
    teamId: stringValue(input.event.metadata?.slackTeamId) ?? input.event.outputTarget?.teamId,
    enterpriseId: stringValue(input.event.metadata?.slackEnterpriseId),
    channelId: stringValue(input.event.metadata?.slackChannelId) ?? input.event.outputTarget?.channelId,
    channelType: stringValue(input.event.metadata?.slackChannelType),
    userId: stringValue(input.event.metadata?.slackUserId),
    messageTs: stringValue(input.event.metadata?.slackMessageTs) ?? input.event.outputTarget?.messageId,
    threadTs: stringValue(input.event.metadata?.slackReplyThreadTs) ?? slackTargetThreadTs(input.event.outputTarget),
    eventId: stringValue(input.event.metadata?.slackEventId),
    sourceKind: input.context.sourceKind,
    selectedSources: input.context.selectedSources,
    messagesIncluded: input.context.messagesIncluded,
    contextTruncated: input.context.truncated,
    fallbackCodes: input.context.fallbackCodes,
    promptExposed: input.promptExposed,
    outputThreadTsPresent: Boolean(slackTargetThreadTs(input.event.outputTarget) ?? input.event.metadata?.slackReplyThreadTs),
    conversationSessionId: input.event.conversationSessionId,
    correlationId: input.event.correlationId,
  });
}

export function slackSubagentRoutingTelemetryObservation(input: {
  target?: OutputTarget;
  jobId?: string;
  conversationSessionId?: string;
  correlationId?: string;
  outcome?: Extract<SlackTelemetryOutcome, "callback_routed" | "failure">;
  reason?: string;
  observedAt?: string;
}): SlackTelemetryObservation {
  return sanitizeSlackTelemetryObservation({
    schemaVersion: 1,
    observedAt: input.observedAt ?? nowIso(),
    direction: "subagent",
    outcome: input.outcome ?? "callback_routed",
    reason: input.reason,
    channelId: slackTargetChannelId(input.target),
    threadTs: slackTargetThreadTs(input.target),
    teamId: input.target?.teamId,
    outputThreadTsPresent: Boolean(slackTargetThreadTs(input.target)),
    conversationSessionId: input.conversationSessionId,
    correlationId: input.correlationId,
    jobId: input.jobId,
  });
}

export function sanitizeSlackTelemetryObservation(observation: SlackTelemetryObservation): SlackTelemetryObservation {
  return {
    schemaVersion: 1,
    observedAt: validIsoOrNow(observation.observedAt),
    direction: observation.direction,
    outcome: observation.outcome,
    ...(observation.reason ? { reason: sanitizeReason(observation.reason) } : {}),
    ...(observation.eventId ? { eventId: boundedString(observation.eventId) } : {}),
    ...(observation.envelopeType ? { envelopeType: boundedString(observation.envelopeType) } : {}),
    ...(observation.eventType ? { eventType: boundedString(observation.eventType) } : {}),
    ...(observation.teamId ? { teamId: boundedString(observation.teamId) } : {}),
    ...(observation.enterpriseId ? { enterpriseId: boundedString(observation.enterpriseId) } : {}),
    ...(observation.apiAppId ? { apiAppId: boundedString(observation.apiAppId) } : {}),
    ...(observation.channelId ? { channelId: boundedString(observation.channelId) } : {}),
    ...(observation.channelType ? { channelType: boundedString(observation.channelType) } : {}),
    ...(observation.userId ? { userId: boundedString(observation.userId) } : {}),
    ...(observation.botUserId ? { botUserId: boundedString(observation.botUserId) } : {}),
    ...(observation.messageTs ? { messageTs: boundedString(observation.messageTs) } : {}),
    ...(observation.threadTs ? { threadTs: boundedString(observation.threadTs) } : {}),
    ...(Number.isFinite(observation.slackEventTime) ? { slackEventTime: observation.slackEventTime } : {}),
    ...(Number.isFinite(observation.textLength) ? { textLength: observation.textLength } : {}),
    ...(Number.isFinite(observation.responseStatus) ? { responseStatus: observation.responseStatus } : {}),
    ...(Number.isFinite(observation.outboundResultCount) ? { outboundResultCount: observation.outboundResultCount } : {}),
    ...(observation.outboundResultChannels?.length ? { outboundResultChannels: observation.outboundResultChannels.map(boundedString).slice(0, 20) } : {}),
    ...(observation.outboundResultTs?.length ? { outboundResultTs: observation.outboundResultTs.map(boundedString).slice(0, 20) } : {}),
    ...(observation.sourceKind ? { sourceKind: observation.sourceKind } : {}),
    ...(observation.selectedSources?.length ? { selectedSources: observation.selectedSources.map(boundedString).slice(0, 20) } : {}),
    ...(Number.isFinite(observation.messagesIncluded) ? { messagesIncluded: observation.messagesIncluded } : {}),
    ...(typeof observation.contextTruncated === "boolean" ? { contextTruncated: observation.contextTruncated } : {}),
    ...(observation.fallbackCodes?.length ? { fallbackCodes: observation.fallbackCodes.map(boundedString).slice(0, 20) } : {}),
    ...(typeof observation.promptExposed === "boolean" ? { promptExposed: observation.promptExposed } : {}),
    ...(typeof observation.outputThreadTsPresent === "boolean" ? { outputThreadTsPresent: observation.outputThreadTsPresent } : {}),
    ...(observation.conversationSessionId ? { conversationSessionId: boundedString(observation.conversationSessionId) } : {}),
    ...(observation.correlationId ? { correlationId: boundedString(observation.correlationId) } : {}),
    ...(observation.jobId ? { jobId: boundedString(observation.jobId) } : {}),
    ...(observation.capabilityId ? { capabilityId: boundedString(observation.capabilityId) } : {}),
    ...(observation.capabilityAction ? { capabilityAction: boundedString(observation.capabilityAction) } : {}),
    ...(observation.decisionStage ? { decisionStage: boundedString(observation.decisionStage) } : {}),
    ...(observation.grantIds?.length ? { grantIds: observation.grantIds.map(boundedString).slice(0, 20) } : {}),
    ...(observation.personId ? { personId: boundedString(observation.personId) } : {}),
    ...(observation.identityId ? { identityId: boundedString(observation.identityId) } : {}),
  };
}

function safeTextLength(event?: SlackMessageLikeEvent): number | undefined {
  return typeof event?.text === "string" ? event.text.length : undefined;
}

function channelTypeFromId(channelId?: string): string | undefined {
  if (!channelId) return undefined;
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  if (channelId.startsWith("C")) return "channel";
  return undefined;
}

function validIsoOrNow(value: string): string {
  return Number.isFinite(Date.parse(value)) ? value : nowIso();
}

function boundedString(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").slice(0, 200);
}

function sanitizeReason(value: string): string {
  return boundedString(value)
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/v0=[a-f0-9]{32,}/gi, "v0=[redacted-signature]");
}

function uniqueDefined(values?: Array<string | undefined>): string[] | undefined {
  const filtered = [...new Set((values ?? []).filter((value): value is string => Boolean(value)))];
  return filtered.length ? filtered : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
