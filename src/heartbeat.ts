import type { Logger } from "pino";
import type { CodexClient, CodexHealth } from "./types.js";

export class CodexHeartbeat {
  private interval?: ReturnType<typeof setInterval>;
  private wasHealthy = true;
  private consecutiveFailures = 0;

  constructor(
    private readonly codex: CodexClient,
    private readonly notifyOps: (text: string) => Promise<void>,
    private readonly logger: Logger,
    private readonly intervalMs = 15000,
    private readonly failureThreshold = 3
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
      await this.notifyOps("✅ codex-chat: Codex connection restored");
      this.wasHealthy = true;
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

    if (this.wasHealthy && this.consecutiveFailures >= this.failureThreshold) {
      this.logger.error(details, "Codex heartbeat unhealthy threshold reached");
      await this.notifyOps("⚠️ codex-chat: Codex connection unhealthy");
      this.wasHealthy = false;
      return;
    }

    this.logger.warn(details, "Codex heartbeat unhealthy");
  }
}
