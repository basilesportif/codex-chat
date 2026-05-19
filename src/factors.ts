import { join } from "node:path";
import type { Logger } from "pino";
import { resolveConfigPath, type AppConfig, type FactorDefinitionConfig } from "./config.js";
import { StateStore } from "./state.js";
import type { FactorProposalAction, FactorRuntimeState, FactorStatus } from "./types.js";
import { nowIso, pathExists } from "./util.js";

const FACTOR_RUNTIME_MODE = "scaffold_only" as const;
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
  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    const descriptors = this.listFactors();
    for (const descriptor of descriptors) {
      const previous = await this.state.readFactorState(descriptor.id);
      const next = this.stateFromDescriptor(descriptor, previous);
      await this.state.saveFactorState(next);
    }
    this.logger.info(
      { component: "factors", event: "init", count: descriptors.length, enabled: this.config.factors.enabled, runtimeMode: FACTOR_RUNTIME_MODE },
      "factor scaffold initialized"
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
    return this.state.readFactorState(id);
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
    const active = 0;
    const lines = [
      `Factors: ${factors.length} configured, ${active} active, feature=${this.config.factors.enabled ? "enabled" : "disabled"}, runtime=${FACTOR_RUNTIME_MODE}, maxActive=${this.config.factors.maxActive}`
    ];
    if (factors.length === 0) {
      lines.push("No factors configured. Add [factors.<id>] tables to config/codex-chat.toml.");
      return lines.join("\n");
    }
    if (!this.config.factors.enabled) {
      lines.push("Feature flag is off: no Factor app-server runtimes will be started.");
    }
    for (const factor of factors) {
      const state = await this.state.readFactorState(factor.id);
      lines.push(this.formatListLine(factor, state));
    }
    return lines.join("\n");
  }

  async formatStatus(ref: string): Promise<string> {
    const resolution = this.resolveFactorRef(ref);
    if (resolution.status === "not_found") return `No factor matched "${ref}". Use "factors" to list configured factors.`;
    if (resolution.status === "ambiguous") return this.formatAmbiguous(ref, resolution.candidates);

    const factor = resolution.factor;
    const state = await this.state.readFactorState(factor.id) ?? this.stateFromDescriptor(factor);
    const validation = await this.validateDirectory(factor.id);
    const lines = [
      `Factor ${factor.id}${factor.name !== factor.id ? ` (${factor.name})` : ""}`,
      `status: ${state.status}`,
      `featureEnabled: ${factor.globalEnabled}`,
      `factorEnabled: ${factor.enabled}`,
      `runtime: ${state.runtimeMode}`,
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
    if (validation.missing.length > 0) lines.push(`missingPaths: ${validation.missing.slice(0, 12).join(", ")}${validation.missing.length > 12 ? ", ..." : ""}`);
    lines.push("Safety: scaffold only; no email/calendar/account/project mutations are implemented.");
    return lines.join("\n");
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

    const previous = await this.state.readFactorState(factor.id);
    const state = this.stateFromDescriptor(factor, previous);
    state.status = "proposal_pending";
    state.lastProposal = {
      action,
      text: text.trim() || undefined,
      proposedAt: nowIso(),
      proposedBy,
      reason: "Factor runtime is scaffold-only; proposal recorded and no runtime/account mutation was executed."
    };
    state.updatedAt = state.lastProposal.proposedAt;
    await this.state.saveFactorState(state);
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
    if (command.action === "start" || command.action === "stop") {
      return (await this.propose(command.action, command.id, "", proposedBy)).message;
    }
    if (command.action === "steer") return (await this.propose("steer", command.id, command.text, proposedBy)).message;
    return `Unsupported factor command: ${String((command as { action?: string }).action ?? "unknown")}`;
  }

  private toDescriptor(id: string, definition: FactorDefinitionConfig): FactorDescriptor {
    const directory = definition.directory || join(this.config.factors.rootDir, id);
    return {
      id,
      name: definition.name || id,
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

  private stateFromDescriptor(descriptor: FactorDescriptor, previous?: FactorRuntimeState): FactorRuntimeState {
    const baseStatus: FactorStatus = descriptor.effectiveEnabled ? "idle" : "disabled";
    const previousProposal = previous?.lastProposal;
    const status = previousProposal && descriptor.effectiveEnabled ? "proposal_pending" : baseStatus;
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
      runtimeMode: FACTOR_RUNTIME_MODE,
      lastProposal: previousProposal,
      lastError: previous?.lastError
    };
  }

  private formatListLine(factor: FactorDescriptor, state?: FactorRuntimeState): string {
    const status = state?.status ?? (factor.effectiveEnabled ? "idle" : "disabled");
    const enabled = factor.effectiveEnabled ? "enabled" : factor.enabled ? "blocked_by_global_flag" : "disabled";
    const warmup = this.formatWarmup(factor);
    return this.codeLine(`${factor.id} status=${status} enabled=${enabled} profile=${factor.profile} model=${factor.model} effort=${factor.effort} startup=${factor.startup} dir=${factor.directory} warmup=${warmup}`);
  }

  private formatProposalResult(action: FactorProposalAction, factor: FactorDescriptor, state: FactorRuntimeState): string {
    const lines = [
      `Factor ${action} proposal recorded for ${factor.id} (${factor.name}).`,
      "No Factor runtime was started/stopped/steered; scaffold mode is proposal-only.",
      `state: ${state.status}`,
      `directory: ${factor.directory}`,
      "Next step before deploy: review the proposal and implement the app-server Factor runtime separately."
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
