import type { UserEvent } from "./types.js";

export const DEFAULT_USER_TIME_ZONE = "America/New_York";

export interface TemporalAnchor {
  /** Instant whose local calendar meaning controls relative phrases in this turn. */
  anchorAt: string;
  /** Original source timestamp when the surface supplied one. */
  sourceTimestamp?: string;
  /** Time the service accepted the event for processing. */
  receivedAt: string;
  timeZone: string;
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function assertValidIanaTimeZone(value: string): string {
  if (!isValidIanaTimeZone(value)) throw new Error(`Invalid IANA timezone: ${value}`);
  return value;
}

export function temporalAnchorForEvent(event: Pick<UserEvent, "sourceTimestamp" | "receivedAt">, timeZone: string): TemporalAnchor {
  assertValidIanaTimeZone(timeZone);
  const sourceTimestamp = validIso(event.sourceTimestamp);
  const receivedAt = requiredIso(event.receivedAt, "receivedAt");
  return {
    anchorAt: sourceTimestamp ?? receivedAt,
    sourceTimestamp,
    receivedAt,
    timeZone
  };
}

export function processingTemporalAnchor(timeZone: string, now = new Date()): TemporalAnchor {
  assertValidIanaTimeZone(timeZone);
  const receivedAt = now.toISOString();
  return { anchorAt: receivedAt, receivedAt, timeZone };
}

export function formatTemporalAnchorBlock(anchor: TemporalAnchor): string {
  const localAnchor = formatLocalDateTime(anchor.anchorAt, anchor.timeZone);
  const delayed = Date.parse(anchor.receivedAt) - Date.parse(anchor.anchorAt);
  return [
    "Temporal anchor (authoritative for this message):",
    `- configured_timezone: ${anchor.timeZone}`,
    anchor.sourceTimestamp ? `- source_timestamp: ${anchor.sourceTimestamp}` : "",
    `- received_at: ${anchor.receivedAt}`,
    `- interpret_relative_dates_from: ${anchor.anchorAt}`,
    `- anchor_local_datetime: ${localAnchor}`,
    Number.isFinite(delayed) && delayed > 0 ? `- processing_delay_seconds: ${Math.floor(delayed / 1000)}` : "",
    "Interpret relative phrases such as today, tomorrow, tonight, and bare times from this anchor in configured_timezone, not from processing time or the host timezone. An explicit timezone named by the user overrides configured_timezone for that request."
  ].filter(Boolean).join("\n");
}

function formatLocalDateTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset"
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")} ${value("timeZoneName")} (${timeZone})`;
}

function validIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function requiredIso(value: string, label: string): string {
  const normalized = validIso(value);
  if (!normalized) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return normalized;
}
