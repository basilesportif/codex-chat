import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { resolveConfigPath, type AppConfig, type EmployeeDefinitionConfig } from "./config.js";
import type { EmployeeRuntimeClient, EmployeeThreadSpec } from "./employee-runtime.js";
import { StateStore } from "./state.js";
import type { EmployeePendingChildResult, EmployeeProposalAction, EmployeeRuntimeState, EmployeeStatus, SubagentJob } from "./types.js";
import type { CancelJobResult, SteerJobResult, SubagentControlActor } from "./subagents.js";
import { collectFencedBlocks, stripRanges } from "./directives.js";
import { compactText, ensureDir, inlineCode, makeId, normalizeRef, nowIso, pathExists } from "./util.js";

const EMPLOYEE_SCAFFOLD_MODE = "scaffold_only" as const;
const EMPLOYEE_APP_SERVER_MODE = "app_server" as const;
const EMPLOYEE_DIRECTORY_CONTRACT = [
  "AGENTS.md",
  "README.md",
  "employee.json",
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

const employeeActionRequestIdSchema = z.string().min(1).optional();
const employeeEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]).optional();
const employeeServiceRequestSubagentAction = z.object({
  type: z.literal("request_subagent"),
  requestId: employeeActionRequestIdSchema,
  profile: z.string().min(1),
  prompt: z.string().min(1),
  summary: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: employeeEffortSchema,
  timeoutSec: z.number().int().positive().optional(),
  images: z.array(z.string()).optional()
});
const employeeServiceCancelSubagentAction = z.object({
  type: z.literal("cancel_subagent"),
  requestId: employeeActionRequestIdSchema,
  jobId: z.string().min(1),
  reason: z.string().min(1).optional()
});
const employeeServiceSteerSubagentAction = z.object({
  type: z.literal("steer_subagent"),
  requestId: employeeActionRequestIdSchema,
  jobId: z.string().min(1),
  text: z.string().min(1)
});
const employeeServiceActionSchema = z.discriminatedUnion("type", [
  employeeServiceRequestSubagentAction,
  employeeServiceCancelSubagentAction,
  employeeServiceSteerSubagentAction
]);
const employeeServiceEnvelopeSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).optional(),
  actions: z.array(employeeServiceActionSchema).min(1)
});

export type EmployeeServiceAction = z.infer<typeof employeeServiceActionSchema>;
export type EmployeeServiceEnvelope = z.infer<typeof employeeServiceEnvelopeSchema>;

export interface EmployeeSubagentRequest {
  employeeId: string;
  requestId: string;
  profile: string;
  prompt: string;
  summary?: string;
  model?: string;
  effort?: string;
  timeoutSec?: number;
  images?: string[];
  parentTurnId?: string;
}

export interface EmployeeServiceActionCallbacks {
  requestSubagent(input: EmployeeSubagentRequest): Promise<string>;
  cancelSubagent(ref: string, options: { reason?: string; actor: SubagentControlActor }): Promise<CancelJobResult>;
  steerSubagent(ref: string, text: string, options: { actor: SubagentControlActor }): Promise<SteerJobResult>;
  cancelOwnedActiveSubagents(employeeId: string, reason: string): Promise<CancelJobResult[]>;
  listSubagentJobs(): SubagentJob[];
}

export interface EmployeeChildJobSummary {
  total: number;
  active: number;
  queued: number;
  running: number;
  cancelling: number;
  terminal: number;
  refs: string[];
}

interface EmployeeServiceParseResult {
  cleanText: string;
  envelopes: EmployeeServiceEnvelope[];
  errors: string[];
}

export type EmployeeCommand =
  | { isEmployee: false }
  | { isEmployee: true; action: "list" }
  | { isEmployee: true; action: "status"; id: string }
  | { isEmployee: true; action: "start" | "stop"; id: string }
  | { isEmployee: true; action: "steer"; id: string; text: string };

type EmployeeCommandAction = Exclude<EmployeeCommand, { isEmployee: false }>["action"];
export const EMPLOYEE_COMMAND_ACTIONS = ["list", "status", "start", "stop", "steer"] as const satisfies readonly EmployeeCommandAction[];
type MissingEmployeeCommandAction = Exclude<EmployeeCommandAction, (typeof EMPLOYEE_COMMAND_ACTIONS)[number]>;
const _employeeCommandActionsAreExhaustive: Record<MissingEmployeeCommandAction, never> = {};

export interface EmployeeDescriptor {
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
  memory: EmployeeDefinitionConfig["memory"];
  compaction: EmployeeDefinitionConfig["compaction"];
  capabilities: EmployeeDefinitionConfig["capabilities"];
  acl: EmployeeDefinitionConfig["acl"];
}

export interface EmployeeDirectoryValidation {
  id: string;
  directory: string;
  exists: boolean;
  missing: string[];
}

export type EmployeeResolution =
  | { status: "matched"; ref: string; employee: EmployeeDescriptor }
  | { status: "not_found"; ref: string }
  | { status: "ambiguous"; ref: string; candidates: EmployeeDescriptor[] };

export interface EmployeeProposalResult {
  status: "proposal" | "not_found" | "ambiguous" | "invalid";
  ref: string;
  message: string;
  employee?: EmployeeDescriptor;
  state?: EmployeeRuntimeState;
  candidates?: EmployeeDescriptor[];
}

export interface EmployeeActionResult {
  status: "started" | "resumed" | "stopped" | "steered" | "proposal" | "not_found" | "ambiguous" | "invalid" | "failed";
  ref: string;
  message: string;
  employee?: EmployeeDescriptor;
  state?: EmployeeRuntimeState;
  candidates?: EmployeeDescriptor[];
}

export interface EmployeeRuntimeSnapshotItem {
  id: string;
  name: string;
  status: EmployeeStatus;
  running: boolean;
  resumable: boolean;
  enabled: boolean;
  profile: string;
  model: string;
  effort: string;
  description?: string;
  backendThreadId?: string;
  lastError?: string;
  childJobs: EmployeeChildJobSummary;
  pendingChildResults: number;
}

export interface EmployeeRuntimeSnapshot {
  employees: EmployeeRuntimeSnapshotItem[];
  omitted: number;
}

export function parseEmployeeCommand(text: string): EmployeeCommand {
  const trimmed = text.trim();
  const noun = "employees?";
  if (new RegExp(`^${noun}$`, "i").test(trimmed) || new RegExp(`^${noun}\\s+list$`, "i").test(trimmed)) return { isEmployee: true, action: "list" };

  const status = trimmed.match(new RegExp(`^${noun}\\s+status\\s+(\\S+)$`, "i"));
  if (status) return { isEmployee: true, action: "status", id: status[1] as string };

  const startStop = trimmed.match(new RegExp(`^${noun}\\s+(start|stop)\\s+(\\S+)$`, "i"));
  if (startStop) return { isEmployee: true, action: startStop[1]!.toLowerCase() as "start" | "stop", id: startStop[2] as string };

  const steer = trimmed.match(new RegExp(`^${noun}\\s+(?:steer|tell)\\s+(\\S+)\\s+([\\s\\S]+)$`, "i"));
  if (steer) return { isEmployee: true, action: "steer", id: steer[1] as string, text: (steer[2] as string).trim() };

  return { isEmployee: false };
}

export class EmployeeManager {
  private readonly states = new Map<string, EmployeeRuntimeState>();
  /**
   * In-memory per-employee turn locks. The persisted activeTurnId field is
   * display bookkeeping rebuilt from disk (stateFromDescriptor clears it), so
   * it cannot serialize concurrent turns — two near-simultaneous steers or
   * child results would both pass the busy-check and run two turns on one
   * backend thread. Acquisition is synchronous, so there is no TOCTOU window.
   */
  private readonly activeTurnLocks = new Map<string, string>();

  private acquireTurnLock(employeeId: string, label: string): boolean {
    if (this.activeTurnLocks.has(employeeId)) return false;
    this.activeTurnLocks.set(employeeId, label);
    return true;
  }

  private currentTurnLock(employeeId: string): string | undefined {
    return this.activeTurnLocks.get(employeeId);
  }

  private releaseTurnLock(employeeId: string): void {
    this.activeTurnLocks.delete(employeeId);
  }
  private readonly runningEmployees = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly runtimeClient?: EmployeeRuntimeClient,
    private serviceActions?: EmployeeServiceActionCallbacks
  ) {}

  attachServiceActions(serviceActions: EmployeeServiceActionCallbacks): void {
    this.serviceActions = serviceActions;
  }

  async init(): Promise<void> {
    const descriptors = this.listEmployees();
    this.runningEmployees.clear();
    for (const descriptor of descriptors) {
      const previous = await this.state.readEmployeeState(descriptor.id);
      const next = this.stateFromDescriptor(descriptor, previous);
      await this.state.saveEmployeeState(next);
      this.states.set(descriptor.id, next);
    }
    this.logger.info(
      { component: "employees", event: "init", count: descriptors.length, enabled: this.config.employees.enabled, runtimeMode: this.runtimeModeLabel() },
      "employee manager initialized"
    );
  }

  listEmployees(): EmployeeDescriptor[] {
    return Object.entries(this.config.employees.definitions)
      .map(([id, definition]) => this.toDescriptor(id, definition))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  resolveEmployeeRef(ref: string): EmployeeResolution {
    const normalized = normalizeRef(ref);
    const employees = this.listEmployees();
    const exact = employees.find((employee) => employee.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return { status: "matched", ref, employee: exact };
    const matches = employees.filter((employee) => employee.id.toLowerCase().startsWith(normalized.toLowerCase()));
    if (matches.length === 0) return { status: "not_found", ref };
    if (matches.length === 1 && matches[0]) return { status: "matched", ref, employee: matches[0] };
    return { status: "ambiguous", ref, candidates: matches };
  }

  async getEmployeeState(id: string): Promise<EmployeeRuntimeState | undefined> {
    return this.states.get(id) ?? this.state.readEmployeeState(id);
  }

  async validateDirectory(id: string): Promise<EmployeeDirectoryValidation> {
    const resolution = this.resolveEmployeeRef(id);
    if (resolution.status !== "matched") {
      return { id, directory: "", exists: false, missing: [...EMPLOYEE_DIRECTORY_CONTRACT] };
    }
    const directory = resolution.employee.directory;
    const exists = await pathExists(directory);
    const missing: string[] = [];
    for (const rel of EMPLOYEE_DIRECTORY_CONTRACT) {
      const probe = rel.endsWith("/") ? rel.slice(0, -1) : rel;
      if (!(await pathExists(join(directory, probe)))) missing.push(rel);
    }
    return { id: resolution.employee.id, directory, exists, missing };
  }

  async formatList(): Promise<string> {
    const employees = this.listEmployees();
    const active = employees.filter((employee) => this.states.get(employee.id)?.status === "running").length;
    const lines = [
      `Employees: ${employees.length} configured, ${active} active, feature=${this.config.employees.enabled ? "enabled" : "disabled"}, runtime=${this.runtimeModeLabel()}, maxActive=${this.config.employees.maxActive}`
    ];
    if (employees.length === 0) {
      lines.push("No employees configured. Add [employees.<id>] tables to config/codex-chat.toml.");
      return lines.join("\n");
    }
    if (!this.config.employees.enabled) {
      lines.push("Feature flag is off: no Employee app-server runtimes will be started.");
    }
    for (const employee of employees) {
      const state = await this.getEmployeeState(employee.id);
      lines.push(this.formatListLine(employee, state));
    }
    return lines.join("\n");
  }

  async formatStatus(ref: string): Promise<string> {
    const resolution = this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return `No employee matched "${ref}". Use "employees" to list configured employees.`;
    if (resolution.status === "ambiguous") return this.formatAmbiguous(ref, resolution.candidates);

    const employee = resolution.employee;
    const state = await this.getEmployeeState(employee.id) ?? this.stateFromDescriptor(employee);
    const validation = await this.validateDirectory(employee.id);
    const childJobs = this.childJobSummary(employee.id);
    const lines = [
      `Employee ${employee.id}${employee.name !== employee.id ? ` (${employee.name})` : ""}`,
      employee.description ? `description: ${employee.description}` : "",
      `status: ${state.status}`,
      `featureEnabled: ${employee.globalEnabled}`,
      `employeeEnabled: ${employee.enabled}`,
      `runtime: ${state.runtimeMode}`,
      `running: ${state.status === "running"}`,
      `resumable: ${state.backendThreadId ? "yes" : "no"}`,
      state.backendThreadId ? `backendThreadId: ${state.backendThreadId}` : "",
      `directory: ${employee.directory}`,
      `profile: ${employee.profile}`,
      `model: ${employee.model}`,
      `effort: ${employee.effort}`,
      `startup: ${employee.startup}`,
      `warmup: ${this.formatWarmup(employee)}`,
      `memory: enabled=${employee.memory.enabled} persistRawLogs=${employee.memory.persistRawLogs}`,
      `compaction: compactAfterTask=${employee.compaction.compactAfterTask} interval=${employee.compaction.interval}`,
      `capabilities: allowed=${employee.capabilities.allowed.length} denied=${employee.capabilities.denied.length}`,
      `acl: telegramUsers=${employee.acl.telegramUserIds.length} admins=${employee.acl.adminUserIds.length}`,
      `git: remote=${employee.gitRemote || "none"} branch=${employee.gitBranch}`,
      `directoryContract: ${validation.exists ? "exists" : "missing directory"}; missing=${validation.missing.length}`,
      `childSubagents: total=${childJobs.total} active=${childJobs.active} queued=${childJobs.queued} running=${childJobs.running} cancelling=${childJobs.cancelling} terminal=${childJobs.terminal}${childJobs.refs.length ? ` refs=${childJobs.refs.join(",")}` : ""}`,
      `pendingChildResults: ${state.pendingChildResults?.length ?? 0}`
    ];
    if (state.lastProposal) {
      lines.push(`lastProposal: ${state.lastProposal.action} at ${state.lastProposal.proposedAt}${state.lastProposal.text ? ` text=${JSON.stringify(compactText(state.lastProposal.text, { maxLength: 160, keepBackticks: true }))}` : ""}`);
    }
    if (state.lastResumeError) lines.push(`lastResumeError: ${compactText(state.lastResumeError, { maxLength: 240, keepBackticks: true })}`);
    if (state.lastError) lines.push(`lastError: ${compactText(state.lastError, { maxLength: 240, keepBackticks: true })}`);
    if (state.lastServiceActionError) lines.push(`lastServiceActionError: ${compactText(state.lastServiceActionError, { maxLength: 240, keepBackticks: true })}`);
    if (state.lastChildResultAt) lines.push(`lastChildResultAt: ${state.lastChildResultAt}`);
    if (state.pendingChildResults?.length) {
      for (const pending of state.pendingChildResults.slice(0, 5)) {
        lines.push(`pendingChildResult: job=${pending.jobId} request=${pending.ownerRequestId ?? "n/a"} status=${pending.status} reason=${pending.reason} stored=${pending.storedAt} path=${pending.resultPath}`);
      }
      if (state.pendingChildResults.length > 5) lines.push(`pendingChildResult: ${state.pendingChildResults.length - 5} more omitted`);
    }
    if (validation.missing.length > 0) lines.push(`missingPaths: ${validation.missing.slice(0, 12).join(", ")}${validation.missing.length > 12 ? ", ..." : ""}`);
    lines.push("Safety: Employee child subagents are centrally owned by SubagentManager; no email/calendar/account/project mutations, rich tools, autonomous scheduling, or compaction are implemented by the Employee runtime itself.");
    return lines.filter(Boolean).join("\n");
  }

  async propose(action: EmployeeProposalAction, ref: string, text = "", proposedBy?: string): Promise<EmployeeProposalResult> {
    if (!["start", "stop", "steer", "warmup", "compact"].includes(action)) {
      return { status: "invalid", ref, message: `Unsupported employee proposal action: ${action}` };
    }
    const resolution = this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") {
      return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    }
    const employee = resolution.employee;
    if (action === "steer" && !text.trim()) {
      return { status: "invalid", ref, employee, message: "Employee steering text cannot be empty." };
    }

    const previous = await this.getEmployeeState(employee.id);
    const state = this.stateFromDescriptor(employee, previous);
    state.status = "proposal_pending";
    state.lastProposal = {
      action,
      text: text.trim() || undefined,
      proposedAt: nowIso(),
      proposedBy,
      reason: "Employee request was recorded as a proposal; no runtime/account mutation was executed for this request."
    };
    state.updatedAt = state.lastProposal.proposedAt;
    await this.saveRuntimeState(state);
    return {
      status: "proposal",
      ref,
      employee,
      state,
      message: this.formatProposalResult(action, employee, state)
    };
  }

  async handleCommand(command: Exclude<EmployeeCommand, { isEmployee: false }>, proposedBy?: string): Promise<string> {
    if (command.action === "list") return this.formatList();
    if (command.action === "status") return this.formatStatus(command.id);
    if (command.action === "start") return (await this.startEmployee(command.id, proposedBy)).message;
    if (command.action === "stop") return (await this.stopEmployee(command.id, proposedBy)).message;
    if (command.action === "steer") return (await this.steerEmployee(command.id, command.text, proposedBy)).message;
    return `Unsupported employee command: ${String((command as { action?: string }).action ?? "unknown")}`;
  }

  async recoverRuntimesOnStartup(): Promise<{ attempted: number; running: number; failed: number }> {
    let attempted = 0;
    let running = 0;
    let failed = 0;
    if (!this.runtimeClient || !this.config.employees.enabled) return { attempted, running, failed };
    for (const employee of this.listEmployees()) {
      if (!employee.effectiveEnabled) continue;
      const state = await this.getEmployeeState(employee.id);
      const shouldRecover = employee.startup === "always" || state?.status === "running";
      if (!shouldRecover) continue;
      attempted++;
      const result = await this.startRuntime(employee, { requestedBy: "startup" });
      if (result.status === "started" || result.status === "resumed") running++;
      else failed++;
    }
    this.logger.info({ component: "employees", event: "startup_recovery", attempted, running, failed }, "employee runtime startup recovery complete");
    return { attempted, running, failed };
  }

  async startEmployee(ref: string, requestedBy?: string): Promise<EmployeeActionResult> {
    const resolution = this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const employee = resolution.employee;
    if (!this.canRunRuntime(employee)) return this.proposalAction("start", ref, "", requestedBy, "Employee runtime is unavailable; proposal recorded.");
    return this.startRuntime(employee, { requestedBy });
  }

  async stopEmployee(ref: string, requestedBy?: string): Promise<EmployeeActionResult> {
    const resolution = this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const employee = resolution.employee;

    const previous = await this.getEmployeeState(employee.id);
    const state = this.stateFromDescriptor(employee, previous);
    state.status = "stopped";
    state.runtimeMode = state.backendThreadId ? EMPLOYEE_APP_SERVER_MODE : EMPLOYEE_SCAFFOLD_MODE;
    state.activeTurnId = undefined;
    state.stoppedAt = nowIso();
    state.updatedAt = state.stoppedAt;
    await this.saveRuntimeState(state);
    this.runningEmployees.delete(employee.id);
    const cascadeResults = await this.serviceActions?.cancelOwnedActiveSubagents(employee.id, "employee_stopped") ?? [];
    const cancelled = cascadeResults.filter((result) => result.status === "success").length;
    const resumable = state.backendThreadId ? ` Thread ${state.backendThreadId} remains resumable.` : "";
    const cascade = cascadeResults.length > 0 ? ` Cancelled ${cancelled}/${cascadeResults.length} active child subagent(s) with reason=employee_stopped.` : "";
    return { status: "stopped", ref, employee, state, message: `Employee ${employee.id} stopped.${resumable}${cascade}` };
  }

  async steerEmployee(ref: string, text: string, requestedBy?: string): Promise<EmployeeActionResult> {
    const steeringText = text.trim();
    if (!steeringText) return { status: "invalid", ref, message: "Employee steering text cannot be empty." };
    const resolution = this.resolveEmployeeRef(ref);
    if (resolution.status === "not_found") return { status: "not_found", ref, message: `No employee matched "${ref}".` };
    if (resolution.status === "ambiguous") return { status: "ambiguous", ref, candidates: resolution.candidates, message: this.formatAmbiguous(ref, resolution.candidates) };
    const employee = resolution.employee;
    if (!this.canRunRuntime(employee)) return this.proposalAction("steer", ref, steeringText, requestedBy, "Employee runtime is unavailable; proposal recorded.");

    const running = await this.ensureRuntimeRunning(employee, requestedBy);
    if (!running.state || !running.state.backendThreadId || (running.status !== "started" && running.status !== "resumed")) return running;
    const state = running.state;
    const backendThreadId = state.backendThreadId as string;
    if (!this.acquireTurnLock(employee.id, "steer")) {
      const active = this.currentTurnLock(employee.id) ?? state.activeTurnId ?? "another turn";
      return { status: "failed", ref, employee, state, message: `Employee ${employee.id} already has an active turn (${active}); wait for it to finish before steering again.` };
    }

    let output = "";
    let hadError = false;
    let employeeTurnId = "";
    try {
      const spec = this.threadSpec(employee);
      for await (const event of this.runtimeClient!.sendEmployeeTurn({
        ...spec,
        backendThreadId,
        text: steeringText,
        onTurnStarted: async (turnId) => {
          employeeTurnId = turnId;
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
      if (hadError) state.lastError = output || "Employee turn emitted an error.";
      await this.saveRuntimeState(state);
      const actionReport = hadError ? undefined : await this.processEmployeeServiceOutput(employee, state, output, { parentTurnId: employeeTurnId, trigger: "steer" });
      const body = this.formatEmployeeTurnBody(output, actionReport);
      return {
        status: hadError ? "failed" : "steered",
        ref,
        employee,
        state,
        message: `Employee ${employee.id} turn completed on thread ${state.backendThreadId}.${running.message.includes("Resume failed") ? `\n${running.message}` : ""}\n\n${body}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.activeTurnId = undefined;
      state.status = "error";
      state.lastError = message;
      state.updatedAt = nowIso();
      await this.saveRuntimeState(state);
      this.logger.warn({ component: "employees", event: "steer_failed", employeeId: employee.id, error }, "employee turn failed");
      return { status: "failed", ref, employee, state, message: `Employee ${employee.id} turn failed: ${message}` };
    } finally {
      this.releaseTurnLock(employee.id);
    }
  }

  runtimeSnapshot(limit = 12): EmployeeRuntimeSnapshot {
    const employees = this.listEmployees();
    const items = employees.slice(0, limit).map((employee) => {
      const state = this.states.get(employee.id) ?? this.stateFromDescriptor(employee);
      return {
        id: employee.id,
        name: employee.name,
        status: state.status,
        running: state.status === "running",
        resumable: Boolean(state.backendThreadId),
        enabled: employee.effectiveEnabled,
        profile: employee.profile,
        model: employee.model,
        effort: employee.effort,
        description: employee.description || undefined,
        backendThreadId: state.backendThreadId,
        lastError: state.lastError,
        childJobs: this.childJobSummary(employee.id),
        pendingChildResults: state.pendingChildResults?.length ?? 0
      };
    });
    return { employees: items, omitted: Math.max(0, employees.length - limit) };
  }

  private toDescriptor(id: string, definition: EmployeeDefinitionConfig): EmployeeDescriptor {
    const directory = definition.directory || join(this.config.employees.rootDir, id);
    return {
      id,
      name: definition.name || id,
      description: definition.description || definition.purpose || definition.capabilities.notes || "",
      enabled: definition.enabled,
      globalEnabled: this.config.employees.enabled,
      effectiveEnabled: this.config.employees.enabled && definition.enabled,
      directory: resolveConfigPath(this.config, directory),
      profile: definition.profile || id,
      model: definition.model || this.config.employees.defaultModel || this.config.codex.model,
      effort: definition.effort ?? this.config.employees.defaultEffort,
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

  private canRunRuntime(employee: EmployeeDescriptor): boolean {
    return Boolean(this.runtimeClient && this.config.employees.enabled && employee.enabled && employee.effectiveEnabled);
  }

  private async proposalAction(action: EmployeeProposalAction, ref: string, text: string, proposedBy: string | undefined, fallbackMessage: string): Promise<EmployeeActionResult> {
    const proposal = await this.propose(action, ref, text, proposedBy);
    return {
      status: proposal.status === "proposal" ? "proposal" : proposal.status,
      ref,
      message: proposal.status === "proposal" ? `${fallbackMessage}\n${proposal.message}` : proposal.message,
      employee: proposal.employee,
      state: proposal.state,
      candidates: proposal.candidates
    };
  }

  private async ensureRuntimeRunning(employee: EmployeeDescriptor, requestedBy?: string): Promise<EmployeeActionResult> {
    const state = await this.getEmployeeState(employee.id);
    if (state?.status === "running" && state.backendThreadId && this.runningEmployees.has(employee.id)) {
      return { status: "resumed", ref: employee.id, employee, state, message: `Employee ${employee.id} is already running on thread ${state.backendThreadId}.` };
    }
    return this.startRuntime(employee, { requestedBy });
  }

  private async startRuntime(employee: EmployeeDescriptor, options: { requestedBy?: string; forceNew?: boolean } = {}): Promise<EmployeeActionResult> {
    if (!this.runtimeClient) return this.proposalAction("start", employee.id, "", options.requestedBy, "Employee runtime client is not attached; proposal recorded.");
    if (!employee.effectiveEnabled) return this.proposalAction("start", employee.id, "", options.requestedBy, "Employee is not effectively enabled; proposal recorded.");

    const active = this.activeRuntimeCount(employee.id);
    if (!this.runningEmployees.has(employee.id) && active >= this.config.employees.maxActive) {
      const previous = await this.getEmployeeState(employee.id);
      const state = this.stateFromDescriptor(employee, previous);
      state.status = "error";
      state.lastError = `Employee maxActive limit reached (${this.config.employees.maxActive}).`;
      state.updatedAt = nowIso();
      await this.saveRuntimeState(state);
      return { status: "failed", ref: employee.id, employee, state, message: state.lastError };
    }

    await ensureDir(employee.directory);
    const previous = await this.getEmployeeState(employee.id);
    const spec = this.threadSpec(employee);
    let threadId = options.forceNew ? undefined : previous?.backendThreadId;
    let status: "started" | "resumed" = threadId ? "resumed" : "started";
    let resumeFailure: string | undefined;

    if (threadId) {
      try {
        await this.runtimeClient.resumeEmployeeThread({ ...spec, backendThreadId: threadId });
      } catch (error) {
        resumeFailure = error instanceof Error ? error.message : String(error);
        this.logger.warn({ component: "employees", event: "resume_failed", employeeId: employee.id, backendThreadId: threadId, error }, "employee thread resume failed; starting fresh");
        const started = await this.runtimeClient.startEmployeeThread(spec);
        threadId = started.backendThreadId;
        status = "started";
      }
    } else {
      const started = await this.runtimeClient.startEmployeeThread(spec);
      threadId = started.backendThreadId;
      status = "started";
    }

    const now = nowIso();
    const state = this.stateFromDescriptor(employee, previous);
    state.status = "running";
    state.runtimeMode = EMPLOYEE_APP_SERVER_MODE;
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
    this.runningEmployees.add(employee.id);

    const verb = status === "resumed" ? "resumed" : "started";
    const message = [
      `Employee ${employee.id} ${verb} on app-server thread ${threadId}.`,
      resumeFailure ? `Resume failed for saved thread ${previous?.backendThreadId}: ${resumeFailure}; started fresh.` : "",
      `directory: ${employee.directory}`
    ].filter(Boolean).join("\n");
    return { status, ref: employee.id, employee, state, message };
  }

  async deliverChildSubagentResult(job: SubagentJob, result: string): Promise<void> {
    const employeeId = job.ownerId;
    if (!employeeId || job.ownerType !== "employee") {
      this.logger.warn({ component: "employees", event: "child_result_wrong_owner", jobId: job.id, ownerType: job.ownerType, ownerId: job.ownerId }, "received Employee child result for non-Employee-owned job");
      return;
    }
    const resolution = this.resolveEmployeeRef(employeeId);
    if (resolution.status !== "matched") {
      await this.storeChildResult(employeeId, job, result, `employee_${resolution.status}`);
      return;
    }
    const employee = resolution.employee;
    const previous = await this.getEmployeeState(employee.id);
    const state = this.stateFromDescriptor(employee, previous);
    if (!this.runtimeClient || state.status !== "running" || !state.backendThreadId || !this.runningEmployees.has(employee.id)) {
      await this.storeChildResult(employee.id, job, result, state.backendThreadId ? "employee_not_running" : "employee_not_resumable");
      return;
    }
    if (!this.acquireTurnLock(employee.id, `child_result:${job.id}`)) {
      await this.storeChildResult(employee.id, job, result, `employee_busy:${this.currentTurnLock(employee.id) ?? state.activeTurnId ?? "turn"}`);
      return;
    }

    let output = "";
    let hadError = false;
    let employeeTurnId = "";
    try {
      const spec = this.threadSpec(employee);
      for await (const event of this.runtimeClient.sendEmployeeTurn({
        ...spec,
        backendThreadId: state.backendThreadId,
        text: this.formatChildResultTurn(job, result),
        onTurnStarted: async (turnId) => {
          employeeTurnId = turnId;
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
      state.lastChildResultAt = nowIso();
      state.updatedAt = state.lastChildResultAt;
      if (hadError) state.lastError = output || "Employee child-result turn emitted an error.";
      await this.saveRuntimeState(state);
      if (!hadError) await this.processEmployeeServiceOutput(employee, state, output, { parentTurnId: employeeTurnId, trigger: "child_result" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.activeTurnId = undefined;
      state.status = "error";
      state.lastError = message;
      state.updatedAt = nowIso();
      await this.saveRuntimeState(state);
      await this.storeChildResult(employee.id, job, result, `delivery_failed:${message}`);
      this.logger.warn({ component: "employees", event: "child_result_delivery_failed", employeeId: employee.id, jobId: job.id, error }, "failed to deliver child subagent result to Employee runtime");
    } finally {
      this.releaseTurnLock(employee.id);
    }
  }

  private async processEmployeeServiceOutput(
    employee: EmployeeDescriptor,
    state: EmployeeRuntimeState,
    output: string,
    context: { parentTurnId?: string; trigger: "steer" | "child_result" }
  ): Promise<string | undefined> {
    const parsed = parseEmployeeServiceOutput(output);
    const reports: string[] = [];
    for (const error of parsed.errors) reports.push(`error: ${error}`);
    for (const envelope of parsed.envelopes) {
      for (const action of envelope.actions) {
        const requestId = action.requestId ?? envelope.requestId ?? makeId("employee_request");
        reports.push(await this.executeEmployeeServiceAction(employee, state, action, requestId, context.parentTurnId));
      }
    }
    if (reports.length === 0) return undefined;
    state.lastServiceActionAt = nowIso();
    const failures = reports.filter((line) => /^error:|forbidden:|failed:/i.test(line));
    state.lastServiceActionError = failures.at(-1);
    state.updatedAt = state.lastServiceActionAt;
    await this.saveRuntimeState(state);
    return ["Employee service actions:", ...reports.map((line) => `- ${line}`)].join("\n");
  }

  private async executeEmployeeServiceAction(
    employee: EmployeeDescriptor,
    state: EmployeeRuntimeState,
    action: EmployeeServiceAction,
    requestId: string,
    parentTurnId?: string
  ): Promise<string> {
    const permission = this.validateServiceActionCapability(employee, action.type);
    if (!permission.allowed) return `forbidden: ${action.type} request=${requestId}: ${permission.message}`;
    if (!this.serviceActions) return `failed: ${action.type} request=${requestId}: Employee service-action callbacks are not attached.`;
    const actor: SubagentControlActor = { ownerType: "employee", ownerId: employee.id };
    if (action.type === "request_subagent") {
      const jobId = await this.serviceActions.requestSubagent({
        employeeId: employee.id,
        requestId,
        profile: action.profile,
        prompt: action.prompt,
        summary: action.summary,
        model: action.model,
        effort: action.effort,
        timeoutSec: action.timeoutSec,
        images: action.images,
        parentTurnId
      });
      return `requested subagent job=${jobId} profile=${action.profile} request=${requestId}`;
    }
    if (action.type === "cancel_subagent") {
      const result = await this.serviceActions.cancelSubagent(action.jobId, { reason: action.reason ?? "employee_request", actor });
      if (result.status === "success") return `cancelled/requested cancel job=${result.job?.id ?? action.jobId} request=${requestId}`;
      return `failed: cancel_subagent job=${action.jobId} request=${requestId}: ${result.message}`;
    }
    if (action.type === "steer_subagent") {
      const result = await this.serviceActions.steerSubagent(action.jobId, action.text, { actor });
      if (result.status === "success") return `steered job=${result.job?.id ?? action.jobId} request=${requestId}`;
      return `failed: steer_subagent job=${action.jobId} request=${requestId}: ${result.message}`;
    }
    return `failed: unsupported action ${(action as { type?: string }).type ?? "unknown"} request=${requestId}`;
  }

  private validateServiceActionCapability(employee: EmployeeDescriptor, actionType: EmployeeServiceAction["type"]): { allowed: true } | { allowed: false; message: string } {
    const denied = new Set(employee.capabilities.denied.map((item) => item.toLowerCase()));
    const allowed = new Set(employee.capabilities.allowed.map((item) => item.toLowerCase()));
    const aliases = this.serviceActionCapabilityAliases(actionType);
    if (aliases.some((item) => denied.has(item))) return { allowed: false, message: `capability denied by Employee config (${actionType})` };
    if (allowed.size === 0) return { allowed: false, message: `capability not granted by Employee config (${actionType}); add ${aliases[0]} or subagents to capabilities.allowed` };
    if (aliases.some((item) => allowed.has(item))) return { allowed: true };
    return { allowed: false, message: `capability not granted by Employee config (${actionType}); allowed=${[...allowed].join(",")}` };
  }

  private serviceActionCapabilityAliases(actionType: EmployeeServiceAction["type"]): string[] {
    return [actionType.toLowerCase(), "subagents", "subagent", "service_actions", "service-action"];
  }

  private async storeChildResult(employeeId: string, job: SubagentJob, result: string, reason: string): Promise<void> {
    const storedAt = nowIso();
    const resultPreview = compactText(result, { maxLength: 500, keepBackticks: true });
    const resultPath = await this.state.saveEmployeeChildResult(employeeId, job.id, {
      employeeId,
      job,
      result,
      reason,
      storedAt
    });
    const state = this.states.get(employeeId) ?? await this.state.readEmployeeState(employeeId);
    if (state) {
      const pending: EmployeePendingChildResult = {
        jobId: job.id,
        ownerRequestId: job.ownerRequestId,
        status: job.status,
        resultPath,
        resultPreview,
        storedAt,
        reason
      };
      state.pendingChildResults = [pending, ...(state.pendingChildResults ?? [])].slice(0, 50);
      state.lastChildResultAt = storedAt;
      state.updatedAt = storedAt;
      await this.saveRuntimeState(state);
    }
    this.logger.warn({ component: "employees", event: "child_result_stored", employeeId, jobId: job.id, reason, resultPath }, "stored Employee child result for later review");
  }

  private formatChildResultTurn(job: SubagentJob, result: string): string {
    return [
      "Employee child subagent result.",
      `jobId: ${job.id}`,
      `requestId: ${job.ownerRequestId ?? "n/a"}`,
      `profile: ${job.profile}`,
      `status: ${job.status}`,
      `resultTarget: ${job.resultTarget ?? "employee"}`,
      "",
      "Result:",
      result
    ].join("\n");
  }

  private formatEmployeeTurnBody(output: string, actionReport?: string): string {
    const parsed = parseEmployeeServiceOutput(output);
    const clean = parsed.cleanText.trim();
    const parts = [clean, actionReport].filter((part): part is string => Boolean(part && part.trim()));
    if (parts.length > 0) return parts.join("\n\n");
    return "(Employee turn completed with no final output.)";
  }

  private childJobSummary(employeeId: string): EmployeeChildJobSummary {
    const jobs = this.serviceActions
      ? this.serviceActions.listSubagentJobs().filter((job) => job.ownerType === "employee" && job.ownerId === employeeId)
      : [];
    const queued = jobs.filter((job) => job.status === "queued").length;
    const running = jobs.filter((job) => job.status === "running").length;
    const cancelling = jobs.filter((job) => job.status === "cancelling").length;
    const active = queued + running + cancelling;
    const terminal = jobs.length - active;
    const refs = jobs
      .filter((job) => job.status === "queued" || job.status === "running" || job.status === "cancelling")
      .slice(0, 8)
      .map((job) => `${job.id}:${job.status}`);
    return { total: jobs.length, active, queued, running, cancelling, terminal, refs };
  }

  private activeRuntimeCount(excludeId?: string): number {
    return this.listEmployees().filter((employee) => employee.id !== excludeId && this.states.get(employee.id)?.status === "running").length;
  }

  private async saveRuntimeState(state: EmployeeRuntimeState): Promise<void> {
    this.states.set(state.id, state);
    await this.state.saveEmployeeState(state);
  }

  private threadSpec(employee: EmployeeDescriptor): EmployeeThreadSpec {
    return {
      id: employee.id,
      name: employee.name,
      description: employee.description,
      directory: employee.directory,
      profile: employee.profile,
      model: employee.model,
      effort: employee.effort,
      serviceName: `codex-chat-employee:${employee.id}`,
      baseInstructions: this.employeeBaseInstructions(employee),
      developerInstructions: this.employeeDeveloperInstructions(employee),
      persistRawLogs: employee.persistRawLogs
    };
  }

  private employeeBaseInstructions(employee: EmployeeDescriptor): string {
    return [
      `You are the durable codex-chat Employee "${employee.name}" (id: ${employee.id}).`,
      employee.description ? `Purpose: ${employee.description}` : "",
      `Employee directory: ${employee.directory}`,
      "Operate as a minimal runtime scaffold. Keep work inside the Employee directory unless explicitly instructed otherwise.",
      "No rich tools, email/calendar account access, CRM/project mutations, compaction, or autonomous scheduling are implemented by this runtime."
    ].filter(Boolean).join("\n");
  }

  private employeeDeveloperInstructions(employee: EmployeeDescriptor): string {
    return [
      "You are a durable codex-chat Employee running in a non-ephemeral Codex app-server thread.",
      `Profile: ${employee.profile}; model: ${employee.model}; effort: ${employee.effort}.`,
      "Answer steering/query turns concisely. If asked to perform unimplemented external-account or project mutations, explain that this Employee runtime is scaffold-only for those capabilities and ask for explicit implementation/review before mutating anything.",
      "You must not spawn or own subagents directly. To request child subagent work, emit a fenced `codex-chat-employee-service` JSON envelope with request_subagent/cancel_subagent/steer_subagent actions; the central service/SubagentManager owns execution and will deliver child results back to this Employee.",
      "Employee service actions require matching capabilities.allowed entries such as `subagents`, `request_subagent`, `cancel_subagent`, or `steer_subagent`; you may only cancel or steer your own child jobs.",
      employee.warmupPrompt ? `Configured warmup prompt note: ${employee.warmupPrompt}` : "",
      employee.warmupFile ? `Configured warmup file path: ${employee.warmupFile}` : ""
    ].filter(Boolean).join("\n");
  }

  private runtimeModeLabel(): "scaffold_only" | "app_server" {
    return this.config.employees.enabled && this.runtimeClient ? EMPLOYEE_APP_SERVER_MODE : EMPLOYEE_SCAFFOLD_MODE;
  }

  private stateFromDescriptor(descriptor: EmployeeDescriptor, previous?: EmployeeRuntimeState): EmployeeRuntimeState {
    const baseStatus: EmployeeStatus = descriptor.effectiveEnabled ? "idle" : "disabled";
    const previousProposal = previous?.lastProposal;
    let status: EmployeeStatus = baseStatus;
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
      runtimeMode: previous?.backendThreadId ? EMPLOYEE_APP_SERVER_MODE : previous?.runtimeMode ?? EMPLOYEE_SCAFFOLD_MODE,
      lastProposal: previousProposal,
      lastError: previous?.lastError,
      activeTurnId: undefined,
      backendThreadId: previous?.backendThreadId,
      startedAt: previous?.startedAt,
      stoppedAt: previous?.stoppedAt,
      resumedAt: previous?.resumedAt,
      lastSteeredAt: previous?.lastSteeredAt,
      lastResumeError: previous?.lastResumeError,
      pid: previous?.pid,
      pendingChildResults: previous?.pendingChildResults ?? [],
      lastChildResultAt: previous?.lastChildResultAt,
      lastServiceActionAt: previous?.lastServiceActionAt,
      lastServiceActionError: previous?.lastServiceActionError
    };
  }

  private formatListLine(employee: EmployeeDescriptor, state?: EmployeeRuntimeState): string {
    const status = state?.status ?? (employee.effectiveEnabled ? "idle" : "disabled");
    const enabled = employee.effectiveEnabled ? "enabled" : employee.enabled ? "blocked_by_global_flag" : "disabled";
    const warmup = this.formatWarmup(employee);
    const runtime = state?.runtimeMode ?? EMPLOYEE_SCAFFOLD_MODE;
    const resumable = state?.backendThreadId ? "yes" : "no";
    const childJobs = this.childJobSummary(employee.id);
    const childSummary = childJobs.total > 0 ? ` child_jobs=${childJobs.active}/${childJobs.total}` : "";
    const pending = state?.pendingChildResults?.length ? ` pending_child_results=${state.pendingChildResults.length}` : "";
    const description = employee.description ? ` purpose=${JSON.stringify(compactText(employee.description, { maxLength: 80, keepBackticks: true }))}` : "";
    return inlineCode(`${employee.id} status=${status} runtime=${runtime} resumable=${resumable} enabled=${enabled} profile=${employee.profile} model=${employee.model} effort=${employee.effort} startup=${employee.startup} dir=${employee.directory} warmup=${warmup}${childSummary}${pending}${description}`);
  }

  private formatProposalResult(action: EmployeeProposalAction, employee: EmployeeDescriptor, state: EmployeeRuntimeState): string {
    const lines = [
      `Employee ${action} proposal recorded for ${employee.id} (${employee.name}).`,
      "No Employee runtime was started/stopped/steered for this request.",
      `state: ${state.status}`,
      `directory: ${employee.directory}`,
      this.runtimeClient ? "Reason: Employee is disabled or the requested action is proposal-only in this mode." : "Reason: no Employee runtime client is attached to this management surface."
    ];
    if (!employee.effectiveEnabled) lines.push(`Note: effective enabled=false (global=${employee.globalEnabled}, employee=${employee.enabled}).`);
    return lines.join("\n");
  }

  private formatAmbiguous(ref: string, candidates: EmployeeDescriptor[]): string {
    return [`Ambiguous employee ref "${ref}". Use a longer ref.`, ...candidates.map((employee) => `${employee.id} name=${employee.name} status=${employee.effectiveEnabled ? "idle" : "disabled"}`)].join("\n");
  }

  private formatWarmup(employee: EmployeeDescriptor): string {
    if (employee.warmupFile) return `file:${employee.warmupFile}`;
    if (employee.warmupPrompt) return "inline";
    return "none";
  }

}

const employeeServiceStart = /^[ \t]*```(?:codex-chat-employee-service|employee-service-action)[ \t]*$/;

export function parseEmployeeServiceOutput(text: string): EmployeeServiceParseResult {
  const blocks = collectFencedBlocks(text, employeeServiceStart);
  const envelopes: EmployeeServiceEnvelope[] = [];
  const errors: string[] = [];
  for (const block of blocks) {
    if (!block.complete) {
      errors.push("Unterminated Employee service-action block");
      continue;
    }
    try {
      envelopes.push(employeeServiceEnvelopeSchema.parse(JSON.parse(block.body)));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { cleanText: stripRanges(text, blocks).trim(), envelopes, errors };
}
