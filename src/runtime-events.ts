import type { Logger } from "pino";
import type { StateStore } from "./state.js";
import type { SlackTelemetryObservation } from "./slack-telemetry.js";
import { makeId, nowIso } from "./util.js";

/**
 * Structured runtime event log (plan §6.3). Append-only JSON-lines events that
 * capture what the old manual canary checklist tried to observe — inbound
 * accepted/rejected, context-assembly decisions, outbound attempt/success/
 * failure, subagent routing, and redaction checks. Events carry ids, kinds,
 * timestamps, and sanitized reasons only: NO message bodies, NO secrets, NO
 * tokens. It rides the same sanitized observations the telemetry summary
 * writer already produces, so it never sees raw content.
 */
export type RuntimeEventCategory =
  | "inbound"
  | "context"
  | "outbound"
  | "subagent"
  | "redaction";

export interface RuntimeEvent {
  schemaVersion: 1;
  id: string;
  seq: number;
  ts: string;
  category: RuntimeEventCategory;
  /** `${category}.${outcome}`, e.g. "inbound.accepted", "outbound.failure". */
  kind: string;
  surface?: string;
  outcome?: string;
  reason?: string;
  correlationId?: string;
  conversationSessionId?: string;
  jobId?: string;
  eventId?: string;
  channelId?: string;
  channelType?: string;
  threadTs?: string;
  responseStatus?: number;
  messagesIncluded?: number;
  contextTruncated?: boolean;
  promptExposed?: boolean;
  fallbackCodes?: string[];
  redactionApplied?: boolean;
}

export type RuntimeEventInput = Omit<RuntimeEvent, "id" | "seq">;

/**
 * Map a sanitized Slack telemetry observation into runtime events. Context
 * observations additionally yield a redaction-check event derived from the
 * `promptExposed` flag. Capability decisions are already persisted separately
 * (capability_decisions/*.jsonl) and are intentionally not duplicated here.
 */
export function runtimeEventsFromSlackObservation(
  observation: SlackTelemetryObservation,
  surface = "slack",
): RuntimeEventInput[] {
  if (observation.direction === "capability") return [];
  const category = observation.direction;
  const base: Omit<RuntimeEventInput, "category" | "kind"> = {
    schemaVersion: 1,
    ts: observation.observedAt || nowIso(),
    surface,
    outcome: observation.outcome,
    ...(observation.reason ? { reason: observation.reason } : {}),
    ...(observation.correlationId ? { correlationId: observation.correlationId } : {}),
    ...(observation.conversationSessionId ? { conversationSessionId: observation.conversationSessionId } : {}),
    ...(observation.jobId ? { jobId: observation.jobId } : {}),
    ...(observation.eventId ? { eventId: observation.eventId } : {}),
    ...(observation.channelId ? { channelId: observation.channelId } : {}),
    ...(observation.channelType ? { channelType: observation.channelType } : {}),
    ...(observation.threadTs ? { threadTs: observation.threadTs } : {}),
    ...(Number.isFinite(observation.responseStatus) ? { responseStatus: observation.responseStatus } : {}),
  };
  const events: RuntimeEventInput[] = [
    {
      ...base,
      category,
      kind: `${category}.${observation.outcome}`,
      ...(Number.isFinite(observation.messagesIncluded) ? { messagesIncluded: observation.messagesIncluded } : {}),
      ...(typeof observation.contextTruncated === "boolean" ? { contextTruncated: observation.contextTruncated } : {}),
      ...(typeof observation.promptExposed === "boolean" ? { promptExposed: observation.promptExposed } : {}),
      ...(observation.fallbackCodes?.length ? { fallbackCodes: [...observation.fallbackCodes] } : {}),
    },
  ];
  if (observation.direction === "context" && typeof observation.promptExposed === "boolean") {
    events.push({
      ...base,
      category: "redaction",
      kind: "redaction.check",
      outcome: observation.promptExposed ? "exposed" : "redacted",
      redactionApplied: !observation.promptExposed,
      ...(observation.fallbackCodes?.length ? { fallbackCodes: [...observation.fallbackCodes] } : {}),
    });
  }
  return events;
}

/**
 * In-memory pub/sub plus append-only persistence for runtime events. The
 * bounded ring buffer lets the agent-only tail endpoint replay recent events
 * on connect; persistence is delegated to the state store.
 */
export class RuntimeEventLog {
  private readonly buffer: RuntimeEvent[] = [];
  private readonly subscribers = new Set<(event: RuntimeEvent) => void>();
  private nextSeq = 1;

  constructor(
    private readonly state: Pick<StateStore, "recordRuntimeEvent">,
    private readonly logger: Logger,
    private readonly maxBuffer = 500,
  ) {}

  emit(input: RuntimeEventInput): RuntimeEvent {
    const event: RuntimeEvent = { ...input, id: makeId("evt"), seq: this.nextSeq++ };
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.logger.warn({ component: "runtime_events", event: "subscriber_failed", error }, "runtime event subscriber threw");
      }
    }
    void this.state.recordRuntimeEvent(event).catch((error) => {
      this.logger.warn({ component: "runtime_events", event: "persist_failed", error }, "runtime event persistence dropped");
    });
    return event;
  }

  emitSlackObservation(observation: SlackTelemetryObservation, surface = "slack"): void {
    for (const input of runtimeEventsFromSlackObservation(observation, surface)) this.emit(input);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Buffered events strictly newer than `afterTs` (all buffered if omitted). */
  recentAfter(afterTs?: string): RuntimeEvent[] {
    if (!afterTs) return [...this.buffer];
    const cutoff = Date.parse(afterTs);
    if (!Number.isFinite(cutoff)) return [...this.buffer];
    return this.buffer.filter((event) => Date.parse(event.ts) > cutoff);
  }

  /** Buffered events with a sequence greater than `afterSeq` (all buffered if omitted/invalid). */
  recentAfterSeq(afterSeq?: number | string): RuntimeEvent[] {
    const cutoff = parseRuntimeEventSeq(afterSeq);
    if (cutoff === undefined) return [...this.buffer];
    return this.buffer.filter((event) => event.seq > cutoff);
  }
}

function parseRuntimeEventSeq(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const trimmed = value?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
