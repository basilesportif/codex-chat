import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { AppConfig } from "./config.js";
import { sanitizeChildProcessEnv } from "./env.js";
import { ensureDir, pathExists } from "./util.js";

export async function installUserService(config: AppConfig, enableNow = false): Promise<string> {
  const unitDir = join(homedir(), ".config/systemd/user");
  const envDir = join(homedir(), ".config/codex-chat");
  await ensureDir(unitDir);
  await ensureDir(envDir);
  const envPath = join(envDir, "env");
  if (!(await pathExists(envPath))) {
    await writeFile(envPath, [
      `${config.telegram.botTokenEnv}=${process.env[config.telegram.botTokenEnv] ?? ""}`,
      `${config.slack.signingSecretEnv}=${process.env[config.slack.signingSecretEnv] ?? ""}`,
      `${config.slack.botTokenEnv}=${process.env[config.slack.botTokenEnv] ?? ""}`,
      `${config.slack.appTokenEnv}=${process.env[config.slack.appTokenEnv] ?? ""}`,
      `${config.transcription.apiKeyEnv}=${process.env[config.transcription.apiKeyEnv] ?? ""}`,
      `${config.ingest.apiKeysEnv}=${process.env[config.ingest.apiKeysEnv] ?? ""}`,
      `CODEXCHAT_AUDIO_INGEST_MAX_MB=${process.env.CODEXCHAT_AUDIO_INGEST_MAX_MB ?? String(config.ingest.audioMaxMb)}`,
      ""
    ].join("\n"), { mode: 0o600 });
  }
  const runtime = await resolveBunRuntime();
  const main = resolve(process.argv[1] ?? "dist/main.js");
  const unitPath = join(unitDir, "codex-chat.service");
  const unit = `[Unit]
Description=codex-chat Telegram Codex service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${config.rootDir}
EnvironmentFile=${envPath}
ExecStart=${runtime} ${main} --config ${config.configPath} start
Restart=always
RestartSec=5
StartLimitIntervalSec=0
# Memory guard (2026-08-19). Steady-state RSS is ~940MB; the 2026-08-18 OOM
# peaked over 3GB when one job fanned out to three nested claude processes
# on top of the main loop and an operator subagent, and the kernel killed the
# unit. MemoryHigh throttles the cgroup and reclaims into the 4GB swapfile
# before that point instead of killing anything. Deliberately NO MemoryMax:
# a hard ceiling would just re-create the kill under a different name.
MemoryAccounting=yes
MemoryHigh=2500M
# NoNewPrivileges is intentionally NOT set: the system crontab binary is
# setgid (group crontab) and loop sync invokes it to install the managed
# block. NoNewPrivileges=true would silently break "codex-chat loop sync"
# on every service start with an empty error.
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
  await writeFile(unitPath, unit, { mode: 0o644 });
  await runSystemctl(["--user", "daemon-reload"], config).catch(() => undefined);
  if (enableNow) await runSystemctl(["--user", "enable", "--now", "codex-chat.service"], config).catch(() => undefined);
  return unitPath;
}

export async function uninstallUserService(config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack">>): Promise<void> {
  await runSystemctl(["--user", "disable", "--now", "codex-chat.service"], config).catch(() => undefined);
  const unitPath = join(homedir(), ".config/systemd/user/codex-chat.service");
  await rm(unitPath, { force: true });
  await runSystemctl(["--user", "daemon-reload"], config).catch(() => undefined);
}


function runSystemctl(args: string[], config?: Pick<AppConfig, "transcription"> & Partial<Pick<AppConfig, "ingest" | "slack">>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", args, { env: sanitizeChildProcessEnv(config), stdio: "ignore" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`systemctl exited with ${code}`)));
  });
}

async function resolveBunRuntime(): Promise<string> {
  const bun = (process.versions as typeof process.versions & { bun?: string }).bun;
  if (bun && process.execPath) return process.execPath;
  const homeBun = join(homedir(), ".bun/bin/bun");
  if (await pathExists(homeBun)) return homeBun;
  return "bun";
}
