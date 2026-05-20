import { join } from "node:path";
import type { Logger } from "pino";
import { resolveConfigPath, type AppConfig, type FactorDefinitionConfig } from "./config.js";
import type { FactorRuntimeClient, FactorThreadSpec } from "./factor-runtime.js";
import { StateStore } from "./state.js";
import type { FactorProposalAction, FactorRuntimeState, FactorStatus } from "./types.js";
import { ensureDir, nowIso, pathExists } from "./util.js";

const FACTOR_SCAFFOLD_MODE = "scaffold_only" as const;
const FACTOR_APP_SERVER_MODE = "app_server" as const;
const FACTOR_DIRECTORY_CONTRACT = [
  "AGENTS.md",
  "README.md",
  "factor.json",
  "state/current_state.md",
  "state/open_loops.md",
  "state/decisions.md",
  "state/runtime_briefing.md",
  "memory/",
  "procedures/",
  "logs/turns/",
  "logs/events/",
  "compacted/durable_facts.md",
  "compacted/weekly_summary.md",
  "scratch/"
] as const;

export type FactorCommand =
  | { isFactor: false }
  | { isFactor: true; action: "list" }
  | { isFactor: true; action: "status"; id: string }
  | { isFactor: true; action: "start" | "stop"; id: string }
  | { isFactor: true; action: "steer"; id: string; text: string };

export interface FactorDescriptor {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  globalEnabled: boolean;
  effectiveEnabled: boolean;
  directory: string;
  profile: string;
  model: string;
  effort: string;
  startup: "on_demand" | "always";
  warmupPrompt?: string;
  warmupFile?: string;
  gitRemote?: string;
  gitBranch: string;
  persistRawLogs: boolean;
  compactAfterTask: boolean;
  memory: FactorDefinitionConfig["memory"];
  compaction: FactorDefinitionConfig["compaction"];
  capabilities: FactorDefinitionConfig["capabilities"];
  acl: FactorDefinitionConfig["acl"];
}

export interface FactorDirectoryValidation {
  id: string;
  directory: string;
  exists: boolean;
  missing: string[];
}

export type FactorResolution =
  | { status: "matched"; ref: string; factor: FactorDescriptor }
  | { status: "not_found"; ref: string }
  | { status: "ambiguous"; ref: string; candidates: FactorDescriptor[] };

export interface FactorProposalResult {
  status: "proposal" | "not_found" | "ambiguous" | "invalid";
  ref: string;
  message: string;
  factor?: FactorDescriptor;
  state?: FactorRuntimeState;
  candidates?: FactorDescriptor[];
}

export interface FactorActionResult {
  status: "started" | "resumed" | "stopped" | "steered" | "proposal" | "not_found" | "ambiguous" | "invalid" | "failed";
  ref: string;
  message: string;
  factor?: FactorDescriptor;
  state?: FactorRuntimeState;
  candidates?: FactorDescriptor[];
}

export interface FactorRuntimeSnapshotItem {
  id: string;
  name: string;
  status: FactorStatus;
  running: boolean;
  resumable: boolean;
  enabled: boolean;
  profile: string;
  model: string;
  effort: string;
  description?: string;
  backendThreadId?: string;
  lastError?: string;
}

export interface FactorRuntimeSnapshot {
  factors: FactorRuntimeSnapshotItem[];
  omitted: number;
}

export function parseFactorCommand(text: string): FactorCommand {
  const trimmed = text.trim();
  if (/^factors?$/i.test(trimmed) || /^factors?\s+list$/i.test(trimmed)) return { isFactor: true, action: "list" };

  const status = trimmed.match(/^factors?\s+status\s+(\S+)$/i);
  if (status) return { isFactor: true, action: "status", id: status[1] as string };

  const startStop = trimmed.match(/^factors?\s+(start|stop)\s+(\S+)$/i);
  if (startStop) return { isFactor: true, action: startStop[1]!.toLowerCase() as "start" | "stop", id: startStop[2] as string };

  const steer = trimmed.match(/^factors?\s+(?:steer|tell)\s+(\S+)\s+([\s\S]+)$/i);
  if (steer) return { isFactor: true, action: "steer", id: steer[1] as string, text: (steer[2] as string).trim() };

  return { isFactor: false };
}

export class FactorManager {
  private readonly states = new Map<string, FactorRuntimeState>();
  private readonly runningFactors = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly runtimeClient?: FactorRuntimeClient
  ) {}

  async init(): Promise<void> {
    const descriptors = this.listFactors();
    this.runningFactors.clear();
    for (const descriptor of descriptors) {
      const previous = await this.state.readFactorState(descriptor.id);
      const next = this.stateFromDescriptor(descriptor, previous);
      await this.state.saveFactorState(next);
      this.states.set(descriptor.id, next);
    }
    this.logger.info(
      { component: "factors", event: "init", count: descriptors.length, enabled: this.config.factors.enabled, runtimeMode: this.runtimeModeLabel() },
      "factor manager initialized"
    );
  }

  listFactors(): FactorDescriptor[] {
    return Object.entries(this.config.factors.definitions)
      .map(([id, definition]) => this.toDescriptor(id, definition))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  resolveFactorRef(ref: string): FactorResolution {
    const normalized = this.normalizeRef(ref);
    const factors = this.listFactors();
    const exact = factors.find((factor) => factor.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return { status: "matched", ref, factor: exact };
    const matches = factors.filter((factor) => factor.id.toLowerCase().startsWith(normalized.toLowerCase()));
    if (matches.length === 0) return { status: "not_found", ref };
    if (matches.length === 1 && matches[0]) return { status: "matched", ref, factor: matches[0] };
    return { status: "ambiguous", ref, candidates: matches };
  }

  async getFactorState(id: string): Promise<FactorRuntimeState | undefined> {
    return this.states.get(id) ?? this.state.readFactorState(id);
  }

  async validateDirectory(id: string): Promise<FactorDirectoryValidation> {
    const resolution = this.resolveFactorRef(id);
    if (resolution.status !== "matched") {
      return { id, directory: "", exists: false, missing: [...FACTOR_DIRECTORY_CONTRACT] };
    }
    const directory = resolution.factor.directory;
    const exists = await pathExists(directory);
    const missing: string[] = [];
    for (const rel of FACTOR_DIRECTORY_CONTRACT) {
      const probe = rel.endsWith("/") ? rel.slice(0, -1) : rel;
      if (!(await pathExists(join(directory, probe)))) missing.push(rel);
    }
    return { id: resolution.factor.id, directory, exists, missing };
  }

  async formatList(): Promise<string> {
    const factors = this.listFactors();
    const active = factors.filter((factor) => this.states.get(factor.id)?.status === "running").length;
    const lines = [
      `Factors: ${factors.length} configured, ${active} active, feature=${this.config.factors.enabled ? "enabled" : "disabled"}, runtime=${this.runtimeModeLabel()}, maxActive=${this.config.factors.maxActive}`
    ];
    if (factors.length === 0) {
      lines.push("No factors configured. Add [factors.<id>] tables to config/codex-chat.toml.");
      return lines.join("\n");
    }
    if (!this.config.factors.enabled) {
      lines.push("Feature flag is off: no Factor app-server runtimes will be started.");
    }
    for (const factor of factors) {
      const state = await this.getFactorState(factor.id);
      lines.push(this.formatListLine(factor, state));
    }
    return lines.join("\n");
  }

  async formatStatus(ref: string): Promise<string> {
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return `No factor matched "${ref}". Use "factors" to list configured factors.`;
    if (resolution.status === "ambiguous") return this.formatAmbiguous(ref, resolution.candidates);

    const factor = resolution.factor;
    const state = await this.getFactorState(factor.id) ?? this.stateFromDescriptor(factor);
    const validation = await this.validateDirectory(factor.id);
    const lines = [
      `Factor ${factor.id}${factor.name !== factor.id ? ` (${factor.name})` : ""}`,
      factor.description ? `description: ${factor.description}` : "",
      `status: ${state.status}`,
      `featureEnabled: ${factor.globalEnabled}`,
      `factorEnabled: ${factor.enabled}`,
      `runtime: ${state.runtimeMode}`,
      `running: ${state.status === "running"}`,
      `resumable: ${state.backendThreadId ? "yes" : "no"}`,
      state.backendThreadId ? `backendThreadId: ${state.backendThreadId}` : "",
      `directory: ${factor.directory}`,
      `profile: ${factor.profile}`,
      `model: ${factor.model}`,
      `effort: ${factor.effort}`,
      `startup: ${factor.startup}`,
      `warmup: ${this.formatWarmup(factor)}`,
      `memory: enabled=${factor.memory.enabled} persistRawLogs=${factor.memory.persistRawLogs}`,
      `compaction: compactAfterTask=${factor.compaction.compactAfterTask} interval=${factor.compaction.interval}`,
      `capabilities: allowed=${factor.capabilities.allowed.length} denied=${factor.capabilities.denied.length}`,
      `acl: telegramUsers=${factor.acl.telegramUserIds.length} admins=${factor.acl.adminUserIds.length}`,
      `git: remote=${factor.gitRemote || "none"} branch=${factor.gitBranch}`,
      `directoryContract: ${validation.exists ? "exists" : "missing directory"}; missing=${validation.missing.length}`
    ];
    if (state.lastProposal) {
      lines.push(`lastProposal: ${state.lastProposal.action} at ${state.lastProposal.proposedAt}${state.lastProposal.text ? ` text=${JSON.stringify(this.compact(state.lastProposal.text))}` : ""}`);
    }
    if (state.lastResumeError) lines.push(`lastResumeError: ${this.compact(state.lastResumeError, 240)}`);
    if (state.lastError) lines.push(`lastError: ${this.compact(state.lastError, 240)}`);
    if (validation.missing.length > 0) lines.push(`missingPaths: ${validation.missing.slice(0, 12).join(", ")}${validation.missing.length > 12 ? ", ..." : ""}`);
    lines.push("Safety: minimal Factor runtime only; no email/calendar/account/project mutations, rich tools, autonomous scheduling, or compaction are implemented.");
    return lines.filter(Boolean).join("\n");
  }

  async propose(action: FactorProposalAction, ref: string, text = "", proposedBy?: string): Promise<FactorProposalResult> {
    if (!["start", "stop", "steer", "warmup", "compact"].includes(action)) {
      return { status: "invalid", ref, message: `Unsupported factor proposal action: ${action}` };
    }
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No factor matched "${ref}".` };
    if (resolution.status === "ambiguous") {
      return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    }
    const factor = resolution.factor;
    if (action === "steer" && !text.trim()) {
      return { status: "invalid", ref, factor, message: "Factor steering text cannot be empty." };
    }

    const previous = await this.getFactorState(factor.id);
    const state = this.stateFromDescriptor(factor, previous);
    state.status = "proposal_pending";
    state.lastProposal = {
      action,
      text: text.trim() || undefined,
      proposedAt: nowIso(),
      proposedBy,
      reason: "Factor request was recorded as a proposal; no runtime/account mutation was executed for this request."
    };
    state.updatedAt = state.lastProposal.proposedAt;
    await this.saveRuntimeState(state);
    return {
      status: "proposal",
      ref,
      factor,
      state,
      message: this.formatProposalResult(action, factor, state)
    };
  }

  async handleCommand(command: Exclude<FactorCommand, { isFactor: false }>, proposedBy?: string): Promise<string> {
    if (command.action === "list") return this.formatList();
    if (command.action === "status") return this.formatStatus(command.id);
    if (command.action === "start") return (await this.startFactor(command.id, proposedBy)).message;
    if (command.action === "stop") return (await this.stopFactor(command.id, proposedBy)).message;
    if (command.action === "steer") return (await this.steerFactor(command.id, command.text, proposedBy)).message;
    return `Unsupported factor command: ${String((command as { action?: string }).action ?? "unknown")}`;
  }

  async recoverRuntimesOnStartup(): Promise<{ attempted: number; running: number; failed: number }> {
    let attempted = 0;
    let running = 0;
    let failed = 0;
    if (!this.runtimeClient || !this.config.factors.enabled) return { attempted, running, failed };
    for (const factor of this.listFactors()) {
      if (!factor.effectiveEnabled) continue;
      const state = await this.getFactorState(factor.id);
      const shouldRecover = factor.startup === "always" || state?.status === "running";
      if (!shouldRecover) continue;
      attempted++;
      const result = await this.startRuntime(factor, { requestedBy: "startup" });
      if (result.status === "started" || result.status === "resumed") running++;
      else failed++;
    }
    this.logger.info({ component: "factors", event: "startup_recovery", attempted, running, failed }, "factor runtime startup recovery complete");
    return { attempted, running, failed };
  }

  async startFactor(ref: string, requestedBy?: string): Promise<FactorActionResult> {
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No factor matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const factor = resolution.factor;
    if (!this.canRunRuntime(factor)) return this.proposalAction("start", ref, "", requestedBy, "Factor runtime is unavailable; proposal recorded.");
    return this.startRuntime(factor, { requestedBy });
  }

  async stopFactor(ref: string, requestedBy?: string): Promise<FactorActionResult> {
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No factor matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const factor = resolution.factor;
    if (!this.canRunRuntime(factor)) return this.proposalAction("stop", ref, "", requestedBy, "Factor runtime is unavailable; proposal recorded.");

    const previous = await this.getFactorState(factor.id);
    const state = this.stateFromDescriptor(factor, previous);
    state.status = "stopped";
    state.runtimeMode = state.backendThreadId ? FACTOR_APP_SERVER_MODE : FACTOR_SCAFFOLD_MODE;
    state.activeTurnId = undefined;
    state.stoppedAt = nowIso();
    state.updatedAt = state.stoppedAt;
    await this.saveRuntimeState(state);
    this.runningFactors.delete(factor.id);
    const resumable = state.backendThreadId ? ` Thread ${state.backendThreadId} remains resumable.` : "";
    return { status: "stopped", ref, factor, state, message: `Factor ${factor.id} stopped.${resumable}` };
  }

  async steerFactor(ref: string, text: string, requestedBy?: string): Promise<FactorActionResult> {
    const steeringText = text.trim();
    if (!steeringText) return { status: "invalid", ref, message: "Factor steering text cannot be empty." };
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No factor matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const factor = resolution.factor;
    if (!this.canRunRuntime(factor)) return this.proposalAction("steer", ref, steeringText, requestedBy, "Factor runtime is unavailable; proposal recorded.");

    const running = await this.ensureRuntimeRunning(factor, requestedBy);
    if (!running.state || !running.state.backendThreadId || (running.status !== "started" && running.status !== "resumed")) return running;
    const state = running.state;
    const backendThreadId = state.backendThreadId as string;
    if (state.activeTurnId) {
      return { status: "failed", ref, factor, state, message: `Factor ${factor.id} already has active turn ${state.activeTurnId}; wait for it to finish before steering again.` };
    }

    let output = "";
    let hadError = false;
    try {
      const spec = this.threadSpec(factor);
      for await (const event of this.runtimeClient!.sendFactorTurn({
        ...spec,
        backendThreadId,
        text: steeringText,
        onTurnStarted: async (turnId) => {
          state.activeTurnId = turnId;
          state.updatedAt = nowIso();
          await this.saveRuntimeState(state);
        }
      })) {
        if (event.type === "final") output = event.text;
        if (event.type === "error") {
          hadError = true;
          output += output ? `\n${event.message}` : event.message;
        }
      }
      state.activeTurnId = undefined;
      state.status = hadError ? "error" : "running";
      state.lastSteeredAt = nowIso();
      state.updatedAt = state.lastSteeredAt;
      if (hadError) state.lastError = output || "Factor turn emitted an error.";
      await this.saveRuntimeState(state);
      const body = output.trim() || "(Factor turn completed with no final output.)";
      return {
        status: hadError ? "failed" : "steered",
        ref,
        factor,
        state,
        message: `Factor ${factor.id} turn completed on thread ${state.backendThreadId}.${running.message.includes("Resume failed") ? `\n${running.message}` : ""}\n\n${body}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.activeTurnId = undefined;
      state.status = "error";
      state.lastError = message;
      state.updatedAt = nowIso();
      await this.saveRuntimeState(state);
      this.logger.warn({ component: "factors", event: "steer_failed", factorId: factor.id, error }, "factor turn failed");
      return { status: "failed", ref, factor, state, message: `Factor ${factor.id} turn failed: ${message}` };
    }
  }

  runtimeSnapshot(limit = 12): FactorRuntimeSnapshot {
    const factors = this.listFactors();
    const items = factors.slice(0, limit).map((factor) => {
      const state = this.states.get(factor.id) ?? this.stateFromDescriptor(factor);
      return {
        id: factor.id,
        name: factor.name,
        status: state.status,
        running: state.status === "running",
        resumable: Boolean(state.backendThreadId),
        enabled: factor.effectiveEnabled,
        profile: factor.profile,
        model: factor.model,
        effort: factor.effort,
        description: factor.description || undefined,
        backendThreadId: state.backendThreadId,
        lastError: state.lastError
      };
    });
    return { factors: items, omitted: Math.max(0, factors.length - limit) };
  }

  private toDescriptor(id: string, definition: FactorDefinitionConfig): FactorDescriptor {
    const directory = definition.directory || join(this.config.factors.rootDir, id);
    return {
      id,
      name: definition.name || id,
      description: definition.description || definition.purpose || definition.capabilities.notes || "",
      enabled: definition.enabled,
      globalEnabled: this.config.factors.enabled,
      effectiveEnabled: this.config.factors.enabled && definition.enabled,
      directory: resolveConfigPath(this.config, directory),
      profile: definition.profile || id,
      model: definition.model || this.config.factors.defaultModel || this.config.codex.model,
      effort: definition.effort ?? this.config.factors.defaultEffort,
      startup: definition.startup,
      warmupPrompt: definition.warmupPrompt || undefined,
      warmupFile: definition.warmupFile ? resolveConfigPath(this.config, definition.warmupFile) : undefined,
      gitRemote: definition.gitRemote || undefined,
      gitBranch: definition.gitBranch,
      persistRawLogs: definition.persistRawLogs,
      compactAfterTask: definition.compactAfterTask,
      memory: definition.memory,
      compaction: definition.compaction,
      capabilities: definition.capabilities,
      acl: definition.acl
    };
  }

  private canRunRuntime(factor: FactorDescriptor): boolean {
    return Boolean(this.runtimeClient && this.config.factors.enabled && factor.enabled && factor.effectiveEnabled);
  }

  private async proposalAction(action: FactorProposalAction, ref: string, text: string, proposedBy: string | undefined, fallbackMessage: string): Promise<FactorActionResult> {
    const proposal = await this.propose(action, ref, text, proposedBy);
    return {
      status: proposal.status === "proposal" ? "proposal" : proposal.status,
      ref,
      message: proposal.status === "proposal" ? `${fallbackMessage}\n${proposal.message}` : proposal.message,
      factor: proposal.factor,
      state: proposal.state,
      candidates: proposal.candidates
    };
  }

  private async ensureRuntimeRunning(factor: FactorDescriptor, requestedBy?: string): Promise<FactorActionResult> {
    const state = await this.getFactorState(factor.id);
    if (state?.status === "running" && state.backendThreadId && this.runningFactors.has(factor.id)) {
      return { status: "resumed", ref: factor.id, factor, state, message: `Factor ${factor.id} is already running on thread ${state.backendThreadId}.` };
    }
    return this.startRuntime(factor, { requestedBy });
  }

  private async startRuntime(factor: FactorDescriptor, options: { requestedBy?: string; forceNew?: boolean } = {}): Promise<FactorActionResult> {
    if (!this.runtimeClient) return this.proposalAction("start", factor.id, "", options.requestedBy, "Factor runtime client is not attached; proposal recorded.");
    if (!factor.effectiveEnabled) return this.proposalAction("start", factor.id, "", options.requestedBy, "Factor is not effectively enabled; proposal recorded.");

    const active = this.activeRuntimeCount(factor.id);
    if (!this.runningFactors.has(factor.id) && active >= this.config.factors.maxActive) {
      const previous = await this.getFactorState(factor.id);
      const state = this.stateFromDescriptor(factor, previous);
      state.status = "error";
      state.lastError = `Factor maxActive limit reached (${this.config.factors.maxActive}).`;
      state.updatedAt = nowIso();
      await this.saveRuntimeState(state);
      return { status: "failed", ref: factor.id, factor, state, message: state.lastError };
    }

    await ensureDir(factor.directory);
    const previous = await this.getFactorState(factor.id);
    const spec = this.threadSpec(factor);
    let threadId = options.forceNew ? undefined : previous?.backendThreadId;
    let status: "started" | "resumed" = threadId ? "resumed" : "started";
    let resumeFailure: string | undefined;

    if (threadId) {
      try {
        await this.runtimeClient.resumeFactorThread({ ...spec, backendThreadId: threadId });
      } catch (error) {
        resumeFailure = error instanceof Error ? error.message : String(error);
        this.logger.warn({ component: "factors", event: "resume_failed", factorId: factor.id, backendThreadId: threadId, error }, "factor thread resume failed; starting fresh");
        const started = await this.runtimeClient.startFactorThread(spec);
        threadId = started.backendThreadId;
        status = "started";
      }
    } else {
      const started = await this.runtimeClient.startFactorThread(spec);
      threadId = started.backendThreadId;
      status = "started";
    }

    const now = nowIso();
    const state = this.stateFromDescriptor(factor, previous);
    state.status = "running";
    state.runtimeMode = FACTOR_APP_SERVER_MODE;
    state.backendThreadId = threadId;
    state.activeTurnId = undefined;
    state.startedAt ??= now;
    if (status === "resumed") state.resumedAt = now;
    state.stoppedAt = undefined;
    state.updatedAt = now;
    if (resumeFailure) {
      state.lastResumeError = `Resume failed for ${previous?.backendThreadId}: ${resumeFailure}`;
      state.lastError = `${state.lastResumeError}; started fresh thread ${threadId}.`;
    } else {
      state.lastResumeError = undefined;
      if (state.lastError?.startsWith("Resume failed for ")) state.lastError = undefined;
    }
    await this.saveRuntimeState(state);
    this.runningFactors.add(factor.id);

    const verb = status === "resumed" ? "resumed" : "started";
    const message = [
      `Factor ${factor.id} ${verb} on app-server thread ${threadId}.`,
      resumeFailure ? `Resume failed for saved thread ${previous?.backendThreadId}: ${resumeFailure}; started fresh.` : "",
      `directory: ${factor.directory}`
    ].filter(Boolean).join("\n");
    return { status, ref: factor.id, factor, state, message };
  }

  private activeRuntimeCount(excludeId?: string): number {
    return this.listFactors().filter((factor) => factor.id !== excludeId && this.states.get(factor.id)?.status === "running").length;
  }

  private async saveRuntimeState(state: FactorRuntimeState): Promise<void> {
    this.states.set(state.id, state);
    await this.state.saveFactorState(state);
  }

  private threadSpec(factor: FactorDescriptor): FactorThreadSpec {
    return {
      id: factor.id,
      name: factor.name,
      description: factor.description,
      directory: factor.directory,
      profile: factor.profile,
      model: factor.model,
      effort: factor.effort,
      serviceName: `codex-chat-factor:${factor.id}`,
      baseInstructions: this.factorBaseInstructions(factor),
      developerInstructions: this.factorDeveloperInstructions(factor),
      persistRawLogs: factor.persistRawLogs
    };
  }

  private factorBaseInstructions(factor: FactorDescriptor): string {
    return [
      `You are the durable codex-chat Factor "${factor.name}" (id: ${factor.id}).`,
      factor.description ? `Purpose: ${factor.description}` : "",
      `Factor directory: ${factor.directory}`,
      "Operate as a minimal runtime scaffold. Keep work inside the Factor directory unless explicitly instructed otherwise.",
      "No rich tools, email/calendar account access, CRM/project mutations, compaction, or autonomous scheduling are implemented by this runtime."
    ].filter(Boolean).join("\n");
  }

  private factorDeveloperInstructions(factor: FactorDescriptor): string {
    return [
      "You are a durable codex-chat Factor running in a non-ephemeral Codex app-server thread.",
      `Profile: ${factor.profile}; model: ${factor.model}; effort: ${factor.effort}.`,
      "Answer steering/query turns concisely. If asked to perform unimplemented external-account or project mutations, explain that this Factor runtime is scaffold-only for those capabilities and ask for explicit implementation/review before mutating anything.",
      factor.warmupPrompt ? `Configured warmup prompt note: ${factor.warmupPrompt}` : "",
      factor.warmupFile ? `Configured warmup file path: ${factor.warmupFile}` : ""
    ].filter(Boolean).join("\n");
  }

  private runtimeModeLabel(): "scaffold_only" | "app_server" {
    return this.config.factors.enabled && this.runtimeClient ? FACTOR_APP_SERVER_MODE : FACTOR_SCAFFOLD_MODE;
  }

  private stateFromDescriptor(descriptor: FactorDescriptor, previous?: FactorRuntimeState): FactorRuntimeState {
    const baseStatus: FactorStatus = descriptor.effectiveEnabled ? "idle" : "disabled";
    const previousProposal = previous?.lastProposal;
    let status: FactorStatus = baseStatus;
    if (descriptor.effectiveEnabled) {
      if (previous?.status === "running" && previous.backendThreadId) status = "running";
      else if (previous?.status === "stopped" && previous.backendThreadId) status = "stopped";
      else if (previous?.status === "error") status = "error";
      else if (previousProposal) status = "proposal_pending";
    }
    return {
      id: descriptor.id,
      status,
      enabled: descriptor.effectiveEnabled,
      directory: descriptor.directory,
      profile: descriptor.profile,
      model: descriptor.model,
      effort: descriptor.effort,
      startup: descriptor.startup,
      updatedAt: nowIso(),
      runtimeMode: previous?.backendThreadId ? FACTOR_APP_SERVER_MODE : previous?.runtimeMode ?? FACTOR_SCAFFOLD_MODE,
      lastProposal: previousProposal,
      lastError: previous?.lastError,
      activeTurnId: undefined,
      backendThreadId: previous?.backendThreadId,
      startedAt: previous?.startedAt,
      stoppedAt: previous?.stoppedAt,
      resumedAt: previous?.resumedAt,
      lastSteeredAt: previous?.lastSteeredAt,
      lastResumeError: previous?.lastResumeError,
      pid: previous?.pid
    };
  }

  private formatListLine(factor: FactorDescriptor, state?: FactorRuntimeState): string {
    const status = state?.status ?? (factor.effectiveEnabled ? "idle" : "disabled");
    const enabled = factor.effectiveEnabled ? "enabled" : factor.enabled ? "blocked_by_global_flag" : "disabled";
    const warmup = this.formatWarmup(factor);
    const runtime = state?.runtimeMode ?? FACTOR_SCAFFOLD_MODE;
    const resumable = state?.backendThreadId ? "yes" : "no";
    const description = factor.description ? ` purpose=${JSON.stringify(this.compact(factor.description, 80))}` : "";
    return this.codeLine(`${factor.id} status=${status} runtime=${runtime} resumable=${resumable} enabled=${enabled} profile=${factor.profile} model=${factor.model} effort=${factor.effort} startup=${factor.startup} dir=${factor.directory} warmup=${warmup}${description}`);
  }

  private formatProposalResult(action: FactorProposalAction, factor: FactorDescriptor, state: FactorRuntimeState): string {
    const lines = [
      `Factor ${action} proposal recorded for ${factor.id} (${factor.name}).`,
      "No Factor runtime was started/stopped/steered for this request.",
      `state: ${state.status}`,
      `directory: ${factor.directory}`,
      this.runtimeClient ? "Reason: Factor is disabled or the requested action is proposal-only in this mode." : "Reason: no Factor runtime client is attached to this management surface."
    ];
    if (!factor.effectiveEnabled) lines.push(`Note: effective enabled=false (global=${factor.globalEnabled}, factor=${factor.enabled}).`);
    return lines.join("\n");
  }

  private formatAmbiguous(ref: string, candidates: FactorDescriptor[]): string {
    return [`Ambiguous factor ref "${ref}". Use a longer ref.`, ...candidates.map((factor) => `${factor.id} name=${factor.name} status=${factor.effectiveEnabled ? "idle" : "disabled"}`)].join("\n");
  }

  private formatWarmup(factor: FactorDescriptor): string {
    if (factor.warmupFile) return `file:${factor.warmupFile}`;
    if (factor.warmupPrompt) return "inline";
    return "none";
  }

  private codeLine(text: string): string {
    return `\`${text.replace(/[\r\n`]/g, " ")}\``;
  }

  private normalizeRef(ref: string): string {
    return ref.trim().replace(/^[[(<]+/, "").replace(/[\])>.,;:]+$/, "");
  }

  private compact(text: string, maxLength = 160): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
  }
}
