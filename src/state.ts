import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { AppConfig, resolveConfigPath } from "./config.js";
import type { AudioIngestionRecord } from "./audio-ingest.js";
import { CapabilityDecision, CapabilityDecisionRecord, ConversationSession, EmployeeRuntimeState, LoopRun, MonitorEvent, ProgressEvent, StoredAction, SubagentBackendKind, SubagentJob } from "./types.js";
import type { RuntimeEvent } from "./runtime-events.js";
import { atomicWriteJson, atomicWriteText, ensureDir, nowIso, pathExists, removeIfExists } from "./util.js";
import {
  emptySlackTelemetrySummary,
  slackTelemetryStatus,
  updateSlackTelemetrySummary,
  type SlackTelemetryObservation,
  type SlackTelemetryStatus,
  type SlackTelemetrySummary
} from "./slack-telemetry.js";

const pairingCodePath = "data/pairing_code.txt";
const subagentRuntimePath = "subagent_runtime.json";

function outboundMessagePath(platform: "telegram" | "slack", conversationId: string, messageId: string): string {
  const key = createHash("sha256").update(`${platform}\0${conversationId}\0${messageId}`).digest("hex");
  return `outbound_messages/${platform}-${key}.json`;
}

interface SubagentRuntimeState {
  backendOverride?: SubagentBackendKind;
  updatedAt?: string;
  updatedBy?: string;
}

export interface RecordedTelegramMessage {
  direction?: string;
  source?: string;
  chatId?: number;
  userId?: number;
  messageId?: number;
  text?: string;
  receivedAt?: string;
}

export interface OutboundMessageRecord {
  platform: "telegram" | "slack";
  messageId: string;
  content: string;
  sentAt: string;
  chatId?: string;
  teamId?: string;
  channelId?: string;
  threadId?: string;
}

export class StateStore {
  readonly root: string;
  private queues = new Map<string, Promise<void>>();

  constructor(config: AppConfig) {
    this.root = resolveConfigPath(config, config.service.stateDir);
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    for (const dir of ["messages", "outbound_messages", "files", "turns", "queued_turns", "jobs", "employees", "employee_child_results", "loop_runs", "monitor_events", "actions", "audio_ingestions", "conversation_sessions", "progress_events", "slack_telemetry", "capability_decisions", "runtime_events"]) {
      await ensureDir(join(this.root, dir));
    }
    if (!(await pathExists(join(this.root, "schema.json")))) {
      await this.writeJson("schema.json", { version: 1, createdAt: nowIso() });
    }
    for (const [file, fallback] of [
      ["settings.json", {}],
      ["telegram_users.json", []],
      ["telegram_chats.json", []],
      ["codex_sessions.json", {}],
      ["monitors.json", {}]
    ] as const) {
      if (!(await pathExists(join(this.root, file)))) await this.writeJson(file, fallback);
    }
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  async readJson<T>(rel: string, fallback: T): Promise<T> {
    const path = this.path(rel);
    if (!(await pathExists(path))) return fallback;
    return JSON.parse(await readFile(path, "utf8")) as T;
  }

  async writeJson(rel: string, value: unknown): Promise<void> {
    const path = this.path(rel);
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.then(() => atomicWriteJson(path, value));
    this.trackQueueTail(path, next.catch(() => undefined));
    await next;
  }

  /**
   * Locked read-modify-write: fn receives the current value (or fallback) and
   * returns the value to persist, or undefined to skip the write. Serialized
   * against other updateJson/writeJson/withJsonFileLock calls for the path.
   */
  async updateJson<T>(rel: string, fallback: T, fn: (current: T) => T | undefined): Promise<void> {
    await this.withJsonFileLock(rel, async (path) => {
      const current = await readJsonFile<T>(path, fallback);
      const next = fn(current);
      if (next !== undefined) await atomicWriteJson(path, next);
    });
  }

  async appendJsonl(rel: string, value: unknown): Promise<void> {
    const path = this.path(rel);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async recordMessage(value: unknown): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`messages/${day}.jsonl`, value);
  }

  async saveOutboundMessage(record: OutboundMessageRecord): Promise<void> {
    const conversationId = record.platform === "slack"
      ? `${record.teamId ?? ""}:${record.channelId ?? ""}`
      : record.chatId ?? "";
    await this.writeJson(outboundMessagePath(record.platform, conversationId, record.messageId), record);
  }

  async findOutboundMessage(platform: OutboundMessageRecord["platform"], conversationId: string, messageId: string): Promise<OutboundMessageRecord | undefined> {
    return this.readJson<OutboundMessageRecord | undefined>(outboundMessagePath(platform, conversationId, messageId), undefined);
  }

  /** Atomically claims a normalized emoji follow-up. False means it was already delivered. */
  async claimEmojiFollowup(key: string): Promise<boolean> {
    let claimed = false;
    await this.updateJson<Record<string, { claimedAt: string }>>("emoji_followups/idempotency.json", {}, (current) => {
      if (current[key]) return undefined;
      claimed = true;
      return { ...current, [key]: { claimedAt: nowIso() } };
    });
    return claimed;
  }

  async findRecentTelegramInboundMessage(input: {
    chatId: number;
    beforeMessageId?: number;
    limitFiles?: number;
  }): Promise<RecordedTelegramMessage | undefined> {
    const dir = this.path("messages");
    const files = (await readdir(dir).catch(() => []))
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, input.limitFiles ?? 7);
    for (const file of files) {
      const path = join(dir, file);
      const lines = (await readFile(path, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        let record: RecordedTelegramMessage;
        try {
          record = JSON.parse(line) as RecordedTelegramMessage;
        } catch {
          continue;
        }
        if (record.direction !== "inbound") continue;
        if (record.source && record.source !== "telegram") continue;
        if (record.chatId !== input.chatId) continue;
        if (record.messageId !== undefined && input.beforeMessageId !== undefined && record.messageId >= input.beforeMessageId) continue;
        if (typeof record.text !== "string" || !record.text.trim()) continue;
        return record;
      }
    }
    return undefined;
  }

  async recordMonitorEvent(event: MonitorEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`monitor_events/${day}.jsonl`, event);
  }

  async saveConversationSession(session: ConversationSession): Promise<void> {
    await this.writeJson(`conversation_sessions/${session.id}.json`, session);
  }

  async readConversationSession(id: string): Promise<ConversationSession | undefined> {
    return this.readJson<ConversationSession | undefined>(`conversation_sessions/${id}.json`, undefined);
  }

  async recordProgressEvent(event: ProgressEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`progress_events/${day}.jsonl`, event);
  }

  async recordSlackTelemetryObservation(observation: SlackTelemetryObservation): Promise<void> {
    const rel = "slack_telemetry/summary.json";
    await this.withJsonFileLock(rel, async (summaryPath) => {
      const day = safeDay(observation.observedAt);
      await this.appendJsonl(`slack_telemetry/${day}.jsonl`, observation);
      const current = await readJsonFile<SlackTelemetrySummary>(summaryPath, emptySlackTelemetrySummary());
      await atomicWriteJson(summaryPath, updateSlackTelemetrySummary(current, observation));
    });
  }

  async recordRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const day = safeDay(event.ts);
    await this.appendJsonl(`runtime_events/${day}.jsonl`, event);
  }

  async recordCapabilityDecision(decision: CapabilityDecision): Promise<CapabilityDecisionRecord> {
    const record: CapabilityDecisionRecord = { ...decision, recordedAt: nowIso() };
    const day = safeDay(record.checkedAt);
    await this.appendJsonl(`capability_decisions/${day}.jsonl`, record);
    return record;
  }

  async readSlackTelemetrySummary(): Promise<SlackTelemetrySummary> {
    return this.readJson<SlackTelemetrySummary>("slack_telemetry/summary.json", emptySlackTelemetrySummary());
  }

  async readSlackTelemetryStatus(): Promise<SlackTelemetryStatus> {
    return slackTelemetryStatus(await this.readSlackTelemetrySummary());
  }

  async saveAction(action: StoredAction): Promise<void> {
    await this.writeJson(`actions/${action.id}.json`, action);
  }

  async saveJob(job: SubagentJob): Promise<void> {
    await this.writeJson(`jobs/${job.id}.json`, job);
  }

  async listJobs(): Promise<SubagentJob[]> {
    const dir = this.path("jobs");
    const files = await readdir(dir).catch(() => []);
    const jobs: SubagentJob[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        jobs.push(JSON.parse(await readFile(join(dir, file), "utf8")) as SubagentJob);
      } catch {
        // Ignore malformed historical job files; callers can still hydrate the rest.
      }
    }
    return jobs;
  }

  async saveEmployeeState(employee: EmployeeRuntimeState): Promise<void> {
    await this.writeJson(`employees/${employee.id}.json`, employee);
  }

  async readEmployeeState(id: string): Promise<EmployeeRuntimeState | undefined> {
    return this.readJson<EmployeeRuntimeState | undefined>(`employees/${id}.json`, undefined);
  }

  async listEmployeeStates(): Promise<EmployeeRuntimeState[]> {
    const files = (await readdir(this.path("employees")).catch(() => [])).map((file) => ({ dir: this.path("employees"), file }));
    const employees: EmployeeRuntimeState[] = [];
    const seen = new Set<string>();
    for (const { dir, file } of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const employee = JSON.parse(await readFile(join(dir, file), "utf8")) as EmployeeRuntimeState;
        if (seen.has(employee.id)) continue;
        seen.add(employee.id);
        employees.push(employee);
      } catch {
        // Ignore malformed historical employee state files.
      }
    }
    return employees;
  }

  async saveEmployeeChildResult(employeeId: string, jobId: string, value: unknown): Promise<string> {
    const safeEmployeeId = employeeId.replace(/[^A-Za-z0-9._-]/g, "_");
    const safeJobId = jobId.replace(/[^A-Za-z0-9._-]/g, "_");
    const rel = `employee_child_results/${safeEmployeeId}/${safeJobId}-${Date.now()}.json`;
    await this.writeJson(rel, value);
    return this.path(rel);
  }

  async saveLoopRun(run: LoopRun): Promise<void> {
    await this.writeJson(`loop_runs/${run.id}.json`, run);
  }

  async listLoopRuns(): Promise<LoopRun[]> {
    const dir = this.path("loop_runs");
    const files = await readdir(dir).catch(() => []);
    const runs: LoopRun[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        runs.push(JSON.parse(await readFile(join(dir, file), "utf8")) as LoopRun);
      } catch {
        // Ignore malformed historical run files; callers can still summarize the rest.
      }
    }
    return runs;
  }

  async saveFileMetadata(id: string, metadata: unknown): Promise<void> {
    await this.writeJson(`files/${id}.json`, metadata);
  }

  async saveAudioIngestion(record: AudioIngestionRecord): Promise<void> {
    await this.writeJson(`audio_ingestions/${record.id}.json`, record);
  }

  async readAudioIngestion(id: string): Promise<AudioIngestionRecord | undefined> {
    return this.readJson<AudioIngestionRecord | undefined>(`audio_ingestions/${id}.json`, undefined);
  }

  async claimAudioIngestionClientRequest(
    keyIdentity: string,
    clientRequestId: string,
    ingestionId: string
  ): Promise<{ claimed: true } | { claimed: false; ingestionId: string }> {
    const rel = "audio_ingestions/idempotency.json";
    return this.withJsonFileLock(rel, async (path) => {
      const current = await readJsonFile<Record<string, { ingestionId: string; claimedAt: string }>>(path, {});
      const idempotencyKey = audioIngestionIdempotencyKey(keyIdentity, clientRequestId);
      const existing = current[idempotencyKey];
      if (existing?.ingestionId) return { claimed: false, ingestionId: existing.ingestionId };
      current[idempotencyKey] = { ingestionId, claimedAt: nowIso() };
      await atomicWriteJson(path, pruneObject(current, 10_000));
      return { claimed: true };
    });
  }

  async findAudioIngestionByClientRequest(keyIdentity: string, clientRequestId: string): Promise<string | undefined> {
    const current = await this.readJson<Record<string, { ingestionId: string; claimedAt: string }>>("audio_ingestions/idempotency.json", {});
    return current[audioIngestionIdempotencyKey(keyIdentity, clientRequestId)]?.ingestionId;
  }

  async getCodexSession(name: string): Promise<string | undefined> {
    const sessions = await this.readJson<Record<string, { sessionId?: string }>>("codex_sessions.json", {});
    return sessions[name]?.sessionId;
  }

  async getCodexSessionBehaviorHash(name: string): Promise<string | undefined> {
    const sessions = await this.readJson<Record<string, { behaviorHash?: string }>>("codex_sessions.json", {});
    return sessions[name]?.behaviorHash;
  }

  async setCodexSession(name: string, value: Record<string, unknown>): Promise<void> {
    await this.withJsonFileLock("codex_sessions.json", async (path) => {
      const sessions = await readJsonFile<Record<string, Record<string, unknown>>>(path, {});
      sessions[name] = { ...sessions[name], ...value, updatedAt: nowIso() };
      await atomicWriteJson(path, sessions);
    });
  }

  async clearCodexSession(name: string): Promise<void> {
    await this.withJsonFileLock("codex_sessions.json", async (path) => {
      const sessions = await readJsonFile<Record<string, Record<string, unknown>>>(path, {});
      delete sessions[name];
      await atomicWriteJson(path, sessions);
    });
  }

  async getSubagentBackendOverride(): Promise<SubagentBackendKind | undefined> {
    const state = await this.readJson<SubagentRuntimeState>(subagentRuntimePath, {});
    return state.backendOverride;
  }

  async setSubagentBackendOverride(backend: SubagentBackendKind | undefined, updatedBy?: string): Promise<void> {
    await this.withJsonFileLock(subagentRuntimePath, async (path) => {
      const current = await readJsonFile<SubagentRuntimeState>(path, {});
      await atomicWriteJson(path, {
        ...current,
        backendOverride: backend,
        updatedAt: nowIso(),
        updatedBy
      } satisfies SubagentRuntimeState);
    });
  }


  async listTelegramUsers(): Promise<Array<{ userId: number; isAdmin?: boolean; pairedAt?: string }>> {
    return this.readJson("telegram_users.json", []);
  }

  async listTelegramChats(): Promise<Array<{ chatId: number; pairedAt?: string }>> {
    return this.readJson("telegram_chats.json", []);
  }

  async addTelegramIdentity(userId: number, chatId: number, isAdmin: boolean): Promise<void> {
    await this.withJsonFileLock("telegram_users.json", async (path) => {
      const users = await readJsonFile<Array<{ userId: number; isAdmin?: boolean; pairedAt?: string }>>(path, []);
      if (!users.some((user) => user.userId === userId)) users.push({ userId, isAdmin, pairedAt: nowIso() });
      await atomicWriteJson(path, users);
    });
    await this.withJsonFileLock("telegram_chats.json", async (path) => {
      const chats = await readJsonFile<Array<{ chatId: number; pairedAt?: string }>>(path, []);
      if (!chats.some((chat) => chat.chatId === chatId)) chats.push({ chatId, pairedAt: nowIso() });
      await atomicWriteJson(path, chats);
    });
  }

  async readPairingCode(): Promise<string | undefined> {
    const path = this.path(pairingCodePath);
    if (!(await pathExists(path))) return undefined;
    const code = (await readFile(path, "utf8")).trim();
    return code || undefined;
  }

  async writePairingCode(code: string): Promise<void> {
    await atomicWriteText(this.path(pairingCodePath), `${code}\n`, 0o600);
  }

  async deletePairingCode(): Promise<void> {
    await removeIfExists(this.path(pairingCodePath));
  }

  private async withJsonFileLock<T>(rel: string, fn: (path: string) => Promise<T>): Promise<T> {
    const path = this.path(rel);
    const previous = this.queues.get(path) ?? Promise.resolve();
    const next = previous.then(() => fn(path), () => fn(path));
    this.trackQueueTail(path, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * Store the per-path serialization tail and drop it once it settles while
   * still being the tail — one-shot paths (jobs/<id>.json, turns/<id>.json)
   * would otherwise accumulate a resolved-promise entry forever.
   */
  private trackQueueTail(path: string, tail: Promise<void>): void {
    this.queues.set(path, tail);
    void tail.finally(() => {
      if (this.queues.get(path) === tail) this.queues.delete(path);
    });
  }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  if (!(await pathExists(path))) return fallback;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function audioIngestionIdempotencyKey(keyIdentity: string, clientRequestId: string): string {
  return createHash("sha256").update(`${keyIdentity}\0${clientRequestId}`).digest("hex");
}

function pruneObject<T>(value: Record<string, T>, maxEntries: number): Record<string, T> {
  const entries = Object.entries(value);
  if (entries.length <= maxEntries) return value;
  return Object.fromEntries(entries.slice(entries.length - maxEntries));
}

function safeDay(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}
