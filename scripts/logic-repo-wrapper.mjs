#!/usr/bin/env node
// Shared launcher for delegating codex-chat helper scripts to their canonical
// implementations in the assistant-agent-logic repo.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const LOGIC_REPO = process.env.ASSISTANT_LOGIC_REPO || "/home/tim/pkg/tim/assistant-agent-logic";

export function runLogicScript(scriptName, argv) {
  const script = join(LOGIC_REPO, "scripts", scriptName);
  if (!existsSync(script)) {
    console.error(`assistant-agent-logic script not found: ${script} (set ASSISTANT_LOGIC_REPO)`);
    process.exit(1);
  }
  const env = { ...process.env };
  if (!env.ASSISTANT_PRIVATE_DIR && env.CODEX_CHAT_PRIVATE_DIR) env.ASSISTANT_PRIVATE_DIR = env.CODEX_CHAT_PRIVATE_DIR;
  const args = [...argv];
  const hasExplicitRoot = args.some((arg) => arg === "--private-root" || arg === "--private-dir");
  if (!hasExplicitRoot && !env.ASSISTANT_PRIVATE_DIR && !env.BRAIN_PRIVATE_DIR) {
    args.push("--private-root", join(process.cwd(), "data", "private"));
  }
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", env });
  process.exit(result.status ?? 1);
}
