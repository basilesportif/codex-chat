/**
 * In-process ring buffer for Codex app-server stdout/stderr and WebSocket
 * event notifications.
 *
 * Used by the `get_logs` directive so Tim can introspect recent app-server
 * output from Telegram without SSH'ing into the box. The buffer holds at most
 * `capacity` lines; older lines are dropped silently.
 *
 * All entries are scrubbed for common secret patterns before they are stored
 * so that even if logs contain bearer tokens, OpenAI keys, GitHub tokens, or
 * the bot token, they will not leak when the buffer is exported.
 */

export interface LogBufferEntry {
  ts: string;
  stream: "stdout" | "stderr" | "event";
  line: string;
  /** True for high-frequency noisy events; omitted from recent() unless includeRaw=true. */
  raw?: boolean;
}

const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  // OpenAI API keys: sk-proj-... or sk-...
  { regex: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED:openai]" },
  // GitHub tokens
  { regex: /gh[pousr]_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:github]" },
  // Telegram bot tokens (NNNNN:AAAA...)
  { regex: /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED:telegram]" },
  // AWS access keys
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws]" },
  // Generic bearer-token-ish strings in headers / json
  { regex: /(authorization\s*[:=]\s*"?(?:bearer\s+)?)[A-Za-z0-9._-]{20,}/gi, replacement: "$1[REDACTED]" },
  { regex: /(api[_-]?key\s*[:=]\s*"?)[A-Za-z0-9._-]{20,}/gi, replacement: "$1[REDACTED]" }
];

export function scrubSecrets(line: string): string {
  let out = line;
  for (const { regex, replacement } of SECRET_PATTERNS) {
    out = out.replace(regex, replacement);
  }
  return out;
}

export class LogBuffer {
  private readonly entries: LogBufferEntry[] = [];

  constructor(private readonly capacity: number = 500) {
    if (capacity <= 0) throw new Error("LogBuffer capacity must be > 0");
  }

  /**
   * Append a chunk that may contain multiple newline-separated lines. Empty
   * trailing fragments (from partial reads) are stored as-is on the next
   * chunk, but for simplicity we just split on newlines and store non-empty
   * lines individually — Codex output is line-oriented and partial lines are
   * acceptable to fold into the next entry as a separate one.
   *
   * The `stream` parameter accepts "stdout", "stderr" (process output), or
   * "event" (formatted WebSocket notification events).
   *
   * When `isRaw` is true the entry is stored with `raw: true` and will be
   * excluded from recent() calls unless `includeRaw` is set.
   */
  append(stream: "stdout" | "stderr" | "event", chunk: string, isRaw = false): void {
    if (!chunk) return;
    const lines = chunk.split(/\r?\n/);
    const ts = new Date().toISOString();
    for (const rawLine of lines) {
      if (rawLine.length === 0) continue;
      const line = scrubSecrets(rawLine);
      const entry: LogBufferEntry = { ts, stream, line };
      if (isRaw) entry.raw = true;
      this.entries.push(entry);
      if (this.entries.length > this.capacity) this.entries.shift();
    }
  }

  /**
   * Returns up to `n` most-recent entries (oldest first).
   * When `includeRaw` is false (default) entries flagged as raw/noisy are excluded.
   */
  recent(n: number, includeRaw = false): LogBufferEntry[] {
    if (n <= 0) return [];
    const filtered = includeRaw ? this.entries : this.entries.filter((e) => !e.raw);
    if (n >= filtered.length) return filtered.slice();
    return filtered.slice(filtered.length - n);
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Format buffer entries as a single string suitable for embedding in a
 * Telegram code block. Each line is prefixed with timestamp + stream.
 */
export function formatLogEntries(entries: LogBufferEntry[]): string {
  return entries
    .map((entry) => `[${entry.ts}] ${entry.stream.padEnd(6)} ${entry.line}`)
    .join("\n");
}
