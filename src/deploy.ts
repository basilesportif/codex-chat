import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { AppConfig, resolveConfigPath } from "./config.js";
import { pathExists } from "./util.js";

/**
 * Service-level self-update support. The "update", "deploy", "redeploy",
 * "pull and restart", and "update yourself" commands hit this module before
 * Codex sees them — the service acks the user, waits for the current turn
 * to finish (capped at 30s), then spawns scripts/deploy.sh detached so the
 * git pull / build / systemctl restart all survive our own SIGTERM.
 *
 * After systemd brings the service back up, ServiceSupervisor.start reads
 * the deploy marker and tells the user the deploy succeeded (with the new
 * commit hash). On build/install failure, deploy.sh sends the error to
 * Telegram directly via the Bot API — this service is left running.
 */

const DEPLOY_COMMAND_REGEX = /^\s*(update(?:\s+yourself|\s+self)?|deploy|redeploy|pull\s+and\s+restart|self[-\s]?update)\s*$/i;

export interface DeployContext {
  config: AppConfig;
  logger: Logger;
  isTurnRunning: () => boolean;
}

export interface DeployMarker {
  status: "success" | "failed" | "restart_failed";
  chatId: number;
  replyToMessageId?: number | null;
  commitBefore: string;
  commitAfter: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function isDeployCommand(text: string | undefined): boolean {
  if (!text) return false;
  return DEPLOY_COMMAND_REGEX.test(text);
}

function deployScriptPath(config: AppConfig): string {
  return join(config.rootDir, "scripts", "deploy.sh");
}

function deployStateDir(config: AppConfig): string {
  return resolveConfigPath(config, config.service.stateDir);
}

export function deployMarkerPath(config: AppConfig): string {
  return join(deployStateDir(config), "deploy-marker.json");
}

/**
 * Wait up to drainMs for the in-flight turn (if any) to finish so a deploy
 * doesn't kill its own response mid-stream. Polls every 250ms. If the turn
 * is still running after the timeout, we proceed anyway — systemd will
 * restart us, the post-restart abandon-stuck-turns logic notifies the user.
 */
export async function waitForTurnDrain(
  isTurnRunning: () => boolean,
  drainMs: number,
  logger: Logger
): Promise<{ drained: boolean; waitedMs: number }> {
  const start = Date.now();
  if (!isTurnRunning()) return { drained: true, waitedMs: 0 };
  logger.info({ component: "deploy", event: "drain_wait_start", drainMs }, "Waiting for turn to drain before deploy");
  while (Date.now() - start < drainMs) {
    await new Promise((r) => setTimeout(r, 250));
    if (!isTurnRunning()) {
      const waitedMs = Date.now() - start;
      logger.info({ component: "deploy", event: "drain_wait_done", waitedMs }, "Turn drained; proceeding with deploy");
      return { drained: true, waitedMs };
    }
  }
  const waitedMs = Date.now() - start;
  logger.warn({ component: "deploy", event: "drain_wait_timeout", waitedMs }, "Turn did not drain in time; deploying anyway");
  return { drained: false, waitedMs };
}

/**
 * Spawn scripts/deploy.sh fully detached so the systemctl restart it
 * issues can SIGTERM us without killing the deploy. We do not await the
 * child — it runs to completion independent of this process.
 */
export function spawnDeployScript(
  ctx: DeployContext,
  chatId: number,
  replyToMessageId?: number
): void {
  const script = deployScriptPath(ctx.config);
  const stateDir = deployStateDir(ctx.config);
  const args = [script, ctx.config.rootDir, stateDir, String(chatId)];
  if (replyToMessageId !== undefined) args.push(String(replyToMessageId));
  ctx.logger.info(
    { component: "deploy", event: "spawn", script, chatId, replyToMessageId },
    "Spawning deploy.sh (detached)"
  );
  const child = spawn("bash", args, {
    cwd: ctx.config.rootDir,
    env: { ...process.env },
    detached: true,
    stdio: "ignore"
  });
  child.on("error", (error) => {
    ctx.logger.error({ component: "deploy", event: "spawn_failed", error }, "deploy.sh spawn failed");
  });
  child.unref();
}

/**
 * Read and delete the deploy marker (if any). Called once during service
 * startup. Returns the marker contents so the caller can notify the user.
 */
export async function consumeDeployMarker(config: AppConfig, logger: Logger): Promise<DeployMarker | undefined> {
  const path = deployMarkerPath(config);
  if (!(await pathExists(path))) return undefined;
  let marker: DeployMarker | undefined;
  try {
    const raw = await readFile(path, "utf8");
    marker = JSON.parse(raw) as DeployMarker;
  } catch (error) {
    logger.warn({ component: "deploy", event: "marker_parse_failed", error }, "Could not parse deploy marker");
  }
  await rm(path, { force: true }).catch(() => undefined);
  return marker;
}

export function formatDeploySuccessMessage(marker: DeployMarker, currentCommit: string): string {
  const lines = [
    "Redeployed successfully.",
    `commit: ${currentCommit}`
  ];
  if (marker.commitBefore && marker.commitBefore !== marker.commitAfter) {
    lines.push(`previous: ${marker.commitBefore}`);
  }
  return lines.join("\n");
}

export function formatDeployFailureMessage(marker: DeployMarker): string {
  const lines = ["Deploy failed."];
  if (marker.commitAfter) lines.push(`commit: ${marker.commitAfter}`);
  if (marker.message) lines.push("", marker.message.slice(0, 1500));
  return lines.join("\n");
}

// Re-export resolve so call sites do not need to import from node:path.
export const _resolve = resolve;
