import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { AppConfig } from "./config.js";
import { ensureDir, pathExists } from "./util.js";

export async function installUserService(config: AppConfig, enableNow = false): Promise<string> {
  const unitDir = join(homedir(), ".config/systemd/user");
  const envDir = join(homedir(), ".config/codex-chat");
  await ensureDir(unitDir);
  await ensureDir(envDir);
  const envPath = join(envDir, "env");
  if (!(await pathExists(envPath))) {
    await writeFile(envPath, [
      `TELEGRAM_BOT_TOKEN=${process.env[config.telegram.botTokenEnv] ?? ""}`,
      `OPENAI_API_KEY=${process.env[config.transcription.apiKeyEnv] ?? ""}`,
      ""
    ].join("\n"), { mode: 0o600 });
  }
  const node = process.execPath;
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
ExecStart=${node} ${main} --config ${config.configPath} start
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
  await writeFile(unitPath, unit, { mode: 0o644 });
  await runSystemctl(["--user", "daemon-reload"]).catch(() => undefined);
  if (enableNow) await runSystemctl(["--user", "enable", "--now", "codex-chat.service"]).catch(() => undefined);
  return unitPath;
}

export async function uninstallUserService(): Promise<void> {
  await runSystemctl(["--user", "disable", "--now", "codex-chat.service"]).catch(() => undefined);
  const unitPath = join(homedir(), ".config/systemd/user/codex-chat.service");
  await rm(unitPath, { force: true });
  await runSystemctl(["--user", "daemon-reload"]).catch(() => undefined);
}

export async function readUserService(): Promise<string | undefined> {
  const unitPath = join(homedir(), ".config/systemd/user/codex-chat.service");
  if (!(await pathExists(unitPath))) return undefined;
  return readFile(unitPath, "utf8");
}

function runSystemctl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("systemctl", args, { stdio: "ignore" });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`systemctl exited with ${code}`)));
  });
}
