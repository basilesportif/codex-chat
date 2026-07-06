import { spawn } from "node:child_process";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import type { Logger } from "pino";
import type { ChildProcess } from "node:child_process";
import { AppConfig, resolveConfigPath } from "./config.js";
import { sanitizeChildProcessEnv } from "./env.js";
import { readIpcToken, sendIpcMessage } from "./ipc.js";
import { StateStore } from "./state.js";
import { LoopRun, Route } from "./types.js";
import { atomicWriteText, ensureDir, killProcessTree, makeId, nowIso, pathExists } from "./util.js";

const routeSchema = z.enum(["return_to_main", "send_to_admins", "store_only", "dispatch_subagent"]);
const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
const serviceTierSchema = z.enum(["standard", "fast"]);
const loopSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  description: z.string().optional(),
  schedule: z.string().min(1),
  timezone: z.string().optional(),
  type: z.enum(["prompt", "command", "dispatch_subagent"]),
  prompt: z.string().optional(),
  promptFile: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  route: routeSchema.optional(),
  profile: z.string().optional(),
  timeoutSec: z.number().int().positive().optional(),
  model: z.string().optional(),
  effort: effortSchema.optional(),
  serviceTier: serviceTierSchema.optional(),
  lock: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  suppressEmptyOutput: z.boolean().optional(),
  durable: z.boolean().optional(),
  maxSpoolAgeSec: z.number().int().positive().optional()
}).superRefine((loop, ctx) => {
  try {
    CronExpressionParser.parse(loop.schedule);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}` });
  }
});

const loopsConfigSchema = z.object({
  version: z.literal(1),
  namespace: z.string().default("codex-chat"),
  defaults: z.object({
    timezone: z.string().default("Etc/UTC"),
    timeoutSec: z.number().int().positive().default(1800),
    route: routeSchema.default("return_to_main"),
    lock: z.boolean().default(true)
  }).default({ timezone: "Etc/UTC", timeoutSec: 1800, route: "return_to_main", lock: true }),
  loops: z.array(loopSchema).default([])
});

export type LoopDefinition = z.infer<typeof loopSchema>;
export type LoopsConfig = z.infer<typeof loopsConfigSchema>;

const LOOP_SHUTDOWN_DRAIN_MS = 10_000;

interface LoopCallbacks {
  enqueueMain(text: string, metadata?: Record<string, unknown>): Promise<void>;
  sendAdmins(text: string): Promise<void>;
  dispatchSubagent(input: { profile: string; prompt: string; route: Route; timeoutSec?: number; model?: string; effort?: string; serviceTier?: "standard" | "fast"; ownerId?: string; ownerRequestId?: string }): Promise<void>;
}

export async function loadLoopsConfig(config: AppConfig): Promise<LoopsConfig> {
  const path = resolveConfigPath(config, config.loops.path);
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return loopsConfigSchema.parse(parsed);
}

export async function syncCron(config: AppConfig, logger: Logger): Promise<{ changed: boolean; lines: string[] }> {
  const loops = await loadLoopsConfig(config);
  const existing = await runCommandCapture(config, "crontab", ["-l"]).catch((error) => {
    const text = String(error);
    if (text.includes("no crontab")) return "";
    return "";
  });
  await ensureDir(resolveConfigPath(config, "data/logs/cron"));
  await ensureDir(resolveConfigPath(config, "data/locks"));
  const generated = generateCronLines(config, loops);
  const next = buildManagedCronText(existing, config.loops.namespace, generated);
  if (generated.length === 0 && next.trim() === existing.trim()) {
    logger.debug({ component: "loops", event: "cron_sync_skipped_empty" }, "no enabled loops to sync");
    return { changed: false, lines: generated };
  }
  if (next.trim() === existing.trim()) return { changed: false, lines: generated };
  const temp = resolveConfigPath(config, "data/run/codex-chat.crontab");
  await atomicWriteText(temp, next, 0o600);
  await runCommandCapture(config, "crontab", [temp]);
  logger.info({ component: "loops", event: "cron_synced", count: generated.length }, "crontab synced");
  return { changed: true, lines: generated };
}

export async function runLoopCli(config: AppConfig, loopId: string): Promise<void> {
  const loops = await loadLoopsConfig(config);
  const loop = loops.loops.find((item) => item.id === loopId && item.enabled);
  if (!loop) throw new Error(`Loop not found or disabled: ${loopId}`);
  const socket = resolveConfigPath(config, config.service.ipcSocket);
  try {
    const token = await readIpcToken(socket);
    await sendIpcMessage(socket, { type: "loop_run", loopId, scheduledAt: nowIso(), token });
  } catch (error) {
    if (loop.durable) {
      const spoolDir = resolveConfigPath(config, "data/spool/loops");
      await ensureDir(spoolDir);
      await writeFile(join(spoolDir, `${Date.now()}-${loopId}.json`), JSON.stringify({ loopId, scheduledAt: nowIso(), error: String(error) }, null, 2));
      return;
    }
    throw error;
  }
}

export async function validateLoops(config: AppConfig): Promise<LoopsConfig> {
  return loadLoopsConfig(config);
}

export async function formatLoopsStatus(config: AppConfig, state: StateStore, now = new Date()): Promise<string> {
  const loops = await loadLoopsConfig(config);
  const runs = await state.listLoopRuns();
  const latestByLoopId = new Map<string, LoopRun>();
  for (const run of runs) {
    const previous = latestByLoopId.get(run.loopId);
    const runTime = Date.parse(run.completedAt ?? run.startedAt ?? run.scheduledAt);
    const previousTime = previous ? Date.parse(previous.completedAt ?? previous.startedAt ?? previous.scheduledAt) : Number.NEGATIVE_INFINITY;
    if (!previous || runTime > previousTime) latestByLoopId.set(run.loopId, run);
  }

  const enabled = loops.loops.filter((loop) => loop.enabled).length;
  const disabled = loops.loops.length - enabled;
  const lines = [`Loops: ${loops.loops.length} configured (${enabled} enabled, ${disabled} disabled)`];
  if (loops.loops.length === 0) return `${lines[0]}\nNo configured loops.`;

  const enabledLoops = loops.loops.filter((loop) => loop.enabled);
  const disabledLoops = loops.loops.filter((loop) => !loop.enabled);
  let index = 1;
  for (const [section, sectionLoops] of [["Enabled", enabledLoops], ["Disabled", disabledLoops]] as const) {
    if (sectionLoops.length === 0) continue;
    lines.push("", `${section}:`);
    const items = sectionLoops.map((loop) => formatLoopStatusItem(index++, loop, loops, latestByLoopId.get(loop.id), now));
    lines.push(items.join("\n\n"));
  }
  return lines.join("\n");
}

function formatLoopStatusItem(index: number, loop: LoopDefinition, loops: LoopsConfig, latest: LoopRun | undefined, now: Date): string {
  const route = loop.route ?? loops.defaults.route ?? "return_to_main";
  const lock = loop.lock ?? loops.defaults.lock;
  const timezone = loop.timezone ?? loops.defaults.timezone;
  const details = [
    `${index}. ${loop.id} — ${loop.enabled ? "enabled" : "disabled"}`,
    `   schedule/timezone: ${loop.schedule} (${timezone})`,
    `   type/route: ${loop.type} / ${route}`,
    `   lock/durable: lock=${lock} durable=${loop.durable === true}`
  ];
  if (loop.suppressEmptyOutput) details.push("   suppressEmptyOutput: true");
  if (loop.enabled) details.push(`   next run: ${formatNextRun(loop, loops, now)}`);
  if (latest) details.push(`   last run: ${latest.status} at ${latest.completedAt ?? latest.startedAt ?? latest.scheduledAt}`);
  return details.join("\n");
}

function formatNextRun(loop: LoopDefinition, loops: LoopsConfig, now: Date): string {
  try {
    const timezone = loop.timezone ?? loops.defaults.timezone;
    return CronExpressionParser.parse(loop.schedule, { currentDate: now, tz: timezone }).next().toDate().toISOString();
  } catch {
    return "invalid";
  }
}

export class LoopManager {
  private readonly activeLoopIds = new Set<string>();
  private readonly activeCommandChildren = new Set<ChildProcess>();
  private readonly activeRunPromises = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly callbacks: LoopCallbacks
  ) {}

  handleRun(loopId: string, scheduledAt = nowIso()): Promise<void> {
    const promise = this.executeRun(loopId, scheduledAt);
    this.activeRunPromises.add(promise);
    return promise.finally(() => {
      this.activeRunPromises.delete(promise);
    });
  }

  prepareForServiceShutdown(reason = "shutdown"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const child of this.activeCommandChildren) killProcessTree(child, "SIGTERM");
    this.logger.info(
      { component: "loops", event: "service_shutdown_prepare", activeCommands: this.activeCommandChildren.size, activeRuns: this.activeRunPromises.size, reason },
      "marking active loop runs interrupted before service shutdown"
    );
  }

  async shutdown(): Promise<void> {
    this.prepareForServiceShutdown("shutdown");
    if (this.activeRunPromises.size === 0) return;
    const active = Promise.allSettled([...this.activeRunPromises]);
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), LOOP_SHUTDOWN_DRAIN_MS));
    const result = await Promise.race([active, timeout]);
    if (result === "timeout") {
      this.logger.warn(
        { component: "loops", event: "shutdown_drain_timeout", activeRuns: this.activeRunPromises.size },
        "timed out waiting for interrupted loop runs to settle"
      );
    }
  }

  async reconcileStaleRunningRuns(): Promise<number> {
    const runs = await this.state.listLoopRuns();
    let reconciled = 0;
    for (const run of runs) {
      if (run.status !== "running") continue;
      run.status = "cancelled";
      run.completedAt = run.completedAt ?? nowIso();
      run.error = run.error ?? "Interrupted by service shutdown before completion.";
      await this.state.saveLoopRun(run);
      reconciled += 1;
    }
    if (reconciled > 0) {
      this.logger.warn({ component: "loops", event: "stale_running_reconciled", count: reconciled }, "reconciled stale running loop runs on startup");
    }
    return reconciled;
  }

  private async executeRun(loopId: string, scheduledAt: string): Promise<void> {
    const loops = await loadLoopsConfig(this.config);
    const loop = loops.loops.find((item) => item.id === loopId && item.enabled);
    if (!loop) throw new Error(`Loop not found or disabled: ${loopId}`);
    const route = (loop.route ?? loops.defaults.route ?? "return_to_main") as Route;
    const lock = loop.lock ?? loops.defaults.lock;
    if (lock) {
      if (this.activeLoopIds.has(loop.id)) throw new Error(`Loop already running: ${loop.id}`);
      this.activeLoopIds.add(loop.id);
    }
    const run: LoopRun = { id: makeId("loop"), loopId, status: "running", scheduledAt, startedAt: nowIso(), route };
    await this.state.saveLoopRun(run);
    try {
      if (loop.type === "prompt") await this.handlePrompt(loop, route, run);
      if (loop.type === "command") await this.handleCommand(loop, route, run);
      if (loop.type === "dispatch_subagent") await this.handleDispatch(loop, route, run);
      run.status = "completed";
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      if (this.isShutdownInterruptedError(error)) {
        run.status = "cancelled";
        run.error = "Interrupted by service shutdown before completion.";
        this.logger.info({ component: "loops", event: "run_interrupted", loopId, error }, "loop interrupted by service shutdown");
      } else {
        run.status = "failed";
        if (loop.notifyOnFailure) await this.callbacks.sendAdmins(`Loop ${loop.id} failed: ${run.error}`);
        this.logger.error({ component: "loops", event: "run_failed", loopId, error }, "loop failed");
      }
    } finally {
      if (lock) this.activeLoopIds.delete(loop.id);
      run.completedAt = nowIso();
      await this.state.saveLoopRun(run);
    }
  }

  async processSpooled(): Promise<void> {
    const spoolDir = resolveConfigPath(this.config, "data/spool/loops");
    if (!(await pathExists(spoolDir))) return;
    const seen = new Set<string>();
    for (const file of (await readdir(spoolDir)).sort()) {
      if (!file.endsWith(".json")) continue;
      const path = join(spoolDir, file);
      try {
        const body = JSON.parse(await readFile(path, "utf8")) as { loopId?: string; scheduledAt?: string };
        if (!body.loopId) throw new Error("Spooled loop run is missing loopId");
        const scheduledAt = body.scheduledAt ?? nowIso();
        const dedupeKey = `${body.loopId}:${scheduledAt}`;
        if (seen.has(dedupeKey)) {
          await this.quarantineSpooledFile(path, "duplicate");
          this.logger.warn({ component: "loops", event: "spool_run_duplicate", file, loopId: body.loopId, scheduledAt }, "duplicate spooled loop run quarantined");
          continue;
        }
        seen.add(dedupeKey);
        const stale = await this.isSpooledRunStale(body.loopId, scheduledAt);
        if (stale) {
          await this.quarantineSpooledFile(path, "stale");
          this.logger.warn({ component: "loops", event: "spool_run_stale", file, loopId: body.loopId, scheduledAt, maxSpoolAgeSec: stale.maxSpoolAgeSec, ageSec: stale.ageSec }, "stale spooled loop run quarantined");
          continue;
        }
        await this.handleRun(body.loopId, scheduledAt);
        await unlink(path);
      } catch (error) {
        await this.quarantineSpooledFile(path, "failed").catch((quarantineError) => {
          this.logger.error({ component: "loops", event: "spool_quarantine_failed", file, error: quarantineError }, "failed to quarantine spooled loop run");
        });
        this.logger.error({ component: "loops", event: "spool_run_failed", file, error }, "spooled loop run failed");
      }
    }
  }

  private async isSpooledRunStale(loopId: string, scheduledAt: string): Promise<{ ageSec: number; maxSpoolAgeSec: number } | null> {
    const loops = await loadLoopsConfig(this.config);
    const loop = loops.loops.find((item) => item.id === loopId && item.enabled);
    if (!loop) throw new Error(`Loop not found or disabled: ${loopId}`);
    if (!loop.maxSpoolAgeSec) return null;
    const scheduledMs = Date.parse(scheduledAt);
    if (!Number.isFinite(scheduledMs)) return null;
    const ageSec = Math.max(0, Math.floor((Date.now() - scheduledMs) / 1000));
    if (ageSec <= loop.maxSpoolAgeSec) return null;
    return { ageSec, maxSpoolAgeSec: loop.maxSpoolAgeSec };
  }

  private async quarantineSpooledFile(path: string, reason: "duplicate" | "failed" | "stale"): Promise<void> {
    if (!(await pathExists(path))) return;
    const dir = resolveConfigPath(this.config, join("data/spool/loops-quarantine", reason));
    await ensureDir(dir);
    let destination = join(dir, basename(path));
    if (await pathExists(destination)) destination = join(dir, `${Date.now()}-${basename(path)}`);
    await rename(path, destination);
  }

  private async handlePrompt(loop: LoopDefinition, route: Route, run: LoopRun): Promise<void> {
    const prompt = loop.promptFile ? await readFile(resolveConfigPath(this.config, loop.promptFile), "utf8") : loop.prompt ?? "";
    const eventText = [`Loop event: ${loop.id}`, loop.description ? `Description: ${loop.description}` : "", "", prompt].filter(Boolean).join("\n");
    run.outputPath = await this.writeRunOutput(run.id, eventText);
    if (route === "return_to_main") await this.callbacks.enqueueMain(eventText, { source: "loop", loopId: loop.id, runId: run.id });
    if (route === "send_to_admins" && !(loop.suppressEmptyOutput && prompt.trim() === "")) await this.callbacks.sendAdmins(eventText);
    if (route === "dispatch_subagent") await this.callbacks.dispatchSubagent({ profile: loop.profile ?? "researcher", prompt: eventText, route: "return_to_main", timeoutSec: loop.timeoutSec, model: loop.model, effort: loop.effort, serviceTier: loop.serviceTier, ownerId: loop.id, ownerRequestId: run.id });
  }

  private async handleCommand(loop: LoopDefinition, route: Route, run: LoopRun): Promise<void> {
    if (!loop.command) throw new Error(`Loop ${loop.id} is missing command`);
    const output = await runCommandCapture(this.config, loop.command, loop.args ?? [], loop.cwd ? resolveConfigPath(this.config, loop.cwd) : this.config.service.workspace, loop.env, {
      onChild: (child) => {
        this.activeCommandChildren.add(child);
        child.once("exit", () => this.activeCommandChildren.delete(child));
      }
    });
    run.outputPath = await this.writeRunOutput(run.id, output);
    const eventText = [`Loop command completed: ${loop.id}`, `Command: ${loop.command} ${(loop.args ?? []).join(" ")}`, "", output].join("\n");
    if (route === "return_to_main") await this.callbacks.enqueueMain(eventText, { source: "loop", loopId: loop.id, runId: run.id });
    if (route === "send_to_admins" && !(loop.suppressEmptyOutput && output.trim() === "")) await this.callbacks.sendAdmins(eventText);
    if (route === "dispatch_subagent") await this.callbacks.dispatchSubagent({ profile: loop.profile ?? "debugger", prompt: eventText, route: "return_to_main", timeoutSec: loop.timeoutSec, model: loop.model, effort: loop.effort, serviceTier: loop.serviceTier, ownerId: loop.id, ownerRequestId: run.id });
  }

  private async handleDispatch(loop: LoopDefinition, route: Route, run: LoopRun): Promise<void> {
    const prompt = loop.promptFile ? await readFile(resolveConfigPath(this.config, loop.promptFile), "utf8") : loop.prompt ?? "";
    await this.callbacks.dispatchSubagent({ profile: loop.profile ?? "researcher", prompt, route, timeoutSec: loop.timeoutSec, model: loop.model, effort: loop.effort, serviceTier: loop.serviceTier, ownerId: loop.id, ownerRequestId: run.id });
  }

  private async writeRunOutput(runId: string, output: string): Promise<string> {
    const path = resolveConfigPath(this.config, join("data/logs/loops", `${runId}.log`));
    await atomicWriteText(path, output);
    return path;
  }

  private isShutdownInterruptedError(error: unknown): boolean {
    return this.shuttingDown && error instanceof LoopCommandError && error.code === null && error.signal === "SIGTERM";
  }
}

function removeManagedBlock(lines: string[], begin: string, end: string): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === begin) {
      skipping = true;
      continue;
    }
    if (line.trim() === end) {
      skipping = false;
      continue;
    }
    if (!skipping && line.trim() !== "") out.push(line);
  }
  return out;
}

export function buildManagedCronText(existing: string, namespace: string, generated: string[]): string {
  const begin = `# BEGIN ${namespace} managed loops`;
  const end = `# END ${namespace} managed loops`;
  const outside = removeManagedBlock(existing.split(/\r?\n/), begin, end);
  if (generated.length === 0) return outside.length === 0 ? "" : `${outside.join("\n")}\n`;
  return [...outside, begin, ...generated, end, ""].join("\n");
}

export function generateCronLines(config: AppConfig, loops: LoopsConfig): string[] {
  const binary = process.argv[1] && process.argv[1].endsWith("main.js") ? `${process.execPath} ${process.argv[1]}` : config.loops.runnerCommand.replace(/\s+loop run$/, "");
  return loops.loops
    .filter((loop) => loop.enabled)
    .map((loop) => {
      const logPath = resolveConfigPath(config, join("data/logs/cron", `${loop.id}.log`));
      const lock = loop.lock ?? loops.defaults.lock;
      const runner = `${binary} --config ${config.configPath} loop run ${loop.id}`;
      const command = lock ? `flock -n ${resolveConfigPath(config, join("data/locks", `loop-${loop.id}.lock`))} ${runner}` : runner;
      return `${loop.schedule} CODEX_CHAT_CONFIG=${config.configPath} ${command} >> ${logPath} 2>&1`;
    });
}

class LoopCommandError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null
  ) {
    super(message);
    this.name = "LoopCommandError";
  }
}

function runCommandCapture(config: AppConfig, command: string, args: string[] = [], cwd?: string, env?: Record<string, string>, options: { onChild?: (child: ChildProcess) => void } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: sanitizeChildProcessEnv(config, process.env, env), stdio: ["ignore", "pipe", "pipe"] });
    options.onChild?.(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new LoopCommandError(stderr || stdout || `${command} exited with ${code}${signal ? ` signal ${signal}` : ""}`, code, signal));
    });
  });
}
