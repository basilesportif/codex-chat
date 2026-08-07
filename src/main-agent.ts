import type { Logger } from "pino";
import type { BehaviorPack } from "./behavior.js";
import { ClaudeMainAgentClient } from "./claude-main-agent.js";
import type { AppConfig } from "./config.js";
import { AppServerCodexClient, type CodexCrashHandler } from "./codex.js";
import type { StateStore } from "./state.js";
import type {
  MainAgentClient,
  MainAgentContextStats,
  MainAgentEvent,
  MainAgentHealth,
  MainAgentProvider,
  MainAgentTurnInput
} from "./types.js";

export const MAIN_AGENT_SWITCH_GRACE_MS = 15_000;

export function assertMainAgentConfig(
  config: AppConfig,
  provider: MainAgentProvider = config.mainAgent.provider
): void {
  if (provider === "claude_agent_sdk" && config.employees.enabled) {
    throw new Error("Claude main loop does not support durable Employees yet");
  }
}

export function createMainAgentClient(
  config: AppConfig,
  state: StateStore,
  behavior: BehaviorPack,
  logger: Logger,
  onCrash?: CodexCrashHandler,
  provider: MainAgentProvider = config.mainAgent.provider
): { client: MainAgentClient; appServerClient?: AppServerCodexClient } {
  assertMainAgentConfig(config, provider);

  if (provider === "codex") {
    const appServerClient = new AppServerCodexClient(config, state, behavior, logger, onCrash);
    return { client: appServerClient, appServerClient };
  }

  return { client: new ClaudeMainAgentClient(config, state, behavior, logger, onCrash) };
}

export interface MainAgentProviderStatus {
  configured: MainAgentProvider;
  override?: MainAgentProvider;
  effective: MainAgentProvider;
  source: "config" | "override";
  health: MainAgentHealth;
}

export interface MainAgentSwitcherOptions {
  configuredProvider: MainAgentProvider;
  employeesEnabled: boolean;
  createClient: (provider: MainAgentProvider, onCrash: CodexCrashHandler) => MainAgentClient;
  loadOverride: () => Promise<MainAgentProvider | undefined>;
  persistOverride: (provider: MainAgentProvider | undefined, updatedBy?: string) => Promise<void>;
  onCrash?: CodexCrashHandler;
  switchGraceMs?: number;
}

/**
 * Stable supervisor-facing main-agent client whose inner provider can be
 * replaced without restarting the service. Main turns register before the
 * lifecycle lock is released, so a switch can always see and drain them.
 */
export class MainAgentSwitcher implements MainAgentClient {
  private inner: MainAgentClient;
  private activeProvider: MainAgentProvider;
  private override?: MainAgentProvider;
  private overrideLoaded = false;
  private started = false;
  private lockTail: Promise<void> = Promise.resolve();
  private readonly activeTurns = new Set<symbol>();
  private turnDrainWaiters = new Set<() => void>();
  private readonly switchGraceMs: number;

  constructor(private readonly options: MainAgentSwitcherOptions) {
    this.activeProvider = options.configuredProvider;
    this.switchGraceMs = options.switchGraceMs ?? MAIN_AGENT_SWITCH_GRACE_MS;
    this.inner = this.buildInner(this.activeProvider);
  }

  get provider(): MainAgentProvider {
    return this.activeProvider;
  }

  async start(): Promise<void> {
    await this.withLock(async () => {
      await this.loadOverrideInsideLock();
      await this.inner.start();
      this.started = true;
    });
  }

  async stop(): Promise<void> {
    await this.withLock(async () => {
      await this.inner.stop();
      this.started = false;
    });
  }

  async health(): Promise<MainAgentHealth> {
    return this.withLock(async () => ({
      ...await this.inner.health(),
      provider: this.activeProvider
    }));
  }

  async providerStatus(): Promise<MainAgentProviderStatus> {
    return this.withLock(async () => ({
      configured: this.options.configuredProvider,
      override: await this.loadedOverrideInsideLock(),
      effective: this.activeProvider,
      source: this.override === undefined ? "config" : "override",
      health: { ...await this.inner.health(), provider: this.activeProvider }
    }));
  }

  async *sendTurn(input: MainAgentTurnInput): AsyncIterable<MainAgentEvent> {
    const turn = Symbol("main-agent-turn");
    const client = await this.withLock(async () => {
      this.activeTurns.add(turn);
      return this.inner;
    });
    try {
      for await (const event of client.sendTurn(input)) yield event;
    } finally {
      this.activeTurns.delete(turn);
      if (this.activeTurns.size === 0) {
        for (const resolve of this.turnDrainWaiters) resolve();
        this.turnDrainWaiters.clear();
      }
    }
  }

  async resetSession(reason?: string): Promise<MainAgentHealth> {
    return this.withLock(async () => {
      if (!this.inner.resetSession) {
        throw new Error(`Main provider ${this.activeProvider} does not support resetting its session`);
      }
      return { ...await this.inner.resetSession(reason), provider: this.activeProvider };
    });
  }

  /**
   * Clear the ACTIVE provider's persisted main session without restarting.
   * Recovery paths must route through here rather than naming a session key,
   * so a provider switch can never leave them clearing the wrong one.
   */
  async clearPersistedSession(reason?: string): Promise<void> {
    const client = await this.withLock(async () => this.inner);
    if (!client.clearPersistedSession) {
      throw new Error(`Main provider ${this.activeProvider} does not support clearing its persisted session`);
    }
    await client.clearPersistedSession(reason);
  }

  contextStats(): MainAgentContextStats | undefined {
    return this.inner.contextStats?.();
  }

  getRecentLogs(n?: number, includeRaw?: boolean): string[] {
    return this.inner.getRecentLogs?.(n, includeRaw) ?? [];
  }

  consumePendingBehaviorRefresh(): string | undefined {
    return this.inner.consumePendingBehaviorRefresh?.();
  }

  async switchProvider(next: MainAgentProvider, updatedBy?: string): Promise<MainAgentHealth> {
    return this.transition(next, next, updatedBy, false);
  }

  async useConfiguredProvider(updatedBy?: string): Promise<MainAgentHealth> {
    return this.transition(this.options.configuredProvider, undefined, updatedBy, true);
  }

  private async transition(
    next: MainAgentProvider,
    nextOverride: MainAgentProvider | undefined,
    updatedBy?: string,
    persistOnNoop = false
  ): Promise<MainAgentHealth> {
    return this.withLock(async () => {
      await this.loadOverrideInsideLock();
      this.assertProviderAllowed(next);
      if (next === this.activeProvider) {
        if (persistOnNoop && this.override !== nextOverride) {
          await this.options.persistOverride(nextOverride, updatedBy);
          this.override = nextOverride;
        }
        return { ...await this.inner.health(), provider: this.activeProvider };
      }

      const previous = this.inner;
      const previousProvider = this.activeProvider;
      const previousOverride = this.override;
      await this.waitForActiveTurns(this.switchGraceMs);
      await previous.stop();

      const replacement = this.buildInner(next);
      this.inner = replacement;
      this.activeProvider = next;
      try {
        if (this.started) await replacement.start();
        await this.options.persistOverride(nextOverride, updatedBy);
        this.override = nextOverride;
        return { ...await replacement.health(), provider: next };
      } catch (switchError) {
        await replacement.stop().catch(() => undefined);
        this.inner = previous;
        this.activeProvider = previousProvider;
        this.override = previousOverride;
        try {
          if (this.started) await previous.start();
        } catch (rollbackError) {
          throw new Error(
            `Failed to switch main provider to ${next}: ${errorMessage(switchError)}; rollback to ${previousProvider} also failed: ${errorMessage(rollbackError)}`,
            { cause: switchError }
          );
        }
        throw new Error(
          `Failed to switch main provider to ${next}: ${errorMessage(switchError)}; rolled back to ${previousProvider}`,
          { cause: switchError }
        );
      }
    });
  }

  private async loadOverrideInsideLock(): Promise<void> {
    if (this.overrideLoaded) return;
    this.override = await this.options.loadOverride();
    this.overrideLoaded = true;
    const effective = this.override ?? this.options.configuredProvider;
    this.assertProviderAllowed(effective);
    if (!this.started && effective !== this.activeProvider) {
      this.activeProvider = effective;
      this.inner = this.buildInner(effective);
    }
  }

  private async loadedOverrideInsideLock(): Promise<MainAgentProvider | undefined> {
    await this.loadOverrideInsideLock();
    return this.override;
  }

  private assertProviderAllowed(provider: MainAgentProvider): void {
    if (provider === "claude_agent_sdk" && this.options.employeesEnabled) {
      throw new Error("Cannot switch the main provider to Claude while durable Employees are enabled");
    }
  }

  private buildInner(provider: MainAgentProvider): MainAgentClient {
    let client!: MainAgentClient;
    const onCrash: CodexCrashHandler = (reason, info) => {
      if (this.inner !== client || this.activeProvider !== provider) return;
      this.options.onCrash?.(reason, info);
    };
    client = this.options.createClient(provider, onCrash);
    return client;
  }

  private async waitForActiveTurns(timeoutMs: number): Promise<boolean> {
    if (this.activeTurns.size === 0) return true;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      this.turnDrainWaiters.add(resolve);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([drained.then(() => true as const), timedOut]);
    if (timer) clearTimeout(timer);
    this.turnDrainWaiters.delete(resolveDrain);
    return result;
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }
}

export function createMainAgentSwitcher(
  config: AppConfig,
  state: StateStore,
  behavior: BehaviorPack,
  logger: Logger,
  onCrash?: CodexCrashHandler
): { switcher: MainAgentSwitcher; appServerClient?: AppServerCodexClient } {
  let initialAppServerClient: AppServerCodexClient | undefined;
  const switcher = new MainAgentSwitcher({
    configuredProvider: config.mainAgent.provider,
    employeesEnabled: config.employees.enabled,
    loadOverride: () => state.getMainProviderOverride(),
    persistOverride: (provider, updatedBy) => state.setMainProviderOverride(provider, updatedBy),
    onCrash,
    createClient: (provider, crashHandler) => {
      const created = createMainAgentClient(config, state, behavior, logger, crashHandler, provider);
      if (provider === config.mainAgent.provider) initialAppServerClient = created.appServerClient;
      return created.client;
    }
  });
  return { switcher, appServerClient: initialAppServerClient };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
