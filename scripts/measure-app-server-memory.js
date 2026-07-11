#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "data", "reports", "app-server-memory");
const RUN_ID = `app-server-memory-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
const PAGE_SIZE = getPageSize();
const MAX_LOG_LINES = 200;

const USAGE = `Usage: node scripts/measure-app-server-memory.js [options]

Starts isolated \`codex app-server\` processes on random localhost ports, samples
memory for each process tree, writes JSON plus a concise summary under
\`data/reports/app-server-memory/\`, then cleans up the test process groups.

Options:
  --parallel <n>             Number of isolated app-server processes (default: 1)
  --duration-sec <n>         Sampling duration in seconds after startup (default: 30)
  --duration-ms <n>          Sampling duration in milliseconds (overrides --duration-sec)
  --samples <n>              Number of samples to collect, including first/last (default: 10)
  --turn-type <type>         Workload: idle, simple, or sleep (default: idle)
  --sleep-sec <n>            Requested shell sleep length for --turn-type sleep (default: duration)
  --binary <path>            Codex binary to execute (default: codex)
  --model <name>             Model for simple/sleep turns (default: gpt-5.6-luna)
  --effort <level>           Reasoning effort for simple/sleep turns (default: xhigh)
  --cwd <path>               Thread cwd and child cwd (default: repository root)
  --startup-timeout-sec <n>  App-server WebSocket startup timeout (default: 30)
  --turn-timeout-sec <n>     Turn wait timeout for simple/sleep workloads (default: min 300, duration+120)
  --codex-config <key=value> Extra codex -c override; repeatable
  --out-dir <path>           Output directory (default: data/reports/app-server-memory)
  --cleanup / --no-cleanup   Kill test process groups on exit/error/SIGINT (default: --cleanup)
  --cleanup-only <report>    Cleanup pids/ports/run marker from a previous JSON report and exit
  --json                     Print the report JSON path only on success
  -h, --help                 Show this help

Examples:
  node scripts/measure-app-server-memory.js --parallel 1 --duration-sec 15 --samples 5 --turn-type idle
  node scripts/measure-app-server-memory.js --parallel 2 --duration-sec 90 --samples 12 --turn-type simple
  node scripts/measure-app-server-memory.js --cleanup-only data/reports/app-server-memory/<run>.json

Notes:
  - PSS is read from /proc/<pid>/smaps_rollup when available; RSS falls back
    to /proc status/statm when PSS is unavailable.
  - The script is standalone and does not start or modify the codex-chat service.
  - OPENAI_API_KEY is omitted from spawned app-server environments to match the
    app-server transport used by codex-chat.
`;

class UsageError extends Error {}

class JsonRpcClient {
  constructor(ws, instance) {
    this.ws = ws;
    this.instance = instance;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("close", () => this.rejectAll(new Error("websocket closed")));
    ws.on("error", (error) => this.rejectAll(error));
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const message = { id, method, params };
    this.ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  waitForNotification(predicate, timeoutMs) {
    for (const item of this.notifications) {
      if (predicate(item)) return Promise.resolve(item);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for app-server notification"));
      }, timeoutMs);
      const onNotification = (message) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.instance.notificationHandlers.delete(onNotification);
      };
      this.instance.notificationHandlers.add(onNotification);
    });
  }

  close() {
    this.rejectAll(new Error("JSON-RPC client closed"));
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    this.notifications.push(message);
    if (this.notifications.length > 500) this.notifications.splice(0, this.notifications.length - 500);
    for (const handler of this.instance.notificationHandlers) handler(message);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function parseArgs(argv) {
  const opts = {
    parallel: 1,
    durationMs: 30_000,
    samples: 10,
    turnType: "idle",
    sleepSec: undefined,
    binary: "codex",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    cwd: REPO_ROOT,
    startupTimeoutMs: 30_000,
    turnTimeoutMs: undefined,
    codexConfig: [],
    outDir: DEFAULT_OUT_DIR,
    cleanup: true,
    cleanupOnly: "",
    json: false
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const [flag, inlineValue] = raw.includes("=") ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= args.length) throw new UsageError(`Missing value for ${flag}`);
      return args[i];
    };

    switch (flag) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--parallel":
        opts.parallel = parsePositiveInt(value(), flag);
        break;
      case "--duration-sec":
        opts.durationMs = Math.max(0, Math.round(parseNonNegativeNumber(value(), flag) * 1000));
        break;
      case "--duration-ms":
        opts.durationMs = parseNonNegativeInt(value(), flag);
        break;
      case "--samples":
        opts.samples = parsePositiveInt(value(), flag);
        break;
      case "--turn-type":
        opts.turnType = value();
        break;
      case "--sleep-sec":
        opts.sleepSec = parseNonNegativeNumber(value(), flag);
        break;
      case "--binary":
        opts.binary = value();
        break;
      case "--model":
        opts.model = value();
        break;
      case "--effort":
        opts.effort = value();
        break;
      case "--cwd":
        opts.cwd = resolve(value());
        break;
      case "--startup-timeout-sec":
        opts.startupTimeoutMs = Math.round(parsePositiveNumber(value(), flag) * 1000);
        break;
      case "--turn-timeout-sec":
        opts.turnTimeoutMs = Math.round(parsePositiveNumber(value(), flag) * 1000);
        break;
      case "--codex-config":
        opts.codexConfig.push(value());
        break;
      case "--out-dir":
        opts.outDir = resolve(value());
        break;
      case "--cleanup":
        opts.cleanup = true;
        break;
      case "--no-cleanup":
        opts.cleanup = false;
        break;
      case "--cleanup-only":
        opts.cleanupOnly = resolve(value());
        break;
      case "--json":
        opts.json = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${raw}`);
    }
  }

  if (!["idle", "simple", "sleep"].includes(opts.turnType)) {
    throw new UsageError(`--turn-type must be one of: idle, simple, sleep`);
  }
  if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(opts.effort)) {
    throw new UsageError(`--effort must be one of: none, minimal, low, medium, high, xhigh`);
  }
  if (opts.samples < 1) throw new UsageError("--samples must be at least 1");
  if (opts.parallel > 64) throw new UsageError("--parallel is capped at 64 for safety");
  opts.turnTimeoutMs ??= Math.max(300_000, opts.durationMs + 120_000);
  return opts;
}

function parsePositiveInt(text, flag) {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return n;
}

function parseNonNegativeInt(text, flag) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a non-negative integer`);
  return n;
}

function parsePositiveNumber(text, flag) {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number`);
  return n;
}

function parseNonNegativeNumber(text, flag) {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number`);
  return n;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.cleanupOnly) {
    const cleanupReport = await cleanupOnly(opts.cleanupOnly);
    process.stdout.write(`${cleanupReport.summary}\n`);
    if (!cleanupReport.passed) process.exitCode = 1;
    return;
  }

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  await mkdir(opts.outDir, { recursive: true });
  const jsonPath = join(opts.outDir, `${stamp}-${RUN_ID}.json`);
  const summaryPath = join(opts.outDir, `${stamp}-${RUN_ID}.summary.txt`);
  const report = {
    schemaVersion: 1,
    runId: RUN_ID,
    startedAt,
    completedAt: null,
    repoRoot: REPO_ROOT,
    command: [process.execPath, ...process.argv.slice(1)],
    options: publicOptions(opts),
    instances: [],
    samples: [],
    summary: null,
    cleanup: null,
    error: null,
    output: { jsonPath, summaryPath }
  };
  const instances = [];
  let shuttingDown = false;

  const shutdown = async (reason, exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;
    report.error ??= reason === "completed" ? null : { message: reason };
    report.cleanup = await cleanupInstances(instances, opts, report, reason);
    report.completedAt = new Date().toISOString();
    report.summary = buildSummary(report);
    await writeReports(report, jsonPath, summaryPath);
    if (!opts.json) process.stderr.write(`\nInterrupted: ${reason}\n${formatSummary(report)}\n`);
    process.exit(exitCode);
  };

  process.once("SIGINT", () => void shutdown("SIGINT", 130));
  process.once("SIGTERM", () => void shutdown("SIGTERM", 143));
  process.once("uncaughtException", (error) => {
    report.error = serializeError(error);
    void shutdown(`uncaughtException: ${error?.message ?? String(error)}`, 1);
  });
  process.once("unhandledRejection", (error) => {
    report.error = serializeError(error);
    void shutdown(`unhandledRejection: ${error instanceof Error ? error.message : String(error)}`, 1);
  });

  try {
    for (let i = 0; i < opts.parallel; i++) {
      const instance = await startInstance(i, opts, report.runId);
      instances.push(instance);
      report.instances.push(publicInstance(instance));
    }

    await sampleIntoReport(report, instances, 0);
    const turnPromises = instances.map((instance) => startWorkload(instance, opts));
    await collectSamples(report, instances, opts);
    await Promise.allSettled(turnPromises);
    refreshReportInstances(report, instances);
  } catch (error) {
    report.error = serializeError(error);
    throw error;
  } finally {
    if (!shuttingDown) {
      report.cleanup = await cleanupInstances(instances, opts, report, report.error ? "error" : "completed");
      report.completedAt = new Date().toISOString();
      report.summary = buildSummary(report);
      await writeReports(report, jsonPath, summaryPath);
    }
  }

  if (opts.json) {
    process.stdout.write(`${jsonPath}\n`);
  } else {
    process.stdout.write(`${formatSummary(report)}\n`);
  }
  if (report.cleanup && !report.cleanup.orphanCheck.passed) process.exitCode = 1;
}

async function startInstance(index, opts, runId) {
  const port = await findFreePort();
  const listenUrl = `ws://127.0.0.1:${port}`;
  const args = ["app-server", "--listen", listenUrl];
  for (const item of opts.codexConfig) args.push("-c", item);
  const { OPENAI_API_KEY: _openAiApiKey, ...safeEnv } = process.env;
  const env = {
    ...safeEnv,
    CODEX_CHAT_MEMORY_PROBE_RUN_ID: runId,
    CODEX_CHAT_MEMORY_PROBE_INDEX: String(index),
    CODEX_CHAT_MEMORY_PROBE_LISTEN_URL: listenUrl
  };
  const logs = [];
  const startedAt = new Date().toISOString();
  const child = spawn(opts.binary, args, {
    cwd: opts.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  const instance = {
    index,
    port,
    listenUrl,
    args: [opts.binary, ...args],
    pid: child.pid ?? null,
    pgid: child.pid ?? null,
    child,
    startedAt,
    exitedAt: null,
    exit: null,
    logs,
    ws: null,
    rpc: null,
    notificationHandlers: new Set(),
    initialized: false,
    threadId: null,
    turn: { type: opts.turnType, status: "not_started", threadId: null, turnId: null, startedAt: null, completedAt: null, error: null, outputChars: 0 }
  };

  child.stdout?.on("data", (chunk) => pushLog(logs, "stdout", chunk));
  child.stderr?.on("data", (chunk) => pushLog(logs, "stderr", chunk));
  child.on("exit", (code, signal) => {
    instance.exitedAt = new Date().toISOString();
    instance.exit = { code, signal };
  });
  child.on("error", (error) => pushLog(logs, "error", String(error?.message ?? error)));

  if (!child.pid) throw new Error(`failed to spawn ${opts.binary}`);
  await waitForAppServer(instance, opts.startupTimeoutMs);
  await initializeAppServer(instance, opts);
  instance.processTreeAtStart = await collectProcessTree(instance.pid);
  return instance;
}

async function waitForAppServer(instance, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (instance.exit) throw new Error(`app-server ${instance.index} exited during startup: ${JSON.stringify(instance.exit)} ${instance.logs.at(-1)?.line ?? ""}`);
    try {
      const ws = await connectWebSocket(instance.listenUrl, Math.min(2000, Math.max(250, deadline - Date.now())));
      instance.ws = ws;
      instance.rpc = new JsonRpcClient(ws, instance);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(`timed out connecting to ${instance.listenUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function connectWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out connecting to ${url}`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function initializeAppServer(instance, opts) {
  await instance.rpc.request("initialize", {
    clientInfo: { name: "codex-chat-memory-probe", title: "codex-chat app-server memory probe", version: "0.1.0" },
    capabilities: { experimentalApi: true }
  }, opts.startupTimeoutMs);
  instance.initialized = true;
}

async function startWorkload(instance, opts) {
  if (opts.turnType === "idle") {
    instance.turn.status = "idle";
    return;
  }
  instance.turn.status = "starting_thread";
  instance.turn.startedAt = new Date().toISOString();
  try {
    const threadResponse = await instance.rpc.request("thread/start", {
      model: opts.model,
      cwd: opts.cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: opts.effort },
      serviceName: "codex-chat-memory-probe",
      baseInstructions: "You are running a local codex app-server memory probe. Keep responses concise and do only the requested safe action.",
      developerInstructions: "This is a memory measurement run. Avoid extra work; produce the requested short final answer.",
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    }, opts.startupTimeoutMs);
    const threadId = typeof threadResponse?.thread?.id === "string" ? threadResponse.thread.id : "";
    if (!threadId) throw new Error("thread/start did not return thread.id");
    instance.threadId = threadId;
    instance.turn.threadId = threadId;

    const sleepSec = opts.sleepSec ?? Math.max(1, Math.ceil(opts.durationMs / 1000));
    const prompt = opts.turnType === "sleep"
      ? `Run the shell command \`sleep ${sleepSec}\` once, then reply exactly: done`
      : "Reply exactly: ok";
    instance.turn.status = "starting_turn";
    const turnResponse = await instance.rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      cwd: opts.cwd,
      approvalPolicy: "never",
      model: opts.model,
      effort: opts.effort
    }, opts.startupTimeoutMs);
    const turnId = typeof turnResponse?.turn?.id === "string" ? turnResponse.turn.id : "";
    if (!turnId) throw new Error("turn/start did not return turn.id");
    instance.turn.turnId = turnId;
    instance.turn.status = "running";
    let outputChars = 0;
    const message = await instance.rpc.waitForNotification((msg) => {
      if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return false;
      const params = msg.params && typeof msg.params === "object" ? msg.params : {};
      if (msg.method === "item/agentMessage/delta" && params.turnId === turnId && typeof params.delta === "string") {
        outputChars += params.delta.length;
        instance.turn.outputChars = outputChars;
      }
      return msg.method === "turn/completed" && params.turn && typeof params.turn === "object" && params.turn.id === turnId;
    }, opts.turnTimeoutMs);
    const turn = message.params.turn;
    instance.turn.status = typeof turn.status === "string" ? turn.status : "completed";
    instance.turn.completedAt = new Date().toISOString();
    instance.turn.outputChars = outputChars;
    if (turn.error) instance.turn.error = turn.error;
  } catch (error) {
    instance.turn.status = "failed";
    instance.turn.completedAt = new Date().toISOString();
    instance.turn.error = serializeError(error);
  }
}

async function collectSamples(report, instances, opts) {
  if (opts.samples <= 1) return;
  const interval = opts.durationMs / (opts.samples - 1);
  const start = Date.now();
  for (let i = 1; i < opts.samples; i++) {
    const target = start + Math.round(interval * i);
    const waitMs = Math.max(0, target - Date.now());
    if (waitMs > 0) await delay(waitMs);
    await sampleIntoReport(report, instances, Date.now() - start);
  }
}

async function sampleIntoReport(report, instances, elapsedMs) {
  const instanceSamples = [];
  for (const instance of instances) {
    const processTree = instance.pid ? await collectProcessTree(instance.pid) : [];
    const processes = [];
    let pssBytes = 0;
    let rssBytes = 0;
    let pssCount = 0;
    let rssCount = 0;
    for (const proc of processTree) {
      const memory = await readProcessMemory(proc.pid);
      processes.push({ ...proc, memory });
      if (Number.isFinite(memory.pssBytes)) {
        pssBytes += memory.pssBytes;
        pssCount += 1;
      }
      if (Number.isFinite(memory.rssBytes)) {
        rssBytes += memory.rssBytes;
        rssCount += 1;
      }
    }
    instanceSamples.push({
      index: instance.index,
      pid: instance.pid,
      pgid: instance.pgid,
      port: instance.port,
      listenUrl: instance.listenUrl,
      alive: isProcessAlive(instance.pid),
      processCount: processTree.length,
      memory: {
        pssBytes: pssCount > 0 ? pssBytes : null,
        rssBytes: rssCount > 0 ? rssBytes : null,
        pssProcessCount: pssCount,
        rssProcessCount: rssCount
      },
      processes
    });
  }
  const totalPss = instanceSamples.reduce((sum, sample) => sum + (sample.memory.pssBytes ?? 0), 0);
  const totalRss = instanceSamples.reduce((sum, sample) => sum + (sample.memory.rssBytes ?? 0), 0);
  report.samples.push({
    at: new Date().toISOString(),
    elapsedMs,
    totals: {
      pssBytes: instanceSamples.some((sample) => sample.memory.pssBytes !== null) ? totalPss : null,
      rssBytes: instanceSamples.some((sample) => sample.memory.rssBytes !== null) ? totalRss : null,
      processCount: instanceSamples.reduce((sum, sample) => sum + sample.processCount, 0)
    },
    instances: instanceSamples
  });
}

async function cleanupInstances(instances, opts, report, reason) {
  refreshReportInstances(report, instances);
  const cleanup = {
    enabled: opts.cleanup,
    reason,
    startedAt: new Date().toISOString(),
    processGroups: instances.map((instance) => ({ index: instance.index, pid: instance.pid, pgid: instance.pgid, signals: [] })),
    orphanCheck: { passed: true, remaining: [] },
    completedAt: null
  };
  for (const instance of instances) {
    instance.rpc?.close();
  }
  if (opts.cleanup) {
    for (const group of cleanup.processGroups) {
      if (!group.pgid || !isProcessAlive(group.pid)) continue;
      group.signals.push("SIGTERM");
      killProcessGroup(group.pgid, "SIGTERM");
    }
    await waitForExit(instances, 3000);
    for (const group of cleanup.processGroups) {
      if (!group.pgid || !isProcessAlive(group.pid)) continue;
      group.signals.push("SIGKILL");
      killProcessGroup(group.pgid, "SIGKILL");
    }
    await waitForExit(instances, 2000);
  }
  refreshReportInstances(report, instances);
  const remaining = await findProbeProcesses(report.runId, instances);
  cleanup.orphanCheck = { passed: remaining.length === 0, remaining };
  cleanup.completedAt = new Date().toISOString();
  return cleanup;
}

async function cleanupOnly(reportPath) {
  const text = await readFile(reportPath, "utf8");
  const report = JSON.parse(text);
  const instances = (report.instances ?? []).map((item, index) => ({
    index: item.index ?? index,
    pid: item.pid ?? null,
    pgid: item.pgid ?? item.pid ?? null,
    port: item.port ?? null,
    listenUrl: item.listenUrl ?? null,
    child: null,
    rpc: null,
    exit: null
  }));
  for (const instance of instances) {
    if (instance.pgid) killProcessGroup(instance.pgid, "SIGTERM");
  }
  await delay(2000);
  for (const instance of instances) {
    if (instance.pgid && isProcessAlive(instance.pid)) killProcessGroup(instance.pgid, "SIGKILL");
  }
  await delay(1000);
  const remaining = await findProbeProcesses(report.runId, instances);
  return {
    passed: remaining.length === 0,
    remaining,
    summary: remaining.length === 0
      ? `cleanup-only passed for ${reportPath}; no matching test processes remain.`
      : `cleanup-only found ${remaining.length} remaining matching process(es): ${remaining.map((p) => p.pid).join(", ")}`
  };
}

function refreshReportInstances(report, instances) {
  report.instances = instances.map(publicInstance);
}

function publicInstance(instance) {
  return {
    index: instance.index,
    pid: instance.pid,
    pgid: instance.pgid,
    port: instance.port,
    listenUrl: instance.listenUrl,
    args: instance.args,
    startedAt: instance.startedAt,
    exitedAt: instance.exitedAt,
    exit: instance.exit,
    initialized: instance.initialized,
    threadId: instance.threadId,
    turn: instance.turn,
    processTreeAtStart: instance.processTreeAtStart ?? [],
    logsTail: instance.logs.slice(-MAX_LOG_LINES)
  };
}

function publicOptions(opts) {
  return {
    parallel: opts.parallel,
    durationMs: opts.durationMs,
    samples: opts.samples,
    turnType: opts.turnType,
    sleepSec: opts.sleepSec ?? null,
    binary: opts.binary,
    model: opts.model,
    effort: opts.effort,
    cwd: opts.cwd,
    startupTimeoutMs: opts.startupTimeoutMs,
    turnTimeoutMs: opts.turnTimeoutMs,
    codexConfig: opts.codexConfig,
    outDir: opts.outDir,
    cleanup: opts.cleanup
  };
}

function buildSummary(report) {
  const peakPssBytes = maxDefined(report.samples.map((sample) => sample.totals.pssBytes));
  const peakRssBytes = maxDefined(report.samples.map((sample) => sample.totals.rssBytes));
  const finalSample = report.samples.at(-1) ?? null;
  const perInstance = report.instances.map((instance) => {
    const samples = report.samples.map((sample) => sample.instances.find((item) => item.index === instance.index)).filter(Boolean);
    return {
      index: instance.index,
      pid: instance.pid,
      port: instance.port,
      peakPssBytes: maxDefined(samples.map((sample) => sample.memory.pssBytes)),
      peakRssBytes: maxDefined(samples.map((sample) => sample.memory.rssBytes)),
      finalPssBytes: samples.at(-1)?.memory.pssBytes ?? null,
      finalRssBytes: samples.at(-1)?.memory.rssBytes ?? null,
      turnStatus: instance.turn?.status ?? null,
      exit: instance.exit
    };
  });
  return {
    peakPssBytes,
    peakRssBytes,
    finalPssBytes: finalSample?.totals.pssBytes ?? null,
    finalRssBytes: finalSample?.totals.rssBytes ?? null,
    sampleCount: report.samples.length,
    perInstance,
    cleanupPassed: report.cleanup?.orphanCheck?.passed ?? null
  };
}

function formatSummary(report) {
  const summary = report.summary ?? buildSummary(report);
  const lines = [
    "codex app-server memory probe complete",
    `runId: ${report.runId}`,
    `parallel: ${report.options.parallel}; turnType: ${report.options.turnType}; samples: ${summary.sampleCount}; durationMs: ${report.options.durationMs}`,
    `peak total PSS: ${formatBytes(summary.peakPssBytes)}; peak total RSS: ${formatBytes(summary.peakRssBytes)}`,
    `final total PSS: ${formatBytes(summary.finalPssBytes)}; final total RSS: ${formatBytes(summary.finalRssBytes)}`,
    "per instance peaks:"
  ];
  for (const item of summary.perInstance) {
    lines.push(`  #${item.index} pid=${item.pid ?? "?"} port=${item.port ?? "?"} peakPSS=${formatBytes(item.peakPssBytes)} peakRSS=${formatBytes(item.peakRssBytes)} turn=${item.turnStatus ?? "n/a"}`);
  }
  lines.push(`JSON report: ${report.output.jsonPath}`);
  lines.push(`summary: ${report.output.summaryPath}`);
  const cleanup = report.cleanup;
  if (cleanup) {
    lines.push(`cleanup: ${cleanup.enabled ? "enabled" : "disabled"}; orphan check ${cleanup.orphanCheck.passed ? "passed" : "FAILED"}`);
    if (!cleanup.orphanCheck.passed) lines.push(`remaining pids: ${cleanup.orphanCheck.remaining.map((p) => p.pid).join(", ")}`);
  }
  if (report.error) lines.push(`error: ${report.error.message ?? JSON.stringify(report.error)}`);
  return lines.join("\n");
}

async function writeReports(report, jsonPath, summaryPath) {
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(summaryPath, `${formatSummary(report)}\n`, { mode: 0o600 });
}

async function findFreePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("could not allocate a free local port");
  return port;
}

async function collectProcessTree(rootPid) {
  if (!rootPid || !isProcessAlive(rootPid)) return [];
  const all = await readProcTable();
  const childrenByPpid = new Map();
  for (const proc of all.values()) {
    const list = childrenByPpid.get(proc.ppid) ?? [];
    list.push(proc);
    childrenByPpid.set(proc.ppid, list);
  }
  const out = [];
  const seen = new Set();
  const visit = (pid) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const proc = all.get(pid);
    if (proc) out.push(proc);
    for (const child of childrenByPpid.get(pid) ?? []) visit(child.pid);
  };
  visit(rootPid);
  return out.sort((a, b) => a.pid - b.pid);
}

async function readProcTable() {
  const table = new Map();
  let entries;
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return table;
  }
  await Promise.all(entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).map(async (entry) => {
    const pid = Number(entry.name);
    const stat = await readProcStat(pid);
    if (!stat) return;
    const cmdline = await readProcCmdline(pid);
    table.set(pid, { pid, ...stat, cmdline });
  }));
  return table;
}

async function readProcStat(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    return {
      comm,
      state: rest[0],
      ppid: Number(rest[1]),
      pgid: Number(rest[2])
    };
  } catch {
    return null;
  }
}

async function readProcCmdline(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.toString("utf8").split("\0").filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

async function readProcessMemory(pid) {
  const rollup = await readSmapsRollup(pid);
  if (rollup) return rollup;
  const status = await readStatusRss(pid);
  if (status) return status;
  const statm = await readStatmRss(pid);
  if (statm) return statm;
  return { pssBytes: null, rssBytes: null, source: "unavailable" };
}

async function readSmapsRollup(pid) {
  try {
    const text = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const pssKb = matchKb(text, /^Pss:\s+(\d+)\s+kB/m);
    const rssKb = matchKb(text, /^Rss:\s+(\d+)\s+kB/m);
    return {
      pssBytes: pssKb === null ? null : pssKb * 1024,
      rssBytes: rssKb === null ? null : rssKb * 1024,
      source: "smaps_rollup"
    };
  } catch {
    return null;
  }
}

async function readStatusRss(pid) {
  try {
    const text = await readFile(`/proc/${pid}/status`, "utf8");
    const rssKb = matchKb(text, /^VmRSS:\s+(\d+)\s+kB/m);
    if (rssKb === null) return null;
    return { pssBytes: null, rssBytes: rssKb * 1024, source: "status" };
  } catch {
    return null;
  }
}

async function readStatmRss(pid) {
  try {
    const text = await readFile(`/proc/${pid}/statm`, "utf8");
    const parts = text.trim().split(/\s+/);
    const residentPages = Number(parts[1]);
    if (!Number.isFinite(residentPages)) return null;
    return { pssBytes: null, rssBytes: residentPages * PAGE_SIZE, source: "statm" };
  } catch {
    return null;
  }
}

function matchKb(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

async function findProbeProcesses(runId, instances) {
  const listenUrls = new Set(instances.map((instance) => instance.listenUrl).filter(Boolean));
  const knownPids = new Set(instances.flatMap((instance) => [instance.pid, instance.pgid]).filter(Boolean));
  const table = await readProcTable();
  const matches = [];
  await Promise.all([...table.values()].map(async (proc) => {
    const hasListenUrl = [...listenUrls].some((url) => proc.cmdline.includes(url));
    const hasRunMarker = runId ? await procEnvironHas(proc.pid, `CODEX_CHAT_MEMORY_PROBE_RUN_ID=${runId}`) : false;
    const hasKnownPid = knownPids.has(proc.pid) && (proc.cmdline.includes("codex") || hasListenUrl || hasRunMarker);
    const matched = hasKnownPid || hasListenUrl || hasRunMarker;
    if (!matched) return;
    matches.push({ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, comm: proc.comm, cmdline: proc.cmdline });
  }));
  return matches.sort((a, b) => a.pid - b.pid);
}

async function procEnvironHas(pid, needle) {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    return raw.includes(needle);
  } catch {
    return false;
  }
}

function pushLog(logs, stream, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    logs.push({ at: new Date().toISOString(), stream, line: scrub(line).slice(0, 2000) });
  }
  if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
}

function scrub(text) {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…REDACTED")
    .replace(/(api[_-]?key[=:]\s*)[^\s,;]+/gi, "$1…REDACTED")
    .replace(/(token[=:]\s*)[^\s,;]+/gi, "$1…REDACTED");
}

function killProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExit(instances, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instances.every((instance) => !isProcessAlive(instance.pid))) return;
    await delay(100);
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function maxDefined(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? Math.max(...nums) : null;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "n/a";
  const units = ["B", "KiB", "MiB", "GiB"];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function getPageSize() {
  try {
    const out = execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : 4096;
  } catch {
    return 4096;
  }
}

if (!existsSync(REPO_ROOT)) {
  throw new Error(`repo root not found: ${REPO_ROOT}`);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
