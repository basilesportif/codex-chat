import { describe, expect, test } from "vitest";
import { LogBuffer, formatLogEntries, scrubSecrets } from "../log-buffer.js";

describe("LogBuffer", () => {
  test("stores newline-separated chunks as individual entries", () => {
    const buf = new LogBuffer(10);
    buf.append("stdout", "line one\nline two\nline three\n");
    expect(buf.size()).toBe(3);
    expect(buf.recent(10).map((e) => e.line)).toEqual(["line one", "line two", "line three"]);
  });

  test("respects capacity and drops oldest entries", () => {
    const buf = new LogBuffer(3);
    buf.append("stdout", "1\n2\n3\n4\n5\n");
    expect(buf.size()).toBe(3);
    expect(buf.recent(10).map((e) => e.line)).toEqual(["3", "4", "5"]);
  });

  test("returns at most n recent entries", () => {
    const buf = new LogBuffer(100);
    for (let i = 1; i <= 50; i++) buf.append("stderr", `line ${i}\n`);
    const last5 = buf.recent(5).map((e) => e.line);
    expect(last5).toEqual(["line 46", "line 47", "line 48", "line 49", "line 50"]);
  });

  test("scrubs OpenAI keys, GitHub tokens, and Telegram bot tokens", () => {
    const buf = new LogBuffer(10);
    buf.append(
      "stderr",
      "key=sk-proj-AAAAAAAAAAAAAAAAAAAAAA gh=ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBB tg=123456789:AABBccDDeeFFggHHiiJJkkLLmm\n"
    );
    const line = buf.recent(1)[0]!.line;
    expect(line).not.toMatch(/sk-proj-A/);
    expect(line).not.toMatch(/ghp_B/);
    expect(line).not.toMatch(/123456789:AABB/);
    expect(line).toContain("[REDACTED:openai]");
    expect(line).toContain("[REDACTED:github]");
    expect(line).toContain("[REDACTED:telegram]");
  });

  test("scrubs authorization-bearer and api_key headers", () => {
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("[REDACTED]");
    expect(scrubSecrets('api_key: "abcdefghijklmnopqrstuvwxyz123"')).toContain("[REDACTED]");
  });

  test("ignores empty input", () => {
    const buf = new LogBuffer(5);
    buf.append("stdout", "");
    buf.append("stdout", "\n\n");
    expect(buf.size()).toBe(0);
  });

  test("formatLogEntries renders ts, stream, and line", () => {
    const buf = new LogBuffer(5);
    buf.append("stdout", "hello\n");
    const formatted = formatLogEntries(buf.recent(1));
    expect(formatted).toMatch(/\[\d{4}-\d{2}-\d{2}T.*\] stdout hello/);
  });

  test("clear empties the buffer", () => {
    const buf = new LogBuffer(5);
    buf.append("stdout", "a\nb\n");
    expect(buf.size()).toBe(2);
    buf.clear();
    expect(buf.size()).toBe(0);
  });

  test("accepts event stream type for WS notification entries", () => {
    const buf = new LogBuffer(10);
    buf.append("event", "[TURN START] turn_id=abc123 session_id=sess456\n");
    buf.append("event", "[TOOL] shell_exec(ls -la)\n");
    buf.append("event", "[TOOL RESULT] shell_exec exit=0 output=total 8\n");
    buf.append("event", "[REASONING] turn_id=abc123 The user wants to list files\n");
    buf.append("event", "[TURN END] turn_id=abc123 status=completed\n");
    expect(buf.size()).toBe(5);
    const entries = buf.recent(5);
    expect(entries[0]!.stream).toBe("event");
    expect(entries[0]!.line).toMatch(/TURN START/);
    expect(entries[1]!.line).toMatch(/TOOL/);
    expect(entries[4]!.line).toMatch(/TURN END/);
  });

  test("event entries are mixed with stdout/stderr in chronological order", () => {
    const buf = new LogBuffer(10);
    buf.append("stderr", "app-server started\n");
    buf.append("event", "[TURN START] turn_id=t1 session_id=s1\n");
    buf.append("stderr", "some stderr output\n");
    buf.append("event", "[TURN END] turn_id=t1 status=completed\n");
    expect(buf.size()).toBe(4);
    const streams = buf.recent(4).map((e) => e.stream);
    expect(streams).toEqual(["stderr", "event", "stderr", "event"]);
  });

  test("formatLogEntries pads event stream label to 6 chars", () => {
    const buf = new LogBuffer(5);
    buf.append("event", "[TURN START] turn_id=abc\n");
    const formatted = formatLogEntries(buf.recent(1));
    // "event".padEnd(6) = "event " then template adds a space => "event  " (two spaces total)
    expect(formatted).toMatch(/\[.*\] event  \[TURN START\]/);
  });
});

describe("LogBuffer raw filtering", () => {
  test("raw entries are excluded from recent() by default", () => {
    const buf = new LogBuffer(10);
    buf.append("event", "[TURN START] turn_id=abc\n");
    buf.append("event", "[WS:thread/status/changed] {...}\n", true);
    buf.append("event", "[TURN END] turn_id=abc status=completed\n");
    // Default: raw entries excluded
    const clean = buf.recent(10);
    expect(clean).toHaveLength(2);
    expect(clean.map((e) => e.line)).not.toContain(expect.stringContaining("thread/status/changed"));
  });

  test("raw entries are included when includeRaw=true", () => {
    const buf = new LogBuffer(10);
    buf.append("event", "[TURN START] turn_id=abc\n");
    buf.append("event", "[WS:thread/status/changed] {...}\n", true);
    buf.append("event", "[TURN END] turn_id=abc status=completed\n");
    const all = buf.recent(10, true);
    expect(all).toHaveLength(3);
  });

  test("size() counts all entries including raw", () => {
    const buf = new LogBuffer(10);
    buf.append("event", "clean\n");
    buf.append("event", "noisy\n", true);
    expect(buf.size()).toBe(2);
  });

  test("recent(n) with includeRaw=false returns at most n non-raw entries", () => {
    const buf = new LogBuffer(20);
    for (let i = 0; i < 5; i++) buf.append("event", `clean ${i}\n`);
    for (let i = 0; i < 5; i++) buf.append("event", `noisy ${i}\n`, true);
    const last3 = buf.recent(3);
    expect(last3).toHaveLength(3);
    expect(last3.every((e) => !e.raw)).toBe(true);
  });
});
