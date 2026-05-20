import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { EmployeeRuntimeClient } from "../employee-runtime.js";
import { EmployeeManager, parseEmployeeCommand, parseEmployeeServiceOutput } from "../employees.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";

const tempDirs: string[] = [];

async function loadEmployeeManager(configText = "", runtime?: EmployeeRuntimeClient) {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-employees-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, "codex-chat.toml");
  await writeFile(configPath, `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[employees]
enabled = true
rootDir = "data/employees"
socketDir = "data/run/employees"
defaultModel = "gpt-employee-default"
defaultEffort = "medium"
maxActive = 2

[employees.email-calendar]
enabled = true
name = "Email/calendar"
description = "Triage email and calendar context without mutating accounts."
directory = "data/employees/email-calendar"
profile = "email-calendar"
model = "gpt-5.5"
effort = "high"
startup = "on_demand"
warmupFile = "config/email-calendar-warmup.md"

[employees.email-calendar.capabilities]
allowed = ["draft_replies", "subagents"]
denied = ["calendar_mutations", "todo_mutations"]

${configText}
`);
  const config = await loadConfig(configPath);
  const state = new StateStore(config);
  await state.init();
  const manager = new EmployeeManager(config, state, createLogger("silent"), runtime);
  await manager.init();
  return { root, config, manager, state };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Employee runtime/scaffold", () => {
  test("parses Telegram/service Employee commands", () => {
    expect(parseEmployeeCommand("employees")).toEqual({ isEmployee: true, action: "list" });
    expect(parseEmployeeCommand("employee status email-calendar")).toEqual({ isEmployee: true, action: "status", id: "email-calendar" });
    expect(parseEmployeeCommand("employee start email-calendar")).toEqual({ isEmployee: true, action: "start", id: "email-calendar" });
    expect(parseEmployeeCommand("employee steer email-calendar summarize but do not mutate")).toEqual({
      isEmployee: true,
      action: "steer",
      id: "email-calendar",
      text: "summarize but do not mutate"
    });
    expect(parseEmployeeCommand("agent steer abc text")).toEqual({ isEmployee: false });
  });

  test("formats list and status without starting a runtime when no runtime client is attached", async () => {
    const { manager } = await loadEmployeeManager();

    const list = await manager.formatList();
    const status = await manager.formatStatus("email-calendar");

    expect(list).toContain("Employees: 1 configured, 0 active, feature=enabled, runtime=scaffold_only, maxActive=2");
    expect(list).toContain("email-calendar status=idle runtime=scaffold_only resumable=no enabled=enabled profile=email-calendar model=gpt-5.5 effort=high");
    expect(status).toContain("Employee email-calendar (Email/calendar)");
    expect(status).toContain("description: Triage email and calendar context without mutating accounts.");
    expect(status).toContain("runtime: scaffold_only");
    expect(status).toContain("Safety: Employee child subagents are centrally owned by SubagentManager");
  });

  test("records start/steer proposals under data/state/employees only", async () => {
    const { root, manager } = await loadEmployeeManager();

    const result = await manager.propose("steer", "email", "prepare a draft reply; do not send", "test");

    expect(result.status).toBe("proposal");
    expect(result.message).toContain("No Employee runtime was started/stopped/steered");
    const raw = await readFile(join(root, "state", "employees", "email-calendar.json"), "utf8");
    const saved = JSON.parse(raw) as { status: string; runtimeMode: string; lastProposal?: { action?: string; text?: string } };
    expect(saved.status).toBe("proposal_pending");
    expect(saved.runtimeMode).toBe("scaffold_only");
    expect(saved.lastProposal).toMatchObject({ action: "steer", text: "prepare a draft reply; do not send" });
  });

  test("reports missing directory contract paths instead of creating them", async () => {
    const { root, manager } = await loadEmployeeManager();

    const validation = await manager.validateDirectory("email-calendar");

    expect(validation.exists).toBe(false);
    expect(validation.directory).toBe(join(root, "data", "employees", "email-calendar"));
    expect(validation.missing).toContain("AGENTS.md");
  });

  test("starts an Employee runtime and persists the backendThreadId", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-employee-1" }),
      resumeEmployeeThread: vi.fn().mockResolvedValue(undefined),
      sendEmployeeTurn: vi.fn()
    };
    const { root, manager, state } = await loadEmployeeManager("", runtime);

    const result = await manager.startEmployee("email-calendar", "test");

    expect(result.status).toBe("started");
    expect(runtime.startEmployeeThread).toHaveBeenCalledWith(expect.objectContaining({
      id: "email-calendar",
      serviceName: "codex-chat-employee:email-calendar",
      directory: join(root, "data", "employees", "email-calendar"),
      model: "gpt-5.5",
      effort: "high"
    }));
    const saved = await state.readEmployeeState("email-calendar");
    expect(saved).toMatchObject({
      status: "running",
      runtimeMode: "app_server",
      backendThreadId: "thread-employee-1"
    });
  });

  test("resumes a saved Employee thread on startup recovery", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-new" }),
      resumeEmployeeThread: vi.fn().mockResolvedValue(undefined),
      sendEmployeeTurn: vi.fn()
    };
    const { config, state } = await loadEmployeeManager("", runtime);
    await state.saveEmployeeState({
      id: "email-calendar",
      status: "running",
      enabled: true,
      directory: join(config.rootDir, "data", "employees", "email-calendar"),
      profile: "email-calendar",
      model: "gpt-5.5",
      effort: "high",
      startup: "on_demand",
      updatedAt: "2026-05-20T00:00:00.000Z",
      runtimeMode: "app_server",
      backendThreadId: "thread-saved"
    });
    const manager = new EmployeeManager(config, state, createLogger("silent"), runtime);
    await manager.init();

    const recovered = await manager.recoverRuntimesOnStartup();

    expect(recovered).toEqual({ attempted: 1, running: 1, failed: 0 });
    expect(runtime.resumeEmployeeThread).toHaveBeenCalledWith(expect.objectContaining({
      id: "email-calendar",
      backendThreadId: "thread-saved"
    }));
    expect(runtime.startEmployeeThread).not.toHaveBeenCalled();
    expect(await state.readEmployeeState("email-calendar")).toMatchObject({
      status: "running",
      backendThreadId: "thread-saved",
      runtimeMode: "app_server"
    });
  });

  test("starts fresh and records the resume error when saved Employee resume fails", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-fresh" }),
      resumeEmployeeThread: vi.fn().mockRejectedValue(new Error("thread not found")),
      sendEmployeeTurn: vi.fn()
    };
    const { config, state } = await loadEmployeeManager("", runtime);
    await state.saveEmployeeState({
      id: "email-calendar",
      status: "running",
      enabled: true,
      directory: join(config.rootDir, "data", "employees", "email-calendar"),
      profile: "email-calendar",
      model: "gpt-5.5",
      effort: "high",
      startup: "on_demand",
      updatedAt: "2026-05-20T00:00:00.000Z",
      runtimeMode: "app_server",
      backendThreadId: "thread-stale"
    });
    const manager = new EmployeeManager(config, state, createLogger("silent"), runtime);
    await manager.init();

    const recovered = await manager.recoverRuntimesOnStartup();

    expect(recovered).toEqual({ attempted: 1, running: 1, failed: 0 });
    expect(runtime.resumeEmployeeThread).toHaveBeenCalledWith(expect.objectContaining({ backendThreadId: "thread-stale" }));
    expect(runtime.startEmployeeThread).toHaveBeenCalledOnce();
    const saved = await state.readEmployeeState("email-calendar");
    expect(saved).toMatchObject({
      status: "running",
      backendThreadId: "thread-fresh",
      runtimeMode: "app_server"
    });
    expect(saved?.lastResumeError).toContain("thread not found");
    expect(saved?.lastError).toContain("started fresh thread thread-fresh");
  });

  test("parses Employee service-action envelopes", () => {
    const parsed = parseEmployeeServiceOutput([
      "Before",
      "```codex-chat-employee-service",
      JSON.stringify({
        version: 1,
        requestId: "batch-1",
        actions: [{ type: "request_subagent", profile: "researcher", prompt: "inspect", summary: "Inspect" }]
      }),
      "```",
      "After"
    ].join("\n"));

    expect(parsed.cleanText).toBe("Before\nAfter");
    expect(parsed.errors).toEqual([]);
    expect(parsed.envelopes[0]?.actions[0]).toMatchObject({ type: "request_subagent", profile: "researcher" });
  });

  test("dispatches Employee request_subagent service actions through attached orchestrator callbacks", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-employee-1" }),
      resumeEmployeeThread: vi.fn().mockResolvedValue(undefined),
      sendEmployeeTurn: vi.fn(async function* (input) {
        await input.onTurnStarted?.("turn-employee-1");
        yield {
          type: "final",
          text: [
            "Queued child work.",
            "```codex-chat-employee-service",
            JSON.stringify({
              version: 1,
              actions: [{
                type: "request_subagent",
                requestId: "req-child-1",
                profile: "researcher",
                prompt: "Research calendar edge cases",
                summary: "Research calendar",
                model: "gpt-5.5",
                effort: "high"
              }]
            }),
            "```"
          ].join("\n")
        };
      })
    };
    const { manager } = await loadEmployeeManager("", runtime);
    const requestSubagent = vi.fn().mockResolvedValue("job_child_1");
    manager.attachServiceActions({
      requestSubagent,
      cancelSubagent: vi.fn(),
      steerSubagent: vi.fn(),
      cancelOwnedActiveSubagents: vi.fn().mockResolvedValue([]),
      listSubagentJobs: vi.fn().mockReturnValue([])
    });
    await manager.startEmployee("email-calendar", "test");

    const result = await manager.steerEmployee("email-calendar", "please split out research", "test");

    expect(result.message).toContain("Queued child work.");
    expect(result.message).toContain("requested subagent job=job_child_1");
    expect(requestSubagent).toHaveBeenCalledWith(expect.objectContaining({
      employeeId: "email-calendar",
      requestId: "req-child-1",
      profile: "researcher",
      parentTurnId: "turn-employee-1"
    }));
  });

  test("stores Employee child results when the Employee runtime is not running", async () => {
    const { manager, state } = await loadEmployeeManager();

    await manager.deliverChildSubagentResult({
      id: "job_child_store",
      profile: "researcher",
      route: "return_to_main",
      ownerType: "employee",
      ownerId: "email-calendar",
      ownerRequestId: "req-store",
      resultTarget: "employee",
      status: "completed",
      promptPath: "/tmp/p",
      artifactDir: "/tmp/a"
    }, "stored child result");

    const saved = await state.readEmployeeState("email-calendar");
    expect(saved?.pendingChildResults?.[0]).toMatchObject({
      jobId: "job_child_store",
      ownerRequestId: "req-store",
      reason: "employee_not_resumable"
    });
    const status = await manager.formatStatus("email-calendar");
    expect(status).toContain("pendingChildResults: 1");
    expect(status).toContain("pendingChildResult: job=job_child_store");
  });

  test("delivers Employee child results to a running Employee as a new turn", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-employee-1" }),
      resumeEmployeeThread: vi.fn().mockResolvedValue(undefined),
      sendEmployeeTurn: vi.fn(async function* (input) {
        await input.onTurnStarted?.("turn-child-result");
        yield { type: "final", text: "Recorded child result." };
      })
    };
    const { manager } = await loadEmployeeManager("", runtime);
    await manager.startEmployee("email-calendar", "test");

    await manager.deliverChildSubagentResult({
      id: "job_child_deliver",
      profile: "researcher",
      route: "return_to_main",
      ownerType: "employee",
      ownerId: "email-calendar",
      ownerRequestId: "req-deliver",
      resultTarget: "employee",
      status: "completed",
      promptPath: "/tmp/p",
      artifactDir: "/tmp/a"
    }, "delivered child result");

    expect(runtime.sendEmployeeTurn).toHaveBeenCalledWith(expect.objectContaining({
      backendThreadId: "thread-employee-1",
      text: expect.stringContaining("jobId: job_child_deliver")
    }));
    expect(runtime.sendEmployeeTurn).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("delivered child result")
    }));
  });

  test("stopping an Employee cascades cancellation to owned active child jobs", async () => {
    const runtime: EmployeeRuntimeClient = {
      startEmployeeThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-employee-1" }),
      resumeEmployeeThread: vi.fn().mockResolvedValue(undefined),
      sendEmployeeTurn: vi.fn()
    };
    const { manager } = await loadEmployeeManager("", runtime);
    const cancelOwnedActiveSubagents = vi.fn().mockResolvedValue([{ status: "success" }]);
    manager.attachServiceActions({
      requestSubagent: vi.fn(),
      cancelSubagent: vi.fn(),
      steerSubagent: vi.fn(),
      cancelOwnedActiveSubagents,
      listSubagentJobs: vi.fn().mockReturnValue([])
    });
    await manager.startEmployee("email-calendar", "test");

    const result = await manager.stopEmployee("email-calendar", "test");

    expect(result.status).toBe("stopped");
    expect(result.message).toContain("reason=employee_stopped");
    expect(cancelOwnedActiveSubagents).toHaveBeenCalledWith("email-calendar", "employee_stopped");
  });
});
