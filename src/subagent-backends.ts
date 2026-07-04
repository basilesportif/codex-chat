import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import {
  query as queryClaudeAgentSdk,
  type EffortLevel as ClaudeEffortLevel,
  type Options as ClaudeAgentSdkOptions,
  type Query as ClaudeAgentSdkQuery,
  type SDKMessage as ClaudeSdkMessage,
  type SDKUserMessage as ClaudeSdkUserMessage,
  type ThinkingConfig as ClaudeThinkingConfig
} from "@anthropic-ai/claude-agent-sdk";
import WebSocket from "ws";
import type { Logger } from "pino";
import { resolveConfigPath, type AppConfig } from "./config.js";
import { loadCodexProfileConfig } from "./codex-profiles.js";
import { CLAUDE_NON_OAUTH_AUTH_ENV, CLAUDE_OAUTH_CHILD_ENV, sanitizeClaudeAgentSdkChildProcessEnv, sanitizeCodexChildProcessEnv, type ChildEnvSource } from "./env.js";
import type { ServiceTier, ServiceTierMode, SubagentBackendKind, SubagentJob } from "./types.js";
import { ensureDir, killProcessTree, nowIso, pathExists } from "./util.js";

type JsonRpcMessage = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface ChildAgentFinish {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export interface StartChildAgentInput {
  job: SubagentJob;
  assembledPrompt: string;
  lastMessagePath: string;
  stdoutPath: string;
  stderrPath: string;
  appServerLogPath: string;
  model: string;
  effort: string;
  serviceTier: ServiceTier;
  serviceTierMode?: ServiceTierMode;
  codexProfile?: string;
  modelProvider?: string;
  images: string[];
  onJobUpdated(job: SubagentJob): Promise<void>;
}

export interface StartedChildAgent {
  readonly kind: SubagentBackendKind;
  readonly finished: Promise<ChildAgentFinish>;
  kill(signal?: NodeJS.Signals): Promise<void>;
  isAlive(): boolean;
}

export interface ChildAgentBackend {
  readonly kind: SubagentBackendKind;
  start(input: StartChildAgentInput): Promise<StartedChildAgent>;
  steer(jobId: string, text: string): Promise<void>;
  interrupt(jobId: string, reason?: string): Promise<void>;
  kill(jobId: string, signal?: NodeJS.Signals): Promise<void>;
  shutdown(): Promise<void>;
}

type ClaudeSubagentConfig = NonNullable<AppConfig["subagents"]["claude"]>;

const DEFAULT_CLAUDE_SUBAGENT_CONFIG: ClaudeSubagentConfig = {
  enabled: false,
  pathToClaudeCodeExecutable: "",
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  allowedTools: ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep"],
  disallowedTools: [],
  maxTurns: 100,
  settingSources: [],
  fastMode: true,
  steerSettleGraceMs: 10_000
};

const CLAUDE_SYNTHETIC_ACTIVE_TURN_ID = "claude-agent-sdk-stream";

const CLAUDE_FAST_MODE_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4-8"];

/**
 * Claude fast mode is a premium speed tier available only on Opus 4.8/4.7.
 * An empty model means the SDK default — treat it as supported and let the
 * SDK decide. A serviceTier of "fast" on any other Claude model runs at the
 * standard tier; callers surface that downgrade in user-facing status.
 */
export function claudeFastModeSupported(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "opus" || CLAUDE_FAST_MODE_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function claudeSubagentConfig(config: AppConfig): ClaudeSubagentConfig {
  return { ...DEFAULT_CLAUDE_SUBAGENT_CONFIG, ...(config.subagents.claude ?? {}) };
}

class AsyncUserMessageQueue implements AsyncIterable<ClaudeSdkUserMessage> {
  private readonly queue: ClaudeSdkUserMessage[] = [];
  private pending?: {
    resolve: (value: IteratorResult<ClaudeSdkUserMessage>) => void;
    reject: (error: Error) => void;
  };
  private closed = false;
  private failure?: Error;

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserMessage> {
    return {
      next: () => this.next()
    };
  }

  push(message: ClaudeSdkUserMessage): void {
    if (this.closed) throw new Error("Claude Agent SDK input stream is closed.");
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  close(): void {
    this.closed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.resolve({ done: true, value: undefined });
    }
  }

  isOpen(): boolean {
    return !this.closed;
  }

  error(error: Error): void {
    this.failure = error;
    this.closed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(error);
    }
  }

  private next(): Promise<IteratorResult<ClaudeSdkUserMessage>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift() as ClaudeSdkUserMessage });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<ClaudeSdkUserMessage>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
}

export class CodexExecChildAgentBackend implements ChildAgentBackend {
  readonly kind = "codex_exec" as const;
  private readonly children = new Map<string, ChildProcess>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async start(input: StartChildAgentInput): Promise<StartedChildAgent> {
    const args = this.buildArgs(input.lastMessagePath, input.model, input.effort, input.serviceTier, input.serviceTierMode, input.codexProfile, input.images);
    this.logger.info(
      { component: "subagents", event: "start", backend: this.kind, jobId: input.job.id, profile: input.job.profile, args },
      "starting subagent"
    );
    const safeEnv = sanitizeCodexChildProcessEnv(this.config);
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true
    });
    this.children.set(input.job.id, child);
    if (child.pid) {
      input.job.pid = child.pid;
      input.job.pgid = child.pid;
      input.job.transport = "stdio";
    }
    child.stdin?.end(input.assembledPrompt);
    child.stdout?.on("data", (chunk) => appendFile(input.stdoutPath, chunk).catch((error) => {
      this.logger.error({ component: "subagents", jobId: input.job.id, error });
    }));
    child.stderr?.on("data", (chunk) => appendFile(input.stderrPath, chunk).catch((error) => {
      this.logger.error({ component: "subagents", jobId: input.job.id, error });
    }));

    const finished = new Promise<ChildAgentFinish>((resolve) => {
      let settled = false;
      const settle = (finish: ChildAgentFinish): void => {
        if (settled) return;
        settled = true;
        this.children.delete(input.job.id);
        resolve(finish);
      };
      child.on("error", (error) => {
        settle({ code: null, signal: null, error: error instanceof Error ? error.message : String(error) });
      });
      child.on("exit", (code, signal) => {
        settle({ code, signal: signal ?? null });
      });
    });

    return {
      kind: this.kind,
      finished,
      kill: async (signal: NodeJS.Signals = "SIGTERM") => {
        killProcessTree(child, signal);
      },
      isAlive: () => child.exitCode === null && ((child as ChildProcess & { signalCode?: NodeJS.Signals | null }).signalCode ?? null) === null
    };
  }

  async steer(jobId: string): Promise<void> {
    throw new Error(`Subagent ${jobId} was launched with backend=codex_exec and is not steerable.`);
  }

  async interrupt(jobId: string): Promise<void> {
    await this.kill(jobId, "SIGTERM");
  }

  async kill(jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.children.get(jobId);
    if (child) killProcessTree(child, signal);
  }

  async shutdown(): Promise<void> {
    for (const jobId of this.children.keys()) await this.kill(jobId, "SIGTERM");
  }

  private buildArgs(lastMessagePath: string, model?: string, effort?: string, serviceTier: ServiceTier = "fast", serviceTierMode: ServiceTierMode = "auto", codexProfile = "", images: string[] = []): string[] {
    const args = [
      "exec",
      "--json",
      "--output-last-message",
      lastMessagePath,
      "--skip-git-repo-check",
      "--cd",
      this.config.service.workspace,
      "--sandbox",
      this.config.codex.sandbox,
      "-c",
      `ask_for_approval="${this.config.codex.approvalPolicy}"`
    ];
    for (const item of this.config.codex.extraConfig ?? []) {
      if (/^\s*model_reasoning_effort\s*=/.test(item)) continue;
      args.push("-c", item);
    }
    args.push("-c", `model_reasoning_effort="${effort}"`);
    if (serviceTierMode !== "omit" && serviceTier === "fast") args.push("-c", "features.fast_mode=true", "-c", `service_tier="fast"`);
    if (model) args.push("--model", model);
    if (codexProfile) args.push("--profile", codexProfile);
    for (const image of images) args.push("--image", image);
    args.push("-");
    return args;
  }
}

export class CodexAppServerChildAgentBackend implements ChildAgentBackend {
  readonly kind = "codex_app_server" as const;
  private readonly sessions = new Map<string, ChildAppServerSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async start(input: StartChildAgentInput): Promise<StartedChildAgent> {
    const session = new ChildAppServerSession(this.config, this.logger, input);
    this.sessions.set(input.job.id, session);
    try {
      const started = await session.start();
      void started.finished.finally(() => this.sessions.delete(input.job.id));
      return started;
    } catch (error) {
      this.sessions.delete(input.job.id);
      await session.kill("SIGTERM").catch(() => undefined);
      throw error;
    }
  }

  async steer(jobId: string, text: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) throw new Error(`Subagent ${jobId} has no active app-server child session.`);
    await session.steer(text);
  }

  async interrupt(jobId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    await session.interrupt(reason);
  }

  async kill(jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const session = this.sessions.get(jobId);
    if (session) await session.kill(signal);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.kill("SIGTERM").catch(() => undefined)));
  }
}

export class ClaudeAgentSdkChildAgentBackend implements ChildAgentBackend {
  readonly kind = "claude_agent_sdk" as const;
  private readonly sessions = new Map<string, ClaudeAgentSdkSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async start(input: StartChildAgentInput): Promise<StartedChildAgent> {
    const session = new ClaudeAgentSdkSession(this.config, this.logger, input);
    this.sessions.set(input.job.id, session);
    try {
      const started = await session.start();
      void started.finished.finally(() => this.sessions.delete(input.job.id));
      return started;
    } catch (error) {
      this.sessions.delete(input.job.id);
      await session.kill("SIGTERM").catch(() => undefined);
      throw error;
    }
  }

  async steer(jobId: string, text: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) throw new Error(`Subagent ${jobId} has no active Claude Agent SDK session.`);
    await session.steer(text);
  }

  async interrupt(jobId: string, reason?: string): Promise<void> {
    const session = this.sessions.get(jobId);
    if (!session) return;
    await session.interrupt(reason);
  }

  async kill(jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const session = this.sessions.get(jobId);
    if (session) await session.kill(signal);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.kill("SIGTERM").catch(() => undefined)));
  }
}

type ClaudeAccountSummary = {
  apiProvider?: string;
  apiKeySource?: string;
  tokenSource?: string;
  subscriptionType?: string;
  emailPresent: boolean;
  organizationPresent: boolean;
};

class ClaudeAgentSdkSession {
  private readonly queue = new AsyncUserMessageQueue();
  private query?: ClaudeAgentSdkQuery;
  private closed = false;
  private stopping = false;
  private settled = false;
  /**
   * User turns pushed to the SDK that have not yet produced a result message.
   * In streaming-input mode the SDK emits one result per turn, so a steer
   * queued mid-turn means the first result is not the end of the job — settle
   * only when every pushed turn has resolved.
   */
  private pendingUserTurns = 0;
  /**
   * Armed when a turn result arrives while steers are still outstanding. A
   * steer pushed mid-run may be absorbed into that run (one combined result,
   * nothing more coming) or start a separate turn (more messages coming). If
   * the SDK stays silent for the grace window, the recorded result is final;
   * any further SDK activity cancels the timer and we wait for the next
   * result instead.
   */
  private settleGraceTimer?: NodeJS.Timeout;
  /**
   * Bumped on every SDK message. settleFromGrace snapshots it before its
   * awaits and aborts if it moved — SDK activity arriving after the timer has
   * fired (but before the settle completes) means a steered turn is live and
   * must not be killed by a stale grace-settle.
   */
  private sdkActivityGeneration = 0;
  private assistantText = "";
  private partialText = "";
  private finalMessage = "";
  private killSignal: NodeJS.Signals | null = null;
  private oauthInitializationVerified = false;
  private resolveFinished!: (finish: ChildAgentFinish) => void;
  private redactionEnv: ChildEnvSource = {};
  private readonly finishedPromise = new Promise<ChildAgentFinish>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly input: StartChildAgentInput
  ) {}

  async start(): Promise<StartedChildAgent> {
    const ready = await this.checkReadiness();
    this.redactionEnv = ready.safeEnv;
    const options = this.buildOptions(ready.safeEnv);
    await this.appendEvent({
      event: "claude_launch_config",
      at: nowIso(),
      backend: "claude_agent_sdk",
      model: this.input.model || undefined,
      effort: this.input.effort,
      serviceTier: this.input.serviceTier,
      serviceTierMode: this.input.serviceTierMode,
      serviceTierIgnored: true,
      fastModeSettingApplied: this.shouldApplyFastMode(),
      oauthEnvPresent: ready.oauthEnvPresent,
      credentialFiles: ready.credentialFiles,
      strippedNonOAuthEnv: ready.strippedNonOAuthEnv,
      settingSources: claudeSubagentConfig(this.config).settingSources
    });

    const query = queryClaudeAgentSdk({ prompt: this.queue, options });
    this.query = query;
    this.input.job.transport = "stdio";

    void this.consumeQuery(query);
    await this.verifyOAuthInitialization(query);

    this.input.job.activeTurnId = CLAUDE_SYNTHETIC_ACTIVE_TURN_ID;
    await this.input.onJobUpdated(this.input.job);
    this.pendingUserTurns += 1;
    this.queue.push(await this.buildUserMessage(this.input.assembledPrompt, this.input.images));

    return {
      kind: "claude_agent_sdk",
      finished: this.finishedPromise,
      kill: (signal: NodeJS.Signals = "SIGTERM") => this.kill(signal),
      isAlive: () => this.isAlive()
    };
  }

  async steer(text: string): Promise<void> {
    if (!this.query || this.closed || !this.queue.isOpen() || !this.input.job.activeTurnId) {
      throw new Error(`Subagent ${this.input.job.id} is not currently steerable; Claude Agent SDK input stream is not accepting messages.`);
    }
    this.clearSettleGraceTimer();
    this.pendingUserTurns += 1;
    this.queue.push(await this.buildUserMessage(text, []));
    await this.appendEvent({ event: "claude_steer_enqueued", at: nowIso(), backend: "claude_agent_sdk", jobId: this.input.job.id, pendingUserTurns: this.pendingUserTurns });
  }

  async interrupt(reason?: string): Promise<void> {
    if (!this.query || this.closed) {
      await this.kill("SIGTERM");
      return;
    }
    this.stopping = true;
    this.killSignal = "SIGTERM";
    this.clearSettleGraceTimer();
    this.input.job.activeTurnId = undefined;
    this.queue.close();
    await this.appendEvent({ event: "claude_interrupt_requested", at: nowIso(), backend: "claude_agent_sdk", jobId: this.input.job.id, reason });
    try {
      await this.query.interrupt();
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "claude_interrupt_failed", jobId: this.input.job.id, error }, "Claude Agent SDK interrupt failed; closing query");
      this.query.close();
    }
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.stopping = true;
    this.closed = true;
    this.clearSettleGraceTimer();
    this.killSignal = signal;
    this.input.job.activeTurnId = undefined;
    this.queue.close();
    this.query?.close();
  }

  isAlive(): boolean {
    return !this.closed && !this.settled;
  }

  private async checkReadiness(): Promise<{
    safeEnv: NodeJS.ProcessEnv;
    oauthEnvPresent: boolean;
    credentialFiles: Array<{ path: string; exists: boolean }>;
    strippedNonOAuthEnv: string[];
  }> {
    const cfg = claudeSubagentConfig(this.config);
    const safeEnv = sanitizeClaudeAgentSdkChildProcessEnv(this.config);
    const credentialFiles = await this.credentialFiles(safeEnv);
    const oauthEnvPresent = Boolean(safeEnv.CLAUDE_CODE_OAUTH_TOKEN);
    const strippedNonOAuthEnv = this.strippedNonOAuthEnvNames(safeEnv);
    const readiness = {
      event: "claude_readiness",
      at: nowIso(),
      backend: "claude_agent_sdk",
      enabled: cfg.enabled,
      oauthEnvPresent,
      credentialFiles,
      strippedNonOAuthEnv
    };
    await this.appendEvent(readiness);
    if (!cfg.enabled) {
      const error = "Claude Agent SDK backend is disabled. Set [subagents.claude].enabled = true after configuring Claude subscription OAuth.";
      await this.appendEvent({ ...readiness, event: "claude_readiness_failed", error });
      throw new Error(error);
    }
    if (!oauthEnvPresent && !credentialFiles.some((candidate) => candidate.exists)) {
      const error = "Claude Agent SDK backend requires subscription OAuth: run `claude auth login` or provide CLAUDE_CODE_OAUTH_TOKEN.";
      await this.appendEvent({ ...readiness, event: "claude_readiness_failed", error });
      throw new Error(error);
    }
    const leaked = CLAUDE_NON_OAUTH_AUTH_ENV.filter((name) => safeEnv[name]);
    if (leaked.length > 0) {
      const error = `Claude Agent SDK sanitized environment still contains non-OAuth auth variables: ${leaked.join(", ")}`;
      await this.appendEvent({ ...readiness, event: "claude_readiness_failed", error });
      throw new Error(error);
    }
    return { safeEnv, oauthEnvPresent, credentialFiles, strippedNonOAuthEnv };
  }

  private async credentialFiles(env: NodeJS.ProcessEnv): Promise<Array<{ path: string; exists: boolean }>> {
    const configuredDir = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR;
    const configDir = configuredDir || join(homedir(), ".claude");
    return [{ path: join(configDir, ".credentials.json"), exists: await pathExists(join(configDir, ".credentials.json")) }];
  }

  private strippedNonOAuthEnvNames(safeEnv: NodeJS.ProcessEnv): string[] {
    const stripped = new Set<string>();
    for (const name of CLAUDE_NON_OAUTH_AUTH_ENV) {
      if (process.env[name] && !safeEnv[name]) stripped.add(name);
    }
    for (const name of this.config.codex.providerApiKeyEnvNames ?? []) {
      const trimmed = name.trim();
      if (trimmed && process.env[trimmed] && !safeEnv[trimmed]) stripped.add(trimmed);
    }
    return [...stripped].sort();
  }

  private buildOptions(env: NodeJS.ProcessEnv): ClaudeAgentSdkOptions {
    const cfg = claudeSubagentConfig(this.config);
    const { effort, thinking } = this.claudeEffortAndThinking(this.input.effort);
    const settings = this.shouldApplyFastMode()
      ? { fastMode: true, fastModePerSessionOptIn: true }
      : undefined;
    const options: ClaudeAgentSdkOptions = {
      cwd: this.config.service.workspace,
      env: {
        ...env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "codex-chat/subagent"
      },
      permissionMode: cfg.permissionMode,
      allowDangerouslySkipPermissions: cfg.permissionMode === "bypassPermissions" ? cfg.allowDangerouslySkipPermissions : undefined,
      tools: cfg.allowedTools,
      allowedTools: cfg.allowedTools,
      disallowedTools: cfg.disallowedTools,
      maxTurns: cfg.maxTurns,
      settingSources: cfg.settingSources,
      strictMcpConfig: true,
      includePartialMessages: true,
      settings,
      stderr: (data) => {
        void appendFile(this.input.stderrPath, this.redactSecrets(data), { mode: 0o600 }).catch((error) => {
          this.logger.error({ component: "subagents", event: "claude_stderr_write_failed", jobId: this.input.job.id, error });
        });
      },
      title: `codex-chat subagent ${this.input.job.id}`
    };
    if (cfg.pathToClaudeCodeExecutable.trim()) options.pathToClaudeCodeExecutable = cfg.pathToClaudeCodeExecutable.trim();
    if (this.input.model.trim()) options.model = this.input.model.trim();
    if (effort) options.effort = effort;
    if (thinking) options.thinking = thinking;
    return options;
  }

  private shouldApplyFastMode(): boolean {
    const cfg = claudeSubagentConfig(this.config);
    return cfg.fastMode && this.input.serviceTier === "fast" && this.input.serviceTierMode !== "omit" && claudeFastModeSupported(this.input.model);
  }

  private claudeEffortAndThinking(effort: string): { effort?: ClaudeEffortLevel; thinking?: ClaudeThinkingConfig } {
    if (effort === "none" || effort === "minimal") return { thinking: { type: "disabled" } };
    if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh") return { effort };
    throw new Error(`Unsupported Claude Agent SDK effort: ${effort}`);
  }

  private async verifyOAuthInitialization(query: ClaudeAgentSdkQuery): Promise<void> {
    const timeoutMs = Math.max(1, this.config.subagents.childStartupTimeoutSec ?? 60) * 1000;
    const initialized = await withTimeout(
      query.initializationResult(),
      timeoutMs,
      `Claude Agent SDK initialization did not complete within ${timeoutMs}ms. Check Claude OAuth login and network connectivity.`
    );
    const account = initialized.account ?? {};
    const summary = this.accountSummary(account);
    await this.appendEvent({
      event: "claude_initialized",
      at: nowIso(),
      backend: "claude_agent_sdk",
      account: summary,
      fastModeState: initialized.fast_mode_state
    });
    if (summary.apiProvider && summary.apiProvider !== "firstParty") {
      throw new Error(`Claude Agent SDK backend requires first-party subscription OAuth; SDK reported apiProvider=${summary.apiProvider}.`);
    }
    if (summary.apiKeySource && summary.apiKeySource !== "oauth" && summary.apiKeySource !== "none") {
      throw new Error(`Claude Agent SDK backend requires OAuth credentials; SDK reported apiKeySource=${summary.apiKeySource}.`);
    }
    this.oauthInitializationVerified = true;
  }

  private accountSummary(account: {
    apiProvider?: string;
    apiKeySource?: string;
    tokenSource?: string;
    subscriptionType?: string;
    email?: string;
    organization?: string;
  }): ClaudeAccountSummary {
    return {
      apiProvider: account.apiProvider,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
      subscriptionType: account.subscriptionType,
      emailPresent: Boolean(account.email),
      organizationPresent: Boolean(account.organization)
    };
  }

  private async consumeQuery(query: ClaudeAgentSdkQuery): Promise<void> {
    try {
      for await (const message of query) {
        await this.handleSdkMessage(message);
      }
      if (!this.settled) {
        if (this.stopping) {
          await this.writeFinalMessage(this.finalMessage || this.assistantText || this.partialText);
          this.settle({ code: null, signal: this.killSignal });
        } else {
          const final = this.finalMessage || this.assistantText || this.partialText;
          await this.writeFinalMessage(final);
          this.settle(final ? { code: 0, signal: null } : { code: 1, signal: null, error: "Claude Agent SDK query ended without a result message." });
        }
      }
    } catch (error) {
      const message = this.redactSecrets(error instanceof Error ? error.message : String(error));
      await this.appendEvent({ event: "claude_query_error", at: nowIso(), backend: "claude_agent_sdk", error: message });
      await this.writeFinalMessage(this.finalMessage || this.assistantText || this.partialText);
      this.settle({ code: this.stopping ? null : 1, signal: this.killSignal, error: this.stopping ? undefined : message });
    } finally {
      this.closed = true;
      this.input.job.activeTurnId = undefined;
      this.queue.close();
      await this.input.onJobUpdated(this.input.job).catch(() => undefined);
    }
  }

  private async handleSdkMessage(message: ClaudeSdkMessage): Promise<void> {
    // Any SDK activity after a deferred result means the steered turn really
    // is running as a separate turn — wait for its result instead of the
    // grace timer. The generation bump also aborts an in-flight
    // settleFromGrace whose timer already fired.
    this.sdkActivityGeneration += 1;
    this.clearSettleGraceTimer();
    await this.appendEvent({ event: "claude_sdk_message", at: nowIso(), backend: "claude_agent_sdk", raw: message });
    if (message.type === "system" && message.subtype === "init") {
      const apiKeySource = typeof message.apiKeySource === "string" ? message.apiKeySource : "";
      if ((apiKeySource && apiKeySource !== "oauth" && apiKeySource !== "none") || !this.oauthInitializationVerified) {
        const error = `Claude Agent SDK backend requires OAuth credentials; SDK init reported apiKeySource=${message.apiKeySource}.`;
        this.query?.close();
        throw new Error(error);
      }
      this.input.job.backendThreadId = message.session_id;
      if (!this.stopping) this.input.job.activeTurnId = CLAUDE_SYNTHETIC_ACTIVE_TURN_ID;
      await this.input.onJobUpdated(this.input.job);
      return;
    }
    if (message.type === "assistant") {
      this.assistantText += extractClaudeAssistantText(message);
      if (message.error) this.input.job.error = `Claude assistant error: ${message.error}`;
      return;
    }
    if (message.type === "stream_event") {
      this.partialText += extractClaudeStreamDelta(message);
      return;
    }
    if (message.type === "result") {
      this.pendingUserTurns = Math.max(0, this.pendingUserTurns - 1);
      if (message.subtype === "success") {
        this.finalMessage = message.result || this.assistantText || this.partialText;
        if (this.pendingUserTurns > 0 && !this.stopping) {
          // A steer is still outstanding. Either it was absorbed into the run
          // that just produced this result (no further messages coming — the
          // grace timer settles with this result), or it will run as a
          // separate turn (its messages cancel the timer and we settle on its
          // result instead). Keep the session open either way.
          await this.appendEvent({
            event: "claude_turn_result_deferred",
            at: nowIso(),
            backend: "claude_agent_sdk",
            jobId: this.input.job.id,
            pendingUserTurns: this.pendingUserTurns,
            settleGraceMs: claudeSubagentConfig(this.config).steerSettleGraceMs
          });
          this.armSettleGraceTimer();
          return;
        }
        this.input.job.activeTurnId = undefined;
        await this.writeFinalMessage(this.finalMessage);
        this.settle({ code: 0, signal: null });
      } else {
        this.input.job.activeTurnId = undefined;
        const resultErrors = Array.isArray(message.errors) ? message.errors : [];
        const errors = resultErrors.length > 0 ? resultErrors.join("; ") : message.subtype;
        const final = this.assistantText || this.partialText;
        await this.writeFinalMessage(final);
        this.input.job.error = errors;
        this.settle({ code: 1, signal: null, error: errors });
      }
      this.queue.close();
      this.query?.close();
    }
  }

  private async buildUserMessage(text: string, images: string[]): Promise<ClaudeSdkUserMessage> {
    const content: Array<Record<string, unknown>> = [{ type: "text", text }];
    for (const image of images) {
      const mediaType = imageMediaType(image);
      if (!mediaType) {
        content.push({ type: "text", text: `\n\n[Attached image path: ${image}]` });
        continue;
      }
      try {
        const data = (await readFile(image)).toString("base64");
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
      } catch {
        content.push({ type: "text", text: `\n\n[Attached image path unreadable by parent; try reading locally if needed: ${image}]` });
      }
    }
    return {
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
      timestamp: nowIso()
    };
  }

  private async writeFinalMessage(value: string): Promise<void> {
    await writeFile(this.input.lastMessagePath, value, { mode: 0o600 }).catch((error) => {
      this.logger.error({ component: "subagents", event: "claude_last_message_write_failed", jobId: this.input.job.id, error });
      this.input.job.error = error instanceof Error ? error.message : String(error);
    });
  }

  private async appendEvent(value: unknown): Promise<void> {
    await appendFile(this.input.stdoutPath, `${this.redactSecrets(JSON.stringify(value))}\n`, { mode: 0o600 }).catch((error) => {
      this.logger.error({ component: "subagents", event: "claude_event_write_failed", jobId: this.input.job.id, error });
    });
  }

  private redactSecrets(value: string): string {
    const env = { ...process.env, ...this.redactionEnv };
    const secretNames = new Set<string>([
      ...CLAUDE_OAUTH_CHILD_ENV,
      ...CLAUDE_NON_OAUTH_AUTH_ENV,
      ...(this.config.codex.providerApiKeyEnvNames ?? [])
    ]);
    let result = value;
    for (const name of secretNames) {
      const secret = env[name]?.trim();
      if (secret && secret.length >= 4) result = result.split(secret).join(`[REDACTED:${name}]`);
    }
    return result;
  }

  private settle(finish: ChildAgentFinish): void {
    if (this.settled) return;
    this.settled = true;
    this.closed = true;
    this.clearSettleGraceTimer();
    this.input.job.activeTurnId = undefined;
    this.resolveFinished(finish);
  }

  private armSettleGraceTimer(): void {
    this.clearSettleGraceTimer();
    const graceMs = claudeSubagentConfig(this.config).steerSettleGraceMs;
    this.settleGraceTimer = setTimeout(() => {
      this.settleGraceTimer = undefined;
      void this.settleFromGrace();
    }, graceMs);
    this.settleGraceTimer.unref?.();
  }

  private clearSettleGraceTimer(): void {
    if (!this.settleGraceTimer) return;
    clearTimeout(this.settleGraceTimer);
    this.settleGraceTimer = undefined;
  }

  /**
   * The SDK went quiet after a deferred result: the outstanding steer was
   * absorbed into the run that produced it, so that result is the final one.
   */
  private async settleFromGrace(): Promise<void> {
    if (this.settled || this.closed) return;
    const generation = this.sdkActivityGeneration;
    const abandoned = (): boolean => this.settled || this.closed || this.sdkActivityGeneration !== generation;
    await this.appendEvent({
      event: "claude_steer_settle_grace_elapsed",
      at: nowIso(),
      backend: "claude_agent_sdk",
      jobId: this.input.job.id,
      pendingUserTurns: this.pendingUserTurns
    }).catch(() => undefined);
    if (abandoned()) return;
    await this.writeFinalMessage(this.finalMessage || this.assistantText || this.partialText).catch(() => undefined);
    if (abandoned()) return;
    this.pendingUserTurns = 0;
    this.input.job.activeTurnId = undefined;
    this.settle({ code: 0, signal: null });
    this.queue.close();
    this.query?.close();
    await this.input.onJobUpdated(this.input.job).catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function extractClaudeAssistantText(message: Extract<ClaudeSdkMessage, { type: "assistant" }>): string {
  const content = message.message.content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

function extractClaudeStreamDelta(message: Extract<ClaudeSdkMessage, { type: "stream_event" }>): string {
  const event = message.event as unknown;
  if (!event || typeof event !== "object") return "";
  const record = event as Record<string, unknown>;
  if (record.type !== "content_block_delta" || !record.delta || typeof record.delta !== "object") return "";
  const delta = record.delta as Record<string, unknown>;
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function imageMediaType(path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

class ChildAppServerSession {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private requestId = 1;
  private threadId = "";
  private activeTurnId = "";
  private accumulated = "";
  private pendingOutput = "";
  private connected = false;
  private stopping = false;
  private turnCompleted = false;
  private settled = false;
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private resolveFinished!: (finish: ChildAgentFinish) => void;
  private readonly finishedPromise = new Promise<ChildAgentFinish>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly input: StartChildAgentInput
  ) {}

  async start(): Promise<StartedChildAgent> {
    await ensureDir(resolveConfigPath(this.config, this.config.subagents.childSocketDir));
    const port = await findFreePort();
    const listenUrl = `ws://127.0.0.1:${port}`;
    const args = ["app-server", "--listen", listenUrl];
    for (const item of this.config.codex.extraConfig ?? []) args.push("-c", item);
    if (this.input.codexProfile) {
      const profile = await loadCodexProfileConfig(this.input.codexProfile);
      for (const item of profile.appServerConfig) args.push("-c", item);
    }
    if (this.input.serviceTierMode !== "omit" && this.input.serviceTier === "fast") args.push("-c", "features.fast_mode=true", "-c", `service_tier="fast"`);
    this.logger.info(
      { component: "subagents", event: "start", backend: "codex_app_server", jobId: this.input.job.id, profile: this.input.job.profile, listenUrl, args },
      "starting app-server subagent"
    );

    const safeEnv = sanitizeCodexChildProcessEnv(this.config);
    const child = spawn(this.config.codex.binary, args, {
      cwd: this.config.service.workspace,
      env: safeEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    this.child = child;
    if (child.pid) {
      this.input.job.pid = child.pid;
      this.input.job.pgid = child.pid;
    }
    this.input.job.transport = "ws";
    this.input.job.socketPath = listenUrl;
    child.stdout?.on("data", (chunk) => {
      void appendFile(this.input.appServerLogPath, `[stdout] ${chunk.toString()}`).catch((error) => {
        this.logger.error({ component: "subagents", jobId: this.input.job.id, error });
      });
    });
    child.stderr?.on("data", (chunk) => {
      void appendFile(this.input.stderrPath, chunk).catch((error) => {
        this.logger.error({ component: "subagents", jobId: this.input.job.id, error });
      });
      void appendFile(this.input.appServerLogPath, `[stderr] ${chunk.toString()}`).catch(() => undefined);
    });
    child.on("exit", (code, signal) => {
      this.connected = false;
      const error = this.turnCompleted || this.stopping
        ? undefined
        : `codex app-server child exited before turn completed: code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.rejectAll(new Error(error ?? "codex app-server child exited"));
      this.settle({ code, signal: signal ?? null, error });
    });

    const startupExit = this.rejectOnStartupExit(child);
    const startupSequence = (async () => {
      await this.connectWithRetry(listenUrl);
      await this.request("initialize", {
        clientInfo: { name: "codex-chat-subagent", title: "codex-chat subagent", version: "0.1.0" },
        capabilities: { experimentalApi: true }
      });
      await this.startThreadAndTurn();
      await this.input.onJobUpdated(this.input.job);
    })();
    try {
      await Promise.race([startupSequence, startupExit.promise]);
      if (!this.isAlive()) throw new Error(this.formatStartupExitMessage(child.exitCode, this.childSignalCode(child)));
    } catch (error) {
      startupSequence.catch(() => undefined);
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      startupExit.cleanup();
    }

    return {
      kind: "codex_app_server",
      finished: this.finishedPromise,
      kill: (signal: NodeJS.Signals = "SIGTERM") => this.kill(signal),
      isAlive: () => this.isAlive()
    };
  }

  async steer(text: string): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      throw new Error(`Subagent ${this.input.job.id} is not currently steerable; no active app-server turn is known.`);
    }
    await this.request("turn/steer", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
      expectedTurnId: this.activeTurnId
    });
  }

  async interrupt(_reason?: string): Promise<void> {
    if (!this.threadId || !this.activeTurnId) {
      await this.kill("SIGTERM");
      return;
    }
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "interrupt_failed", jobId: this.input.job.id, error }, "app-server subagent interrupt failed; terminating child");
      await this.kill("SIGTERM");
    }
  }

  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.stopping = true;
    this.ws?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) return;
    const exited = once(child, "exit").then(() => undefined);
    killProcessTree(child, signal);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }

  isAlive(): boolean {
    if (!this.child) return false;
    return this.child.exitCode === null && this.childSignalCode(this.child) === null && !this.child.killed;
  }

  private rejectOnStartupExit(child: ChildProcess): { promise: Promise<never>; cleanup: () => void } {
    let cleanup = (): void => undefined;
    const promise = new Promise<never>((_resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.child !== child || this.stopping) return;
        reject(new Error(this.formatStartupExitMessage(code, signal)));
      };
      child.once("exit", onExit);
      cleanup = () => child.off("exit", onExit);
    });
    return { promise, cleanup };
  }

  private formatStartupExitMessage(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string {
    return `Codex app-server subagent child exited during startup: code=${code ?? "null"} signal=${signal ?? "null"}`;
  }

  private childSignalCode(child: ChildProcess): NodeJS.Signals | null {
    return (child as ChildProcess & { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
  }

  private async startThreadAndTurn(): Promise<void> {
    const threadResponse = await this.request<Record<string, unknown>>("thread/start", {
      ...this.threadModelParams(),
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      sandbox: this.config.codex.sandbox,
      config: this.threadConfig(),
      serviceName: "codex-chat-subagent",
      baseInstructions: "You are a codex-chat child subagent. Follow the task, context, and output contract supplied in the turn.",
      developerInstructions: "You are a codex-chat child subagent. Return the concise final answer expected by codex-chat.",
      ephemeral: true
    });
    const thread = threadResponse.thread as Record<string, unknown> | undefined;
    this.threadId = typeof thread?.id === "string" ? thread.id : "";
    if (!this.threadId) throw new Error("Codex app-server child did not return a thread id");
    this.input.job.backendThreadId = this.threadId;

    const userInput: unknown[] = [{ type: "text", text: this.input.assembledPrompt, text_elements: [] }];
    for (const image of this.input.images) userInput.push({ type: "localImage", path: image });
    const turnResponse = await this.request<Record<string, unknown>>("turn/start", this.turnStartParams(userInput));
    const turn = turnResponse.turn as Record<string, unknown> | undefined;
    this.activeTurnId = typeof turn?.id === "string" ? turn.id : "";
    if (!this.activeTurnId) throw new Error("Codex app-server child did not return a turn id");
    this.input.job.activeTurnId = this.activeTurnId;
    await this.appendEvent({ event: "turn_started", threadId: this.threadId, turnId: this.activeTurnId, at: nowIso() });
  }


  private threadModelParams(): Record<string, unknown> {
    const params: Record<string, unknown> = { model: this.input.model };
    if (this.input.modelProvider) params.modelProvider = this.input.modelProvider;
    if (this.input.serviceTierMode !== "omit") params.serviceTier = this.input.serviceTier;
    return params;
  }

  private turnStartParams(userInput: unknown[]): Record<string, unknown> {
    const params: Record<string, unknown> = {
      threadId: this.threadId,
      input: userInput,
      cwd: this.config.service.workspace,
      approvalPolicy: this.config.codex.approvalPolicy,
      model: this.input.model,
      effort: this.input.effort
    };
    if (this.input.serviceTierMode !== "omit") params.serviceTier = this.input.serviceTier;
    return params;
  }

  private threadConfig(): Record<string, unknown> {
    const cfg: Record<string, unknown> = { model_reasoning_effort: this.input.effort };
    const addDirs = this.config.codex.addDirs ?? [];
    if (addDirs.length > 0) cfg.sandbox_workspace_write = { writable_roots: addDirs };
    return cfg;
  }

  private async connectWithRetry(url: string): Promise<void> {
    const deadline = Date.now() + (this.config.subagents.childStartupTimeoutSec ?? 60) * 1000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.connect(url);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async connect(url: string): Promise<void> {
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.handleMessage(data.toString());
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      const wasConnected = this.connected;
      this.connected = false;
      if (!wasConnected) return;
      if (!this.stopping && !this.turnCompleted) {
        const error = new Error("codex app-server child websocket closed before turn completed");
        this.rejectAll(error);
        this.settle({ code: null, signal: null, error: error.message });
      }
    });
    ws.on("error", (error) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.logger.debug({ component: "subagents", event: "child_ws_error", jobId: this.input.job.id, error });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${url}`)), 2_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    this.connected = true;
  }

  private handleMessage(raw: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch (error) {
      this.logger.warn({ component: "subagents", event: "invalid_child_ws_message", jobId: this.input.job.id, raw, error });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending) clearTimeout(pending.timer);
      if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
      else pending?.resolve(message.result);
      return;
    }
    void this.appendEvent(message);
    if (!message.method || typeof message.params !== "object" || message.params === null) return;
    const params = message.params as Record<string, unknown>;
    if (message.method === "item/agentMessage/delta" && params.turnId === this.activeTurnId && typeof params.delta === "string") {
      this.handleAgentMessageDelta(params.delta);
    }
    if (message.method === "turn/completed" && typeof params.turn === "object" && params.turn !== null) {
      const turn = params.turn as Record<string, unknown>;
      if (turn.id !== this.activeTurnId) return;
      this.turnCompleted = true;
      this.flushPendingOutput();
      this.input.job.activeTurnId = undefined;
      const status = typeof turn.status === "string" ? turn.status : "completed";
      const turnError = turn.error && typeof turn.error === "object" ? turn.error as Record<string, unknown> : undefined;
      if (status === "failed") {
        this.input.job.error = typeof turnError?.message === "string" ? turnError.message : "Codex app-server child turn failed.";
      }
      const finalMessage = this.accumulated;
      const finishError = status === "failed" ? this.input.job.error : undefined;
      void writeFile(this.input.lastMessagePath, finalMessage, { mode: 0o600 })
        .catch((error) => {
          this.logger.error({ component: "subagents", event: "last_message_write_failed", jobId: this.input.job.id, error });
          this.input.job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          void this.input.onJobUpdated(this.input.job).catch(() => undefined);
          this.settle({ code: 0, signal: null, error: finishError });
          void this.kill("SIGTERM").catch(() => undefined);
        });
    }
    if (message.method === "error") {
      const detail = JSON.stringify(params);
      this.logger.warn({ component: "subagents", event: "child_turn_error", jobId: this.input.job.id, detail }, "app-server subagent emitted error");
    }
  }

  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server child is not connected");
    }
    const id = this.requestId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = (this.config.subagents.childStartupTimeoutSec ?? 60) * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server child request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private settle(finish: ChildAgentFinish): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFinished(finish);
  }

  private handleAgentMessageDelta(delta: string): void {
    this.pendingOutput += delta;
    let newlineIndex = this.pendingOutput.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const newlineLength = this.pendingOutput[newlineIndex] === "\r" && this.pendingOutput[newlineIndex + 1] === "\n" ? 2 : 1;
      const lineWithNewline = this.pendingOutput.slice(0, newlineIndex + newlineLength);
      this.pendingOutput = this.pendingOutput.slice(newlineIndex + newlineLength);
      this.handleCompleteOutputLine(lineWithNewline);
      newlineIndex = this.pendingOutput.search(/\r?\n/);
    }
  }

  private flushPendingOutput(): void {
    if (!this.pendingOutput) return;
    const pending = this.pendingOutput;
    this.pendingOutput = "";
    this.handleCompleteOutputLine(pending);
  }

  private handleCompleteOutputLine(line: string): void {
    this.accumulated += line;
  }

  private async appendEvent(value: unknown): Promise<void> {
    await appendFile(this.input.stdoutPath, `${JSON.stringify(value)}\n`, { mode: 0o600 }).catch((error) => {
      this.logger.error({ component: "subagents", event: "child_event_write_failed", jobId: this.input.job.id, error });
    });
  }
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not allocate a local app-server child port");
  return port;
}
