import type { Logger } from "pino";
import type { CodexClient, CodexHealth } from "./types.js";

/**
 * Periodic Codex health probe with persistent ops alerting.
 *
 * Behaviors:
 *  - Initial alert when consecutiveFailures crosses failureThreshold (codex
 *    just went down).
 *  - Re-alerts every reAlertMs while codex stays down so a long outage does
 *    not silently degrade. Without this, a one-off "unhealthy" alert could
 *    sit unread for hours and the rest of the failure window would be
 *    invisible on Telegram.
 *  - Recovery alert when the connection comes back.
 */
export class CodexHeartbeat {
  private interval?: ReturnType<typeof setInterval>;
  private wasHealthy = true;
  private consecutiveFailures = 0;
  private downSince?: number;
  private lastAlertAt?: number;

  constructor(
    private readonly codex: CodexClient,
    private readonly notifyOps: (text: string) => Promise<void>,
    private readonly logger: Logger,
    private readonly intervalMs = 15000,
    private readonly failureThreshold = 3,
    private readonly reAlertMs = 5 * 60 * 1000
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.check();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }

  private async check(): Promise<void> {
    try {
      const health = await this.codex.health();
      if (health.ok) {
        await this.handleHealthy(health);
        return;
      }

      await this.handleFailure(health);
    } catch (error) {
      await this.handleFailure(undefined, error).catch((notifyError) => {
        this.logger.error({ component: "heartbeat", event: "check_failed", error: notifyError }, "heartbeat check failed");
      });
    }
  }

  private async handleHealthy(health: CodexHealth): Promise<void> {
    this.logger.debug({ component: "heartbeat", event: "healthy", health }, "Codex heartbeat healthy");
    this.consecutiveFailures = 0;
    if (!this.wasHealthy) {
      const downForMs = this.downSince ? Date.now() - this.downSince : undefined;
      const downMin = downForMs !== undefined ? Math.round(downForMs / 60000) : undefined;
      const suffix = downMin !== undefined ? ` (was down ~${downMin}m)` : "";
      await this.notifyOps(`✅ codex-chat: Codex connection restored${suffix}`);
      this.wasHealthy = true;
      this.downSince = undefined;
      this.lastAlertAt = undefined;
    }
  }

  private async handleFailure(health?: CodexHealth, error?: unknown): Promise<void> {
    this.consecutiveFailures += 1;
    const details = {
      component: "heartbeat",
      event: "unhealthy",
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      health,
      error
    };

    // First crossing of the threshold — alert.
    if (this.wasHealthy && this.consecutiveFailures >= this.failureThreshold) {
      this.logger.error(details, "Codex heartbeat unhealthy threshold reached");
      this.downSince = Date.now();
      this.lastAlertAt = Date.now();
      await this.notifyOps("⚠️ codex-chat: Codex connection unhealthy — service is degraded. Will retry automatically and re-alert every 5m until recovered.");
      this.wasHealthy = false;
      return;
    }

    // Already known-down: re-alert every reAlertMs so a sustained outage
    // doesn't get buried in the chat.
    if (!this.wasHealthy) {
      const now = Date.now();
      if (this.lastAlertAt !== undefined && now - this.lastAlertAt >= this.reAlertMs) {
        this.lastAlertAt = now;
        const downMs = this.downSince ? now - this.downSince : 0;
        const downMin = Math.round(downMs / 60000);
        await this.notifyOps(`⚠️ codex-chat: Codex still unhealthy after ${downMin}m. Failures=${this.consecutiveFailures}. Investigate.`);
      }
    }

    this.logger.warn(details, "Codex heartbeat unhealthy");
  }
}
