import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { StateStore } from "./state.js";
import { MonitorEvent, Route } from "./types.js";
import { atomicWriteText, ensureDir, killProcessTree, makeId, nowIso, pathExists } from "./util.js";

const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

const patternSchema = z.object({
  id: z.string().min(1),
  stream: z.enum(["stdout", "stderr", "both"]).default("both"),
  regex: z.string().min(1),
  flags: z.string().optional(),
  debounceSec: z.number().int().nonnegative().default(30),
  cooldownSec: z.number().int().nonnegative().optional(),
  includeRingBufferLines: z.number().int().nonnegative().optional(),
  preAction: z.object({
    type: z.literal("run_command"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    timeoutSec: z.number().int().positive().default(10)
  }).optional(),
  action: z.object({
    type: z.enum(["send_to_main", "dispatch_subagent", "restart_monitor"]).default("send_to_main"),
    promptFile: z.string().optional(),
    includeRingBufferLines: z.number().int().nonnegative().optional(),
    profile: z.string().optional(),
    timeoutSec: z.number().int().positive().optional(),
    model: z.string().optional(),
    effort: effortSchema.optional()
  }).default({ type: "send_to_main" })
});

const monitorSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  type: z.enum(["managed_process", "log_file", "journal"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  path: z.string().optional(),
  unit: z.string().optional(),
  restart: z.object({
    policy: z.enum(["never", "on_failure", "always"]).default("on_failure"),
    maxRestarts: z.number().int().nonnegative().default(20),
    backoffSec: z.number().int().nonnegative().default(5),
    maxBackoffSec: z.number().int().positive().default(120)
  }).default({ policy: "on_failure", maxRestarts: 20, backoffSec: 5, maxBackoffSec: 120 }),
  output: z.object({
    lineBuffer: z.number().int().positive().default(500),
    storeRaw: z.boolean().default(true)
  }).default({ lineBuffer: 500, storeRaw: true }),
  patterns: z.array(patternSchema).default([])
});

const monitorsConfigSchema = z.object({
  version: z.literal(1),
  monitors: z.array(monitorSchema).default([])
});

export type MonitorDefinition = z.infer<typeof monitorSchema>;
export type PatternDefinition = z.infer<typeof patternSchema>;
export type MonitorsConfig = z.infer<typeof monitorsConfigSchema>;

interface MonitorCallbacks {
  enqueueMain(text: string, metadata?: Record<string, unknown>): Promise<void>;
  dispatchSubagent(input: { profile: string; prompt: string; route: Route; timeoutSec?: number; model?: string; effort?: string; ownerId?: string; ownerRequestId?: string }): Promise<void>;
  notifyAdmins(text: string): Promise<void>;
}

interface RunningMonitor {
  definition: MonitorDefinition;
  child?: ChildProcess;
  ring: string[];
  lastTrigger: Map<string, number>;
  restartCount: number;
  /** Pending restart timer so we can cancel it on stop()/restart(). */
  restartTimer?: ReturnType<typeof setTimeout>;
  /** True once stop() ran — suppresses any in-flight restart timeouts. */
  stopped?: boolean;
}

export async function loadMonitorsConfig(config: AppConfig): Promise<MonitorsConfig> {
  const parsed = JSON.parse(await readFile(resolveConfigPath(config, config.monitors.path), "utf8"));
  return monitorsConfigSchema.parse(parsed);
}

export async function validateMonitors(config: AppConfig): Promise<MonitorsConfig> {
  return loadMonitorsConfig(config);
}

export class MonitorManager {
  private monitors = new Map<string, RunningMonitor>();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly callbacks: MonitorCallbacks
  ) {}

  async start(): Promise<void> {
    if (!this.config.monitors.enabled) return;
    await ensureDir(resolveConfigPath(this.config, "data/logs/monitors"));
    const config = await loadMonitorsConfig(this.config);
    for (const monitor of config.monitors.filter((item) => item.enabled)) {
      await this.startMonitor(monitor);
    }
  }

  async stop(): Promise<void> {
    for (const running of this.monitors.values()) {
      running.stopped = true;
      if (running.restartTimer) {
        clearTimeout(running.restartTimer);
        running.restartTimer = undefined;
      }
      if (running.child) killProcessTree(running.child, "SIGTERM");
    }
    this.monitors.clear();
  }

  private async startMonitor(definition: MonitorDefinition): Promise<void> {
    const running: RunningMonitor = { definition, ring: [], lastTrigger: new Map(), restartCount: 0 };
    this.monitors.set(definition.id, running);
    if (definition.type === "managed_process") await this.startManagedProcess(running);
    if (definition.type === "log_file") await this.startLogTail(running);
    if (definition.type === "journal") await this.startJournalTail(running);
  }

  private async startManagedProcess(running: RunningMonitor): Promise<void> {
    const def = running.definition;
    if (!def.command) throw new Error(`Managed monitor ${def.id} is missing command`);
    const pidFile = resolveConfigPath(this.config, join("data/run/monitors", `${def.id}.pid`));
    await ensureDir(resolveConfigPath(this.config, "data/run/monitors"));
    if (await pathExists(pidFile)) {
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      if (Number.isInteger(pid) && this.isProcessAlive(pid)) {
        this.logger.info({ component: "monitors", event: "attach_existing", monitorId: def.id, pid }, "monitor process already running; attaching via log if configured");
        if (def.path) await this.startLogTail(running);
        return;
      }
    }
    const child = spawn(def.command, def.args ?? [], {
      cwd: def.cwd ? resolveConfigPath(this.config, def.cwd) : this.config.service.workspace,
      env: { ...process.env, ...def.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    running.child = child;
    await atomicWriteText(pidFile, String(child.pid ?? ""));
    child.stdout?.on("data", (chunk) => this.handleChunk(running, "stdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => this.handleChunk(running, "stderr", chunk.toString()));
    child.on("exit", (code, signal) => {
      this.logger.warn({ component: "monitors", event: "exit", monitorId: def.id, code, signal }, "monitor process exited");
      void this.maybeRestart(running, code);
    });
  }

  private async startLogTail(running: RunningMonitor): Promise<void> {
    const path = running.definition.path;
    if (!path) throw new Error(`Log monitor ${running.definition.id} is missing path`);
    const child = spawn("tail", ["-F", resolveConfigPath(this.config, path)], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    running.child = child;
    child.stdout?.on("data", (chunk) => this.handleChunk(running, "stdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => this.handleChunk(running, "stderr", chunk.toString()));
  }

  private async startJournalTail(running: RunningMonitor): Promise<void> {
    const unit = running.definition.unit;
    if (!unit) throw new Error(`Journal monitor ${running.definition.id} is missing unit`);
    const child = spawn("journalctl", ["-fu", unit], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    running.child = child;
    child.stdout?.on("data", (chunk) => this.handleChunk(running, "stdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => this.handleChunk(running, "stderr", chunk.toString()));
  }

  private handleChunk(running: RunningMonitor, stream: "stdout" | "stderr", data: string): void {
    for (const line of data.split(/\r?\n/)) {
      if (!line) continue;
      running.ring.push(`[${stream}] ${line}`);
      while (running.ring.length > running.definition.output.lineBuffer) running.ring.shift();
      if (running.definition.output.storeRaw) {
        const rawPath = resolveConfigPath(this.config, join("data/logs/monitors", `${running.definition.id}.log`));
        ensureDir(dirname(rawPath))
          .then(() => appendFile(rawPath, `${line}\n`))
          .catch((error) => this.logger.error({ component: "monitors", monitorId: running.definition.id, error }));
      }
      for (const pattern of running.definition.patterns) {
        if (pattern.stream !== "both" && pattern.stream !== stream) continue;
        void this.matchPattern(running, pattern, stream, line);
      }
    }
  }

  private async matchPattern(running: RunningMonitor, pattern: PatternDefinition, stream: "stdout" | "stderr", line: string): Promise<void> {
    const regex = new RegExp(pattern.regex, pattern.flags);
    const match = regex.exec(line);
    if (!match) return;
    const key = pattern.id;
    const now = Date.now();
    const last = running.lastTrigger.get(key) ?? 0;
    if (now - last < pattern.debounceSec * 1000) return;
    running.lastTrigger.set(key, now);
    const contextCount = pattern.action.includeRingBufferLines ?? pattern.includeRingBufferLines ?? 50;
    const context = running.ring.slice(-contextCount).join("\n");
    const contextPath = resolveConfigPath(this.config, join("data/logs/monitors", `${running.definition.id}-${pattern.id}-${Date.now()}.log`));
    await atomicWriteText(contextPath, context);
    let preActionOutput = "";
    if (pattern.preAction) preActionOutput = await this.runPreAction(pattern.preAction).catch((error) => `preAction failed: ${error instanceof Error ? error.message : String(error)}`);
    const event: MonitorEvent = {
      id: makeId("monitor"),
      monitorId: running.definition.id,
      patternId: pattern.id,
      line,
      stream,
      captures: match.slice(1),
      contextPath,
      createdAt: nowIso()
    };
    await this.state.recordMonitorEvent(event);
    const promptPrefix = pattern.action.promptFile ? await readFile(resolveConfigPath(this.config, pattern.action.promptFile), "utf8") : "Monitor alert received.";
    const prompt = [
      promptPrefix,
      "",
      `Monitor: ${running.definition.id}`,
      `Pattern: ${pattern.id}`,
      `Stream: ${stream}`,
      `Line: ${line}`,
      `Context path: ${contextPath}`,
      preActionOutput ? `Pre-action output:\n${preActionOutput}` : ""
    ].filter(Boolean).join("\n");
    if (pattern.action.type === "send_to_main") await this.callbacks.enqueueMain(prompt, { source: "monitor", monitorId: running.definition.id, patternId: pattern.id, contextPath });
    if (pattern.action.type === "dispatch_subagent") await this.callbacks.dispatchSubagent({ profile: pattern.action.profile ?? "debugger", prompt, route: "return_to_main", timeoutSec: pattern.action.timeoutSec, model: pattern.action.model, effort: pattern.action.effort, ownerId: running.definition.id, ownerRequestId: event.id });
    if (pattern.action.type === "restart_monitor") await this.restartMonitor(running);
  }

  private async runPreAction(preAction: NonNullable<PatternDefinition["preAction"]>): Promise<string> {
    if (!this.config.security.allowShellActionsFromDirectives) {
      this.logger.warn({ component: "monitors", event: "pre_action_running_from_trusted_config", command: preAction.command }, "running monitor preAction from trusted config");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(preAction.command, preAction.args, { cwd: this.config.service.workspace, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("preAction timed out"));
      }, preAction.timeoutSec * 1000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error(output || `preAction exited with ${code}`));
      });
    });
  }

  private async maybeRestart(running: RunningMonitor, code: number | null): Promise<void> {
    if (running.stopped) return;
    const policy = running.definition.restart.policy;
    const shouldRestart = policy === "always" || (policy === "on_failure" && code !== 0);
    if (!shouldRestart) return;
    if (running.restartCount >= running.definition.restart.maxRestarts) {
      await this.callbacks.notifyAdmins(`Monitor ${running.definition.id} reached maxRestarts and is stopped.`);
      return;
    }
    running.restartCount += 1;
    const backoff = Math.min(running.definition.restart.backoffSec * running.restartCount, running.definition.restart.maxBackoffSec, this.config.monitors.maxRestartBackoffSec);
    if (running.restartTimer) clearTimeout(running.restartTimer);
    running.restartTimer = setTimeout(() => {
      running.restartTimer = undefined;
      if (running.stopped) return;
      void this.restartMonitor(running);
    }, backoff * 1000);
  }

  private async restartMonitor(running: RunningMonitor): Promise<void> {
    if (running.stopped) return;
    if (running.restartTimer) {
      clearTimeout(running.restartTimer);
      running.restartTimer = undefined;
    }
    if (running.child) killProcessTree(running.child, "SIGTERM");
    await this.startManagedProcess(running);
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
