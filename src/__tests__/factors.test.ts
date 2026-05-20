import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { FactorRuntimeClient } from "../factor-runtime.js";
import { FactorManager, parseFactorCommand } from "../factors.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";

const tempDirs: string[] = [];

async function loadFactorManager(configText = "", runtime?: FactorRuntimeClient) {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-factors-"));
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

[factors]
enabled = true
rootDir = "data/factors"
socketDir = "data/run/factors"
defaultModel = "gpt-factor-default"
defaultEffort = "medium"
maxActive = 2

[factors.email-calendar]
enabled = true
name = "Email/calendar"
description = "Triage email and calendar context without mutating accounts."
directory = "data/factors/email-calendar"
profile = "email-calendar"
model = "gpt-5.5"
effort = "high"
startup = "on_demand"
warmupFile = "config/email-calendar-warmup.md"

[factors.email-calendar.capabilities]
allowed = ["draft_replies"]
denied = ["calendar_mutations", "todo_mutations"]

${configText}
`);
  const config = await loadConfig(configPath);
  const state = new StateStore(config);
  await state.init();
  const manager = new FactorManager(config, state, createLogger("silent"), runtime);
  await manager.init();
  return { root, config, manager, state };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Factor runtime/scaffold", () => {
  test("parses Telegram/service Factor commands", () => {
    expect(parseFactorCommand("factors")).toEqual({ isFactor: true, action: "list" });
    expect(parseFactorCommand("factor status email-calendar")).toEqual({ isFactor: true, action: "status", id: "email-calendar" });
    expect(parseFactorCommand("factor start email-calendar")).toEqual({ isFactor: true, action: "start", id: "email-calendar" });
    expect(parseFactorCommand("factor steer email-calendar summarize but do not mutate")).toEqual({
      isFactor: true,
      action: "steer",
      id: "email-calendar",
      text: "summarize but do not mutate"
    });
    expect(parseFactorCommand("agent steer abc text")).toEqual({ isFactor: false });
  });

  test("formats list and status without starting a runtime when no runtime client is attached", async () => {
    const { manager } = await loadFactorManager();

    const list = await manager.formatList();
    const status = await manager.formatStatus("email-calendar");

    expect(list).toContain("Factors: 1 configured, 0 active, feature=enabled, runtime=scaffold_only, maxActive=2");
    expect(list).toContain("email-calendar status=idle runtime=scaffold_only resumable=no enabled=enabled profile=email-calendar model=gpt-5.5 effort=high");
    expect(status).toContain("Factor email-calendar (Email/calendar)");
    expect(status).toContain("description: Triage email and calendar context without mutating accounts.");
    expect(status).toContain("runtime: scaffold_only");
    expect(status).toContain("Safety: minimal Factor runtime only; no email/calendar/account/project mutations");
  });

  test("records start/steer proposals under data/state/factors only", async () => {
    const { root, manager } = await loadFactorManager();

    const result = await manager.propose("steer", "email", "prepare a draft reply; do not send", "test");

    expect(result.status).toBe("proposal");
    expect(result.message).toContain("No Factor runtime was started/stopped/steered");
    const raw = await readFile(join(root, "state", "factors", "email-calendar.json"), "utf8");
    const saved = JSON.parse(raw) as { status: string; runtimeMode: string; lastProposal?: { action?: string; text?: string } };
    expect(saved.status).toBe("proposal_pending");
    expect(saved.runtimeMode).toBe("scaffold_only");
    expect(saved.lastProposal).toMatchObject({ action: "steer", text: "prepare a draft reply; do not send" });
  });

  test("reports missing directory contract paths instead of creating them", async () => {
    const { root, manager } = await loadFactorManager();

    const validation = await manager.validateDirectory("email-calendar");

    expect(validation.exists).toBe(false);
    expect(validation.directory).toBe(join(root, "data", "factors", "email-calendar"));
    expect(validation.missing).toContain("AGENTS.md");
  });

  test("starts a Factor runtime and persists the backendThreadId", async () => {
    const runtime: FactorRuntimeClient = {
      startFactorThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-factor-1" }),
      resumeFactorThread: vi.fn().mockResolvedValue(undefined),
      sendFactorTurn: vi.fn()
    };
    const { root, manager, state } = await loadFactorManager("", runtime);

    const result = await manager.startFactor("email-calendar", "test");

    expect(result.status).toBe("started");
    expect(runtime.startFactorThread).toHaveBeenCalledWith(expect.objectContaining({
      id: "email-calendar",
      serviceName: "codex-chat-factor:email-calendar",
      directory: join(root, "data", "factors", "email-calendar"),
      model: "gpt-5.5",
      effort: "high"
    }));
    const saved = await state.readFactorState("email-calendar");
    expect(saved).toMatchObject({
      status: "running",
      runtimeMode: "app_server",
      backendThreadId: "thread-factor-1"
    });
  });

  test("resumes a saved Factor thread on startup recovery", async () => {
    const runtime: FactorRuntimeClient = {
      startFactorThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-new" }),
      resumeFactorThread: vi.fn().mockResolvedValue(undefined),
      sendFactorTurn: vi.fn()
    };
    const { config, state } = await loadFactorManager("", runtime);
    await state.saveFactorState({
      id: "email-calendar",
      status: "running",
      enabled: true,
      directory: join(config.rootDir, "data", "factors", "email-calendar"),
      profile: "email-calendar",
      model: "gpt-5.5",
      effort: "high",
      startup: "on_demand",
      updatedAt: "2026-05-20T00:00:00.000Z",
      runtimeMode: "app_server",
      backendThreadId: "thread-saved"
    });
    const manager = new FactorManager(config, state, createLogger("silent"), runtime);
    await manager.init();

    const recovered = await manager.recoverRuntimesOnStartup();

    expect(recovered).toEqual({ attempted: 1, running: 1, failed: 0 });
    expect(runtime.resumeFactorThread).toHaveBeenCalledWith(expect.objectContaining({
      id: "email-calendar",
      backendThreadId: "thread-saved"
    }));
    expect(runtime.startFactorThread).not.toHaveBeenCalled();
    expect(await state.readFactorState("email-calendar")).toMatchObject({
      status: "running",
      backendThreadId: "thread-saved",
      runtimeMode: "app_server"
    });
  });

  test("starts fresh and records the resume error when saved Factor resume fails", async () => {
    const runtime: FactorRuntimeClient = {
      startFactorThread: vi.fn().mockResolvedValue({ backendThreadId: "thread-fresh" }),
      resumeFactorThread: vi.fn().mockRejectedValue(new Error("thread not found")),
      sendFactorTurn: vi.fn()
    };
    const { config, state } = await loadFactorManager("", runtime);
    await state.saveFactorState({
      id: "email-calendar",
      status: "running",
      enabled: true,
      directory: join(config.rootDir, "data", "factors", "email-calendar"),
      profile: "email-calendar",
      model: "gpt-5.5",
      effort: "high",
      startup: "on_demand",
      updatedAt: "2026-05-20T00:00:00.000Z",
      runtimeMode: "app_server",
      backendThreadId: "thread-stale"
    });
    const manager = new FactorManager(config, state, createLogger("silent"), runtime);
    await manager.init();

    const recovered = await manager.recoverRuntimesOnStartup();

    expect(recovered).toEqual({ attempted: 1, running: 1, failed: 0 });
    expect(runtime.resumeFactorThread).toHaveBeenCalledWith(expect.objectContaining({ backendThreadId: "thread-stale" }));
    expect(runtime.startFactorThread).toHaveBeenCalledOnce();
    const saved = await state.readFactorState("email-calendar");
    expect(saved).toMatchObject({
      status: "running",
      backendThreadId: "thread-fresh",
      runtimeMode: "app_server"
    });
    expect(saved?.lastResumeError).toContain("thread not found");
    expect(saved?.lastError).toContain("started fresh thread thread-fresh");
  });
});
