import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfig, resolveConfigPath } from "./config.js";
import { EmployeeRuntimeState, LoopRun, MonitorEvent, StoredAction, StoredConversationMessage, SubagentBackendKind, SubagentJob } from "./types.js";
import { atomicWriteJson, atomicWriteText, ensureDir, nowIso, pathExists, removeIfExists } from "./util.js";

const pairingCodePath = "data/pairing_code.txt";
const subagentRuntimePath = "subagent_runtime.json";
const idempotencyLedgerPath = "actions/idempotency-ledger.json";
const apiIdempotencyLedgerPath = "api/idempotency-ledger.json";

interface SubagentRuntimeState {
  backendOverride?: SubagentBackendKind;
  updatedAt?: string;
  updatedBy?: string;
}

interface IdempotencyLedgerEntry {
  key: string;
  firstSeenAt: number;
  lastSeenAt: number;
  actionType?: string;
  actionId?: string;
}

interface IdempotencyLedger {
  version: 1;
  updatedAt: string;
  entries: IdempotencyLedgerEntry[];
}

export interface ApiMessageAcceptedResponse {
  accepted: true;
  messageId: string;
  conversationKey: string;
  status: "queued";
}

interface ApiIdempotencyLedgerEntry {
  key: string;
  firstSeenAt: number;
  lastSeenAt: number;
  response: ApiMessageAcceptedResponse;
}

interface ApiIdempotencyLedger {
  version: 1;
  updatedAt: string;
  entries: ApiIdempotencyLedgerEntry[];
}

export class StateStore {
  readonly root: string;
  private queues = new Map<string, Promise<void>>();

  constructor(config: AppConfig) {
    this.root = resolveConfigPath(config, config.service.stateDir);
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    for (const dir of ["messages", "conversation_messages", "files", "turns", "queued_turns", "jobs", "employees", "employee_child_results", "loop_runs", "monitor_events", "actions", "api"]) {
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
    this.queues.set(path, next.catch(() => undefined));
    await next;
  }

  async updateJson<T>(rel: string, fallback: T, update: (current: T) => T | Promise<T>): Promise<T> {
    const path = this.path(rel);
    const previous = this.queues.get(path) ?? Promise.resolve();
    let updated!: T;
    const next = previous.then(async () => {
      let current = fallback;
      if (await pathExists(path)) current = JSON.parse(await readFile(path, "utf8")) as T;
      updated = await update(current);
      await atomicWriteJson(path, updated);
    });
    this.queues.set(path, next.catch(() => undefined));
    await next;
    return updated;
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

  async recordConversationMessage(message: StoredConversationMessage): Promise<void> {
    await this.appendJsonl(`conversation_messages/${conversationFileKey(message.conversationKey)}.jsonl`, message);
  }

  async recordChannelMessage(message: StoredConversationMessage): Promise<void> {
    await this.recordMessage(message);
    await this.recordConversationMessage(message);
  }

  async listConversationMessages(
    conversationKey: string,
    options: { after?: string; limit?: number } = {}
  ): Promise<StoredConversationMessage[]> {
    const path = this.path(`conversation_messages/${conversationFileKey(conversationKey)}.jsonl`);
    if (!(await pathExists(path))) return [];
    const raw = await readFile(path, "utf8");
    const messages: StoredConversationMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as StoredConversationMessage;
        if (parsed.conversationKey === conversationKey) messages.push(parsed);
      } catch {
        // Ignore malformed historical rows.
      }
    }
    const after = options.after?.trim();
    const startIndex = after ? messages.findIndex((message) => message.id === after || message.channelMessageId === after) + 1 : 0;
    const boundedStart = startIndex > 0 ? startIndex : 0;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    return messages.slice(boundedStart, boundedStart + limit);
  }

  async recordMonitorEvent(event: MonitorEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`monitor_events/${day}.jsonl`, event);
  }

  async saveAction(action: StoredAction): Promise<void> {
    await this.writeJson(`actions/${action.id}.json`, action);
  }

  async claimIdempotencyKey(
    key: string,
    options: { ttlMs: number; maxEntries: number; actionType?: string; actionId?: string; nowMs?: number }
  ): Promise<boolean> {
    const nowMs = options.nowMs ?? Date.now();
    let claimed = false;
    await this.updateJson<IdempotencyLedger>(idempotencyLedgerPath, {
      version: 1,
      updatedAt: nowIso(),
      entries: []
    }, (ledger) => {
      const cutoff = nowMs - options.ttlMs;
      const entries = Array.isArray(ledger.entries)
        ? ledger.entries.filter((entry) => entry && typeof entry.key === "string" && entry.lastSeenAt >= cutoff)
        : [];
      const existing = entries.find((entry) => entry.key === key);
      if (existing) {
        existing.lastSeenAt = nowMs;
        existing.actionType = existing.actionType ?? options.actionType;
        existing.actionId = existing.actionId ?? options.actionId;
        claimed = false;
      } else {
        entries.push({
          key,
          firstSeenAt: nowMs,
          lastSeenAt: nowMs,
          actionType: options.actionType,
          actionId: options.actionId
        });
        claimed = true;
      }
      entries.sort((left, right) => left.lastSeenAt - right.lastSeenAt);
      while (entries.length > options.maxEntries) entries.shift();
      return { version: 1, updatedAt: nowIso(), entries };
    });
    return claimed;
  }

  async claimApiIdempotencyKey(
    key: string,
    response: ApiMessageAcceptedResponse,
    options: { ttlMs: number; maxEntries: number; nowMs?: number }
  ): Promise<{ claimed: boolean; response: ApiMessageAcceptedResponse }> {
    const nowMs = options.nowMs ?? Date.now();
    let claimed = false;
    let storedResponse = response;
    await this.updateJson<ApiIdempotencyLedger>(apiIdempotencyLedgerPath, {
      version: 1,
      updatedAt: nowIso(),
      entries: []
    }, (ledger) => {
      const cutoff = nowMs - options.ttlMs;
      const entries = Array.isArray(ledger.entries)
        ? ledger.entries.filter((entry) => entry && typeof entry.key === "string" && entry.lastSeenAt >= cutoff)
        : [];
      const existing = entries.find((entry) => entry.key === key);
      if (existing) {
        existing.lastSeenAt = nowMs;
        storedResponse = existing.response;
        claimed = false;
      } else {
        entries.push({
          key,
          firstSeenAt: nowMs,
          lastSeenAt: nowMs,
          response
        });
        claimed = true;
        storedResponse = response;
      }
      entries.sort((left, right) => left.lastSeenAt - right.lastSeenAt);
      while (entries.length > options.maxEntries) entries.shift();
      return { version: 1, updatedAt: nowIso(), entries };
    });
    return { claimed, response: storedResponse };
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

  async getCodexSession(name: string): Promise<string | undefined> {
    const sessions = await this.readJson<Record<string, { sessionId?: string }>>("codex_sessions.json", {});
    return sessions[name]?.sessionId;
  }

  async setCodexSession(name: string, value: Record<string, unknown>): Promise<void> {
    await this.updateJson<Record<string, Record<string, unknown>>>("codex_sessions.json", {}, (sessions) => {
      sessions[name] = { ...sessions[name], ...value, updatedAt: nowIso() };
      return sessions;
    });
  }

  async clearCodexSession(name: string): Promise<void> {
    await this.updateJson<Record<string, Record<string, unknown>>>("codex_sessions.json", {}, (sessions) => {
      delete sessions[name];
      return sessions;
    });
  }

  async getSubagentBackendOverride(): Promise<SubagentBackendKind | undefined> {
    const state = await this.readJson<SubagentRuntimeState>(subagentRuntimePath, {});
    return state.backendOverride;
  }

  async setSubagentBackendOverride(backend: SubagentBackendKind | undefined, updatedBy?: string): Promise<void> {
    await this.updateJson<SubagentRuntimeState>(subagentRuntimePath, {}, (current) => ({
      ...current,
      backendOverride: backend,
      updatedAt: nowIso(),
      updatedBy
    } satisfies SubagentRuntimeState));
  }


  async listTelegramUsers(): Promise<Array<{ userId: number; isAdmin?: boolean; pairedAt?: string }>> {
    return this.readJson("telegram_users.json", []);
  }

  async listTelegramChats(): Promise<Array<{ chatId: number; pairedAt?: string }>> {
    return this.readJson("telegram_chats.json", []);
  }

  async addTelegramIdentity(userId: number, chatId: number, isAdmin: boolean): Promise<void> {
    await this.updateJson<Array<{ userId: number; isAdmin?: boolean; pairedAt?: string }>>("telegram_users.json", [], (users) => {
      if (!users.some((user) => user.userId === userId)) users.push({ userId, isAdmin, pairedAt: nowIso() });
      return users;
    });
    await this.updateJson<Array<{ chatId: number; pairedAt?: string }>>("telegram_chats.json", [], (chats) => {
      if (!chats.some((chat) => chat.chatId === chatId)) chats.push({ chatId, pairedAt: nowIso() });
      return chats;
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
}

function conversationFileKey(conversationKey: string): string {
  return Buffer.from(conversationKey, "utf8").toString("base64url");
}
