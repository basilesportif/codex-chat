#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig, ensureConfiguredDirectories, writeDefaultConfigFilesIfMissing, resolveConfigPath, type AppConfig } from "./config.js";
import { sanitizeChildProcessEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { EmployeeManager } from "./employees.js";
import { readIpcToken, sendIpcMessage, type IpcMessage } from "./ipc.js";
import { formatLoopsStatus, runLoopCli, syncCron, validateLoops } from "./loops.js";
import { validateMonitors } from "./monitors.js";
import { injectFilePath, INJECT_TELEGRAM_USER_ID, ServiceSupervisor } from "./service.js";
import { StateStore } from "./state.js";
import { installUserService, uninstallUserService } from "./systemd.js";
import { atomicWriteJson, nowIso, pathExists } from "./util.js";

const program = new Command();

class CliUserError extends Error {}

program
  .name("codex-chat")
  .description("Telegram-driven Codex service")
  .version("0.1.0")
  .option("--config <path>", "config TOML path", process.env.CODEX_CHAT_CONFIG ?? "config/codex-chat.toml");

program.command("start")
  .description("start the long-running codex-chat service")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const logger = createLogger(config.service.logLevel, config.security.redactSecretsInLogs);
    const service = new ServiceSupervisor(config, logger);
    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ component: "cli", event: "shutdown", signal }, "shutting down");
      await service.stop();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    await service.start();
  });

program.command("setup")
  .description("create default directories and print first-run setup guidance")
  .action(async () => {
    const configPath = program.opts().config as string;
    await writeDefaultConfigFilesIfMissing(configPath);
    const config = await loadConfig(configPath);
    await ensureConfiguredDirectories(config);
    const logger = createLogger(config.service.logLevel, config.security.redactSecretsInLogs);
    logger.info({ component: "setup", configPath: config.configPath }, "codex-chat setup complete");
    process.stdout.write([
      "codex-chat setup complete",
      `config: ${config.configPath}`,
      `state: ${resolveConfigPath(config, config.service.stateDir)}`,
      "",
      `Set ${config.telegram.botTokenEnv} and ${config.transcription.apiKeyEnv} before starting.`,
      "If the Telegram allowlist is empty, `codex-chat start` will print a one-time /pair code."
    ].join("\n") + "\n");
  });

program.command("health")
  .description("check local service prerequisites")
  .option("--json", "print JSON")
  .option("--strict", "exit non-zero when optional runtime secrets are missing")
  .action(async (options: { json?: boolean; strict?: boolean }) => {
    const config = await loadConfig(program.opts().config);
    await ensureConfiguredDirectories(config);
    const codexVersion = await runCapture(config, config.codex.binary, ["--version"]).catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const behaviorOk = await pathExists(resolveConfigPath(config, join(config.behavior.dir, config.behavior.entrypoint)));
    const result = {
      ok: true,
      config: config.configPath,
      runtime: runtimeVersion(),
      codex: codexVersion.trim(),
      behaviorOk,
      telegramConfigured: Boolean(config.telegramBotToken),
      slackEnabled: config.slack.enabled,
      slackSigningSecretConfigured: Boolean(config.slackSigningSecret),
      slackBotTokenConfigured: Boolean(config.slackBotToken),
      openaiConfigured: Boolean(config.openaiApiKey),
      stateDir: resolveConfigPath(config, config.service.stateDir)
    };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`ok\ncodex: ${result.codex}\nstate: ${result.stateDir}\n`);
    if (options.strict && (!result.telegramConfigured || (config.transcription.enabled && !result.openaiConfigured) || !behaviorOk)) process.exit(1);
  });

program.command("inject")
  .argument("<message...>", "message text")
  .description("inject a synthetic Telegram message into the running service")
  .action(async (messageParts: string[]) => {
    const config = await loadConfig(program.opts().config);
    const path = injectFilePath(config);
    await atomicWriteJson(path, {
      text: messageParts.join(" "),
      userId: INJECT_TELEGRAM_USER_ID,
      chatId: INJECT_TELEGRAM_USER_ID,
      username: "tim",
      receivedAt: nowIso(),
      metadata: { injected: true }
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await pathExists(path))) {
        process.stdout.write("injected\n");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stdout.write("timeout\n");
    process.exit(1);
  });

const loop = program.command("loop").description("loop management");
loop.command("sync")
  .description("sync config/loops.json into crontab")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const logger = createLogger(config.service.logLevel, config.security.redactSecretsInLogs);
    const result = await syncCron(config, logger);
    process.stdout.write(`cron ${result.changed ? "updated" : "unchanged"} (${result.lines.length} loops)\n`);
  });
loop.command("run")
  .argument("<id>", "loop id")
  .description("enqueue a loop run through the local service socket")
  .action(async (id: string) => {
    const config = await loadConfig(program.opts().config);
    await runLoopCli(config, id);
  });
loop.command("validate")
  .description("validate loops JSON")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const loops = await validateLoops(config);
    process.stdout.write(`valid loops: ${loops.loops.length}\n`);
  });
loop.command("status")
  .description("print configured loop status")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const state = new StateStore(config);
    await state.init();
    process.stdout.write(`${await formatLoopsStatus(config, state)}\n`);
  });

const monitors = program.command("monitors").description("monitor management");
monitors.command("validate")
  .description("validate monitors JSON")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const parsed = await validateMonitors(config);
    process.stdout.write(`valid monitors: ${parsed.monitors.length}\n`);
  });

const employees = program.command("employees").description("durable Employee runtime/scaffold management");
employees.command("list")
  .description("list configured Employees")
  .option("--json", "print JSON")
  .action(async (options: { json?: boolean }) => {
    const manager = await loadEmployeeManager();
    if (options.json) process.stdout.write(`${JSON.stringify(manager.listEmployees(), null, 2)}\n`);
    else process.stdout.write(`${await manager.formatList()}\n`);
  });
employees.command("status")
  .argument("<id>", "employee id or prefix")
  .description("show an Employee runtime/scaffold status")
  .option("--json", "print JSON state")
  .action(async (id: string, options: { json?: boolean }) => {
    const manager = await loadEmployeeManager();
    const resolution = manager.resolveEmployeeRef(id);
    if (options.json) {
      if (resolution.status !== "matched") {
        process.stdout.write(`${JSON.stringify(resolution, null, 2)}\n`);
        if (resolution.status === "not_found") process.exitCode = 1;
        return;
      }
      const state = await manager.getEmployeeState(resolution.employee.id);
      const directory = await manager.validateDirectory(resolution.employee.id);
      process.stdout.write(`${JSON.stringify({ employee: resolution.employee, state, directory }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${await manager.formatStatus(id)}\n`);
  });
employees.command("start")
  .argument("<id>", "employee id or prefix")
  .description("ask the running service to start/resume an Employee runtime")
  .action(async (id: string) => {
    const result = await sendEmployeeIpc("employee_start", { employeeId: id });
    process.stdout.write(`${formatIpcEmployeeResult(result)}\n`);
  });
employees.command("stop")
  .argument("<id>", "employee id or prefix")
  .description("ask the running service to stop Employee runtime management")
  .action(async (id: string) => {
    const result = await sendEmployeeIpc("employee_stop", { employeeId: id });
    process.stdout.write(`${formatIpcEmployeeResult(result)}\n`);
  });
employees.command("steer")
  .argument("<id>", "employee id or prefix")
  .argument("<text...>", "steering/query text")
  .description("ask the running service to send a turn to an Employee runtime")
  .action(async (id: string, textParts: string[]) => {
    const result = await sendEmployeeIpc("employee_steer", { employeeId: id, text: textParts.join(" ") });
    process.stdout.write(`${formatIpcEmployeeResult(result)}\n`);
  });
employees.command("propose")
  .argument("<id>", "employee id or prefix")
  .argument("<action>", "proposal action: start, stop, steer, warmup, compact")
  .argument("[text...]", "proposal text for steer")
  .description("record a proposal only; no Employee runtime/account mutation is executed")
  .action(async (id: string, action: string, textParts: string[]) => {
    const manager = await loadEmployeeManager();
    const result = await manager.propose(action as "start" | "stop" | "steer" | "warmup" | "compact", id, textParts.join(" "), "cli");
    process.stdout.write(`${result.message}\n`);
    if (result.status !== "proposal") process.exitCode = 1;
  });

const service = program.command("service").description("systemd service management");
service.command("install")
  .description("install a systemd service")
  .option("--user", "install as a user service", true)
  .option("--enable-now", "enable and start immediately")
  .action(async (options: { user?: boolean; enableNow?: boolean }) => {
    if (!options.user) throw new Error("Only --user service install is supported in v1");
    const config = await loadConfig(program.opts().config);
    const path = await installUserService(config, Boolean(options.enableNow));
    process.stdout.write(`installed ${path}\n`);
  });
service.command("uninstall")
  .description("uninstall the systemd user service")
  .option("--user", "uninstall user service", true)
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    await uninstallUserService(config);
    process.stdout.write("uninstalled codex-chat user service\n");
  });

const jobs = program.command("jobs").description("subagent jobs");
jobs.command("list")
  .description("list persisted subagent jobs")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const jobsDir = resolveConfigPath(config, join(config.service.stateDir, "jobs"));
    if (!(await pathExists(jobsDir))) {
      process.stdout.write("No jobs.\n");
      return;
    }
    const files = (await readdir(jobsDir)).filter((file) => file.endsWith(".json"));
    if (files.length === 0) {
      process.stdout.write("No jobs.\n");
      return;
    }
    for (const file of files.sort().slice(-50)) {
      const job = JSON.parse(await readFile(join(jobsDir, file), "utf8")) as { id: string; status: string; profile: string };
      process.stdout.write(`${job.id} ${job.status} ${job.profile}\n`);
    }
  });
jobs.command("cancel")
  .argument("<id>", "job id")
  .description("request cancellation for a running job from Telegram or service UI")
  .action(async (id: string) => {
    process.stdout.write(`Use Telegram /cancel ${id} while the service is running.\n`);
  });

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof CliUserError) process.stderr.write(`${error.message}\n`);
  else process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

function runCapture(config: AppConfig, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: sanitizeChildProcessEnv(config), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || stdout || `${command} exited with ${code}`)));
  });
}

async function loadEmployeeManager(): Promise<EmployeeManager> {
  const config = await loadConfig(program.opts().config);
  await ensureConfiguredDirectories(config);
  const state = new StateStore(config);
  await state.init();
  const logger = createLogger("silent", config.security.redactSecretsInLogs);
  const manager = new EmployeeManager(config, state, logger);
  await manager.init();
  return manager;
}

async function sendEmployeeIpc(
  type: "employee_start" | "employee_stop" | "employee_steer",
  payload: { employeeId: string; text?: string }
): Promise<unknown> {
  const config = await loadConfig(program.opts().config);
  const socketPath = resolveConfigPath(config, config.service.ipcSocket);
  try {
    const token = await readIpcToken(socketPath);
    return await sendIpcMessage(socketPath, { type, ...payload, token } as IpcMessage);
  } catch (error) {
    throw new CliUserError(`Could not reach running codex-chat service at ${socketPath}; start the service before using employees start/stop/steer. ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatIpcEmployeeResult(result: unknown): string {
  if (result && typeof result === "object" && "message" in result && typeof (result as { message?: unknown }).message === "string") {
    return (result as { message: string }).message;
  }
  return JSON.stringify(result, null, 2);
}

function runtimeVersion(): string {
  const bun = (process.versions as typeof process.versions & { bun?: string }).bun;
  return bun ? `bun ${bun}` : `node ${process.version}`;
}
