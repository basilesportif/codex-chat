#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { loadConfig, ensureConfiguredDirectories, writeDefaultConfigFilesIfMissing, resolveConfigPath } from "./config.js";
import { createLogger } from "./logger.js";
import { runLoopCli, syncCron, validateLoops } from "./loops.js";
import { validateMonitors } from "./monitors.js";
import { injectFilePath, INJECT_TELEGRAM_USER_ID, ServiceSupervisor } from "./service.js";
import { installUserService, uninstallUserService } from "./systemd.js";
import { atomicWriteJson, nowIso, pathExists } from "./util.js";

const program = new Command();

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
    const codexVersion = await runCapture(config.codex.binary, ["--version"]).catch((error) => `unavailable: ${error instanceof Error ? error.message : String(error)}`);
    const behaviorOk = await pathExists(resolveConfigPath(config, join(config.behavior.dir, config.behavior.entrypoint)));
    const result = {
      ok: true,
      config: config.configPath,
      runtime: runtimeVersion(),
      codex: codexVersion.trim(),
      behaviorOk,
      telegramConfigured: Boolean(config.telegramBotToken),
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

const monitors = program.command("monitors").description("monitor management");
monitors.command("validate")
  .description("validate monitors JSON")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    const parsed = await validateMonitors(config);
    process.stdout.write(`valid monitors: ${parsed.monitors.length}\n`);
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
    await uninstallUserService();
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
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const { OPENAI_API_KEY: _omit, ...safeEnv } = process.env;
    const child = spawn(command, args, { env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
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

function runtimeVersion(): string {
  const bun = (process.versions as typeof process.versions & { bun?: string }).bun;
  return bun ? `bun ${bun}` : `node ${process.version}`;
}
