import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfig, resolveConfigPath } from "./config.js";
import { LoopRun, MonitorEvent, StoredAction, SubagentJob } from "./types.js";
import { atomicWriteJson, atomicWriteText, ensureDir, nowIso, pathExists, removeIfExists } from "./util.js";

const pairingCodePath = "data/pairing_code.txt";

export class StateStore {
  readonly root: string;
  private queues = new Map<string, Promise<void>>();

  constructor(config: AppConfig) {
    this.root = resolveConfigPath(config, config.service.stateDir);
  }

  async init(): Promise<void> {
    await ensureDir(this.root);
    for (const dir of ["messages", "files", "turns", "queued_turns", "jobs", "loop_runs", "monitor_events", "actions"]) {
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

  async appendJsonl(rel: string, value: unknown): Promise<void> {
    const path = this.path(rel);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }

  async recordMessage(value: unknown): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`messages/${day}.jsonl`, value);
  }

  async recordMonitorEvent(event: MonitorEvent): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    await this.appendJsonl(`monitor_events/${day}.jsonl`, event);
  }

  async saveAction(action: StoredAction): Promise<void> {
    await this.writeJson(`actions/${action.id}.json`, action);
  }

  async saveJob(job: SubagentJob): Promise<void> {
    await this.writeJson(`jobs/${job.id}.json`, job);
  }

  async saveLoopRun(run: LoopRun): Promise<void> {
    await this.writeJson(`loop_runs/${run.id}.json`, run);
  }

  async saveFileMetadata(id: string, metadata: unknown): Promise<void> {
    await this.writeJson(`files/${id}.json`, metadata);
  }

  async getCodexSession(name: string): Promise<string | undefined> {
    const sessions = await this.readJson<Record<string, { sessionId?: string }>>("codex_sessions.json", {});
    return sessions[name]?.sessionId;
  }

  async setCodexSession(name: string, value: Record<string, unknown>): Promise<void> {
    const sessions = await this.readJson<Record<string, Record<string, unknown>>>("codex_sessions.json", {});
    sessions[name] = { ...sessions[name], ...value, updatedAt: nowIso() };
    await this.writeJson("codex_sessions.json", sessions);
  }

  async clearCodexSession(name: string): Promise<void> {
    const sessions = await this.readJson<Record<string, Record<string, unknown>>>("codex_sessions.json", {});
    delete sessions[name];
    await this.writeJson("codex_sessions.json", sessions);
  }

  async listTelegramUsers(): Promise<Array<{ userId: number; isAdmin?: boolean; pairedAt?: string }>> {
    return this.readJson("telegram_users.json", []);
  }

  async listTelegramChats(): Promise<Array<{ chatId: number; pairedAt?: string }>> {
    return this.readJson("telegram_chats.json", []);
  }

  async addTelegramIdentity(userId: number, chatId: number, isAdmin: boolean): Promise<void> {
    const users = await this.listTelegramUsers();
    if (!users.some((user) => user.userId === userId)) users.push({ userId, isAdmin, pairedAt: nowIso() });
    const chats = await this.listTelegramChats();
    if (!chats.some((chat) => chat.chatId === chatId)) chats.push({ chatId, pairedAt: nowIso() });
    await this.writeJson("telegram_users.json", users);
    await this.writeJson("telegram_chats.json", chats);
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
