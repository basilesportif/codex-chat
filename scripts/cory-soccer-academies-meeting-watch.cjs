#!/usr/bin/env node
/*
 * Gmail watch processor for the cory-soccer-academies-meeting-watch loop.
 *
 * Reads JSON output from assistant-agent-logic/scripts/gmail-search.js on stdin,
 * dedupes watched thread messages, and creates one calendar event when Cory Tell
 * proposes one unambiguous Monday meeting time in the allowed 8am-3pm ET window.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ASSISTANT_LOGIC_ROOT = process.env.ASSISTANT_AGENT_LOGIC_ROOT || "/home/tim/pkg/tim/assistant-agent-logic";
const CALENDAR_CREATE_SCRIPT =
  process.env.CALENDAR_CREATE_SCRIPT ||
  path.join(ASSISTANT_LOGIC_ROOT, "scripts/calendar-create-event.js");
const TIME_ZONE = process.env.EVENT_TIME_ZONE || "America/New_York";
const DEFAULT_MONDAY_DATE = process.env.DEFAULT_MONDAY_DATE || "2026-06-08";
const CALENDAR_ID = process.env.CALENDAR_ID || "personal";
const CORY_EMAIL = (process.env.CORY_EMAIL || "coryevantell@gmail.com").toLowerCase();
const DRY_RUN = process.env.WATCH_DRY_RUN === "1" || process.env.DRY_RUN === "1";
const SKIP_BODY_FETCH = process.env.SKIP_GMAIL_BODY_FETCH === "1" || DRY_RUN;
const BODY_FETCH_TIMEOUT_MS = Number(process.env.BODY_FETCH_TIMEOUT_MS || 15000);
const threadBodyCache = new Map();

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

function extractEmail(value) {
  const s = String(value || "");
  const angle = s.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : s).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return candidate ? candidate[0].toLowerCase() : "";
}

function parseMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function parseJson(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.error) throw new Error(parsed.error);
    throw new Error("expected an array");
  } catch (error) {
    throw new Error(`Could not parse gmail-search JSON: ${error.message}`);
  }
}

function loadState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

function saveState(statePath, next) {
  if (!statePath) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

function trimArray(values, limit) {
  return Array.from(values || []).filter(Boolean).slice(-limit);
}

function normalizeRelevantMessages(messages, watched, threadId) {
  return messages
    .filter((m) => !threadId || m.threadId === threadId)
    .filter((m) => watched.has(extractEmail(m.from)))
    .map((m) => ({
      ...m,
      _fromEmail: extractEmail(m.from),
      _ms: parseMs(m.date),
      _key: `${m.account || ""}:${m.id || m.threadId || ""}:${m.date || ""}`,
    }))
    .filter((m) => m._ms > 0)
    .sort((a, b) => a._ms - b._ms);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"');
}

function decodeBase64Url(data) {
  if (!data) return "";
  const normalized = String(data).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function collectPayloadParts(payload, out = { plain: [], html: [] }) {
  if (!payload) return out;
  if (payload.parts) {
    for (const part of payload.parts) collectPayloadParts(part, out);
  }
  const bodyData = payload.body && payload.body.data;
  if (bodyData) {
    const decoded = decodeBase64Url(bodyData);
    if (payload.mimeType === "text/plain") out.plain.push(decoded);
    else if (payload.mimeType === "text/html") out.html.push(htmlToText(decoded));
  }
  return out;
}

function stripQuotedText(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^On .+ wrote:$/i.test(trimmed)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)) break;
    if (/^From:\s+/i.test(trimmed) && kept.length > 0) break;
    if (/^>/.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function fetchMessageBody(message) {
  if (SKIP_BODY_FETCH || !message.account || (!message.id && !message.threadId)) return "";
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("body fetch timed out")), BODY_FETCH_TIMEOUT_MS)
  );
  return Promise.race([fetchMessageBodyInner(message), timeout]);
}

function resolveGmailAccountId(composio, accountEmail) {
  const accountEntry = Object.entries(composio.ACCOUNT_LABELS).find(
    ([id, email]) => id.startsWith("ca_") && String(email).toLowerCase() === String(accountEmail).toLowerCase()
  );
  if (!accountEntry) throw new Error(`No Gmail connected account found for ${accountEmail}`);
  return accountEntry[0];
}

async function fetchMessageBodyInner(message) {
  const { loadComposioConfig } = require(path.join(ASSISTANT_LOGIC_ROOT, "scripts/lib/config"));
  const { getAccessToken, googleFetch } = require(path.join(
    ASSISTANT_LOGIC_ROOT,
    "scripts/lib/google-auth"
  ));
  const composio = loadComposioConfig();
  const accountId = resolveGmailAccountId(composio, message.account);
  const token = await getAccessToken(accountId, { composio });

  if (message.id) {
    const data = await googleFetch(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`
    );
    const parts = collectPayloadParts(data.payload);
    return stripQuotedText((parts.plain.length ? parts.plain : parts.html).join("\n"));
  }

  return fetchBodyFromThread({ googleFetch, token, account: message.account, threadId: message.threadId, target: message });
}

async function fetchBodyFromThread({ googleFetch, token, account, threadId, target }) {
  const cacheKey = `${account}:${threadId}`;
  if (!threadBodyCache.has(cacheKey)) {
    const thread = await googleFetch(
      token,
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`
    );
    const items = (thread.messages || []).map((entry) => {
      const headers = {};
      (entry.payload?.headers || []).forEach((h) => {
        headers[h.name.toLowerCase()] = h.value;
      });
      const parts = collectPayloadParts(entry.payload);
      const body = stripQuotedText((parts.plain.length ? parts.plain : parts.html).join("\n"));
      return {
        id: entry.id,
        from: headers.from || "",
        date: headers.date || "",
        ms: parseMs(headers.date),
        fromEmail: extractEmail(headers.from),
        body,
      };
    });
    threadBodyCache.set(cacheKey, items);
  }
  const items = threadBodyCache.get(cacheKey) || [];
  const targetMs = target._ms || parseMs(target.date);
  const targetEmail = target._fromEmail || extractEmail(target.from);
  const candidates = items
    .filter((item) => item.fromEmail === targetEmail)
    .map((item) => ({ ...item, delta: Math.abs((item.ms || 0) - targetMs) }))
    .sort((a, b) => a.delta - b.delta);
  const match = candidates.find((item) => item.delta <= 10 * 60 * 1000) || candidates[0];
  return match ? match.body : "";
}

function localDate(date) {
  const d = new Date(`${date}T00:00:00-05:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekdayUtc(dateString) {
  const d = new Date(`${dateString}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

function nextOrSameMondayFrom(dateString) {
  const base = localDate(dateString) || localDate(DEFAULT_MONDAY_DATE) || new Date();
  const day = base.getUTCDay();
  const add = (8 - day) % 7;
  const next = new Date(base.getTime() + add * 24 * 60 * 60 * 1000);
  return isoDate(next);
}

function messageDateString(message) {
  const ms = parseMs(message.date);
  if (!ms) return DEFAULT_MONDAY_DATE;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function resolveMondayDate(text, message) {
  const lower = String(text || "").toLowerCase();
  const explicitDates = [];

  for (const match of lower.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    const date = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
    explicitDates.push(date);
  }

  for (const match of lower.matchAll(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\b/g
  )) {
    const month = MONTHS[match[1].replace(/\.$/, "")];
    const day = Number(match[2]);
    const year = Number(match[3] || new Date(`${DEFAULT_MONDAY_DATE}T12:00:00Z`).getUTCFullYear());
    const date = new Date(Date.UTC(year, month, day, 12));
    if (date.getUTCMonth() === month && date.getUTCDate() === day) explicitDates.push(isoDate(date));
  }

  for (const match of lower.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = match[3]
      ? Number(match[3].length === 2 ? `20${match[3]}` : match[3])
      : new Date(`${DEFAULT_MONDAY_DATE}T12:00:00Z`).getUTCFullYear();
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) explicitDates.push(isoDate(date));
  }

  const uniqueExplicit = [...new Set(explicitDates)];
  if (uniqueExplicit.length === 1) {
    if (weekdayUtc(uniqueExplicit[0]) !== 1) {
      return { ok: false, reason: `explicit date ${uniqueExplicit[0]} is not a Monday` };
    }
    return { ok: true, date: uniqueExplicit[0], source: "explicit-date" };
  }
  if (uniqueExplicit.length > 1) {
    const mondayDates = uniqueExplicit.filter((d) => weekdayUtc(d) === 1);
    if (mondayDates.length === 1) return { ok: true, date: mondayDates[0], source: "explicit-date" };
    return { ok: false, reason: `multiple possible dates: ${uniqueExplicit.join(", ")}` };
  }

  if (/\b(tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(lower) && !/\bmonday\b/i.test(lower)) {
    return { ok: false, reason: "message mentions a non-Monday day and no Monday" };
  }

  // The thread is already about the Monday meeting. Default to the configured
  // Monday, or the next/same Monday from the message date if the configured
  // value was removed in a future reuse of this script.
  const fallback = DEFAULT_MONDAY_DATE || nextOrSameMondayFrom(messageDateString(message));
  if (weekdayUtc(fallback) !== 1) return { ok: false, reason: `default date ${fallback} is not Monday` };
  return { ok: true, date: fallback, source: /\bmonday\b/i.test(lower) ? "monday-mention" : "thread-default" };
}

function parseTimeToken(token, context = {}) {
  const raw = String(token || "").trim().toLowerCase().replace(/\./g, "");
  if (/^(noon|midday)$/.test(raw)) return { minutes: 12 * 60, display: "12:00 PM" };
  const m = raw.match(/^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  const meridiem = m[3] || context.assumeMeridiem || null;
  if (hour < 1 || hour > 12) return null;
  if (meridiem === "am") {
    if (hour === 12) hour = 0;
  } else if (meridiem === "pm") {
    if (hour !== 12) hour += 12;
  } else if (hour >= 8 && hour <= 11) {
    // Unadorned 8/9/10/11 in this thread means morning within Tim's 8am-3pm window.
  } else if (hour === 12) {
    hour = 12;
  } else if (hour >= 1 && hour <= 3) {
    hour += 12;
  } else {
    return { ambiguous: true, raw: token };
  }
  const minutes = hour * 60 + minute;
  const displayHour = hour % 12 || 12;
  const display = `${displayHour}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
  return { minutes, display };
}

function isAllowedMeetingStart(minutes) {
  return minutes >= 8 * 60 && minutes <= 15 * 60;
}

function addMinutesToTime(minutes, add) {
  return minutes + add;
}

function timeIso(date, minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

function inferMeridiemForEnd(start, endToken) {
  const end = String(endToken || "").toLowerCase();
  if (/\b(am|pm)\b/.test(end)) return null;
  if (start.minutes >= 12 * 60) return "pm";
  return null;
}

function parseDurationMinutes(text) {
  const lower = String(text || "").toLowerCase();
  let m = lower.match(/\bfor\s+(\d{1,2})\s*(?:mins?|minutes?)\b/);
  if (m) return Number(m[1]);
  m = lower.match(/\bfor\s+(\d(?:\.5)?)\s*(?:hrs?|hours?)\b/);
  if (m) return Math.round(Number(m[1]) * 60);
  if (/\bfor\s+(?:an|one)\s+hour\b/.test(lower)) return 60;
  return null;
}

function skipNumericTimeCandidate(text, start, end) {
  const before = text[start - 1] || "";
  const after = text[end] || "";
  if (before === "/" || after === "/") return true;
  if (before === "-" || after === "-") return true;
  const prefix = text.slice(Math.max(0, start - 12), start).toLowerCase();
  const suffix = text.slice(end, Math.min(text.length, end + 12)).toLowerCase();
  if (/\b(jan|feb|mar|apr|may|jun|june|jul|aug|sep|oct|nov|dec)\.?\s*$/.test(prefix)) return true;
  if (/^\s*(?:min|mins|minutes|hour|hours|hrs|d)\b/.test(suffix)) return true;
  return false;
}


function hasTimeToken(text) {
  return /\b(?:noon|midday|\d{1,2}(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?)\b/i.test(
    String(text || "")
  );
}

function selectTimeParseText(text) {
  const source = String(text || "");
  const sentences = source
    .split(/(?<=[.!?])\s+|\n{2,}|\s+\bbut\b\s+|\s+\balso\b\s+|;/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return source;

  const mondayWithTime = sentences.filter((s) => /\bmonday\b/i.test(s) && hasTimeToken(s));
  if (mondayWithTime.length) return mondayWithTime.join(" ");

  // Exclude concrete times that are explicitly about another day. This prevents
  // text like "flexible Monday, but tomorrow 12-2:30" from creating a Monday
  // event at the tomorrow/Saturday time.
  const unsafeDay = /\b(today|tomorrow|tonight|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
  const safe = sentences.filter((s) => !unsafeDay.test(s));
  return safe.join(" ") || source;
}


function unsafeTimeContext(text, start, end) {
  const window = String(text || "")
    .slice(Math.max(0, start - 100), Math.min(String(text || "").length, end + 100))
    .toLowerCase();
  return /\b(today|tomorrow|tonight|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
    window
  ) && !/\bmonday\b/.test(window);
}

function parseMeetingTime(text) {
  const source = String(text || "").replace(/\u00a0/g, " ");
  const lower = source.toLowerCase();

  const timeToken = "(?:noon|midday|(?:\\d{1,2})(?::[0-5]\\d)?\\s*(?:a\\.?m\\.?|p\\.?m\\.?|am|pm)?)";
  const rangeRe = new RegExp(`\\b(${timeToken})\\s*(?:-|–|—|to|until)\\s*(${timeToken})\\b`, "gi");
  for (const match of source.matchAll(rangeRe)) {
    if (unsafeTimeContext(source, match.index || 0, (match.index || 0) + match[0].length)) continue;
    const start = parseTimeToken(match[1]);
    if (!start || start.ambiguous) continue;
    const end = parseTimeToken(match[2], { assumeMeridiem: inferMeridiemForEnd(start, match[2]) });
    if (!end || end.ambiguous) continue;
    let duration = end.minutes - start.minutes;
    if (duration <= 0 && start.minutes >= 12 * 60 && end.minutes < 12 * 60) duration += 12 * 60;
    if (duration > 0 && duration <= 4 * 60) {
      return { ok: true, minutes: start.minutes, display: start.display, durationMinutes: duration, source: "range" };
    }
  }

  const candidates = [];
  for (const match of lower.matchAll(/\b(noon|midday)\b/g)) {
    candidates.push({ ...parseTimeToken(match[1]), raw: match[1], index: match.index });
  }
  for (const match of source.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/gi)) {
    const token = match[0];
    const normalized = token.toLowerCase().replace(/\./g, "");
    if (skipNumericTimeCandidate(source, match.index, match.index + match[0].length)) continue;
    if (unsafeTimeContext(source, match.index, match.index + match[0].length)) continue;
    const parsed = parseTimeToken(normalized);
    if (parsed) candidates.push({ ...parsed, raw: token, index: match.index });
  }

  const usable = candidates.filter((c) => !c.ambiguous);
  const distinct = new Map(usable.map((c) => [c.minutes, c]));
  if (distinct.size === 0) {
    const ambiguous = candidates.find((c) => c.ambiguous);
    return ambiguous
      ? { ok: false, reason: `ambiguous time "${ambiguous.raw}"` }
      : { ok: false, reason: "no concrete time found" };
  }
  if (distinct.size > 1) {
    return {
      ok: false,
      reason: `multiple possible times: ${[...distinct.values()].map((c) => c.display).join(", ")}`,
    };
  }
  const only = [...distinct.values()][0];
  const durationMinutes = parseDurationMinutes(source) || 30;
  return { ok: true, minutes: only.minutes, display: only.display, durationMinutes, source: "single-time" };
}

function parseLocation(text) {
  const source = String(text || "");
  let m = source.match(/\b(?:location|place|venue)\s*:\s*([^\n.;]+)/i);
  if (m) return m[1].trim().slice(0, 120);
  m = source.match(/\bat\s+([A-Z][A-Za-z0-9&' .-]{2,80})(?:[.;\n]|$)/);
  if (m && !/^\d|^(noon|midday)\b/i.test(m[1].trim())) return m[1].trim().slice(0, 120);
  return "";
}

function formatSnippet(message, bodyText) {
  const text = bodyText || message.snippet || "";
  return String(text).replace(/\s+/g, " ").trim().slice(0, 240);
}

function createEvent(payload) {
  if (DRY_RUN) {
    return { dryRun: true, id: `dry-run-${Buffer.from(payload.start).toString("hex").slice(0, 12)}` };
  }
  const result = spawnSync("node", [CALENDAR_CREATE_SCRIPT, JSON.stringify(payload)], {
    cwd: ASSISTANT_LOGIC_ROOT,
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `calendar-create-event exited ${result.status}`).trim());
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { raw: result.stdout };
  }
}

function eventIdFromResponse(response) {
  return response && (response.id || response.event_id || response.htmlLink || response.raw || null);
}

async function main() {
  const raw = await readStdin();
  const messages = parseJson(raw);
  const statePath = process.env.WATCH_STATE_PATH;
  const threadId = process.env.WATCH_THREAD_ID;
  const watched = new Set(
    (process.env.WATCH_FROM_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  const relevant = normalizeRelevantMessages(messages, watched, threadId);
  const state = loadState(statePath);
  const previousLastSeenMs = Number(state && state.lastSeenMs ? state.lastSeenMs : 0);
  const seen = new Set(Array.isArray(state && state.seenMessageKeys) ? state.seenMessageKeys : []);
  const createdEventKeys = new Set(
    Array.isArray(state && state.createdEventKeys) ? state.createdEventKeys : []
  );
  const calendarEvents = Array.isArray(state && state.calendarEvents) ? state.calendarEvents.slice(-50) : [];
  const firstRun = !state;
  const newlyRelevant = firstRun
    ? []
    : relevant.filter((m) => m._ms > previousLastSeenMs && !seen.has(m._key));

  const lines = [];
  const bodyFetchErrors = [];

  for (const m of newlyRelevant) {
    let bodyText = "";
    try {
      bodyText = await fetchMessageBody(m);
    } catch (error) {
      bodyFetchErrors.push(`${m.id || m._key}: ${error.message}`);
    }
    const parseText = stripQuotedText(bodyText || m.snippet || "");
    const baseLine = `- ${m.from} on ${m.date} (${m.account}): ${m.subject || "(no subject)"}${formatSnippet(
      m,
      parseText
    ) ? ` — ${formatSnippet(m, parseText)}` : ""}`;

    if (m._fromEmail !== CORY_EMAIL) {
      lines.push(baseLine);
      continue;
    }

    const dateResult = resolveMondayDate(parseText, m);
    const timeParseText = selectTimeParseText(parseText);
    const timeResult = parseMeetingTime(timeParseText);
    if (!dateResult.ok || !timeResult.ok) {
      lines.push(
        `${baseLine}\n  Calendar: not created automatically (${!dateResult.ok ? dateResult.reason : timeResult.reason}); Tim should review.`
      );
      continue;
    }
    if (!isAllowedMeetingStart(timeResult.minutes)) {
      lines.push(
        `${baseLine}\n  Calendar: not created automatically (${timeResult.display} is outside 8:00 AM–3:00 PM ET); Tim should review.`
      );
      continue;
    }

    const start = timeIso(dateResult.date, timeResult.minutes);
    const end = timeIso(dateResult.date, addMinutesToTime(timeResult.minutes, timeResult.durationMinutes));
    const eventKey = `${threadId || m.threadId || "thread"}:Meet Cory Tell:${start}:${end}`;
    if (createdEventKeys.has(eventKey)) {
      lines.push(`${baseLine}\n  Calendar: event already recorded for ${dateResult.date} ${timeResult.display} ET.`);
      continue;
    }

    const eventPayload = {
      summary: "Meet Cory Tell",
      start,
      end,
      timeZone: TIME_ZONE,
      calendarId: CALENDAR_ID,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
      description: [
        "Auto-created by codex-chat from Cory Tell's Soccer Academies email thread.",
        `Thread ID: ${threadId || m.threadId || "unknown"}`,
        `Source message: ${m.id || "unknown"}`,
      ].join("\n"),
    };
    const location = parseLocation(parseText);
    if (location) eventPayload.location = location;

    try {
      const event = createEvent(eventPayload);
      createdEventKeys.add(eventKey);
      calendarEvents.push({
        eventKey,
        eventId: eventIdFromResponse(event),
        messageKey: m._key,
        start,
        end,
        calendarId: CALENDAR_ID,
        createdAt: new Date().toISOString(),
        dryRun: DRY_RUN || undefined,
      });
      lines.push(
        `${baseLine}\n  Calendar: created "Meet Cory Tell" on ${dateResult.date} at ${timeResult.display} ET for ${timeResult.durationMinutes} minutes${
          DRY_RUN ? " (dry run)" : ""
        }.`
      );
    } catch (error) {
      lines.push(`${baseLine}\n  Calendar: attempted but failed to create event: ${error.message}`);
    }
  }

  const maxSeenMs = Math.max(previousLastSeenMs, ...relevant.map((m) => m._ms), 0);
  for (const m of relevant) seen.add(m._key);

  const next = {
    purpose:
      "Dedupes codex-chat loop cory-soccer-academies-meeting-watch notifications and calendar event creation.",
    threadId,
    watchedFrom: [...watched],
    calendar: {
      summary: "Meet Cory Tell",
      calendarId: CALENDAR_ID,
      timeZone: TIME_ZONE,
      defaultMondayDate: DEFAULT_MONDAY_DATE,
      attendeesAdded: false,
      meetLinkPolicy: "No Meet/conference link; Cory is not auto-added as an attendee.",
    },
    lastSeenMs: maxSeenMs,
    lastSeenAt: maxSeenMs ? new Date(maxSeenMs).toISOString() : null,
    seenMessageKeys: trimArray(seen, 300),
    createdEventKeys: trimArray(createdEventKeys, 100),
    calendarEvents: calendarEvents.slice(-50),
    updatedAt: new Date().toISOString(),
  };
  saveState(statePath, next);

  if (!lines.length) return;
  if (bodyFetchErrors.length) {
    lines.push(`Body fetch fallback used for ${bodyFetchErrors.length} message(s): ${bodyFetchErrors.join("; ")}`);
  }
  console.log(
    `New response in Soccer Academies meeting thread from Cory Tell/Mikhail Lapushner:\n${lines.join(
      "\n"
    )}\n\nThread ID: ${threadId || "unknown"}`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = {
  extractEmail,
  parseMeetingTime,
  selectTimeParseText,
  resolveMondayDate,
  stripQuotedText,
};
