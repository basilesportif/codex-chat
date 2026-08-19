import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BehaviorPack } from "../behavior.js";
import type { AppConfig } from "../config.js";
import type { StateStore } from "../state.js";
import type { MainAgentEvent } from "../types.js";

class PushStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private waiter?: (value: IteratorResult<T>) => void;
  private closed = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  push(value: T): void {
    if (this.closed) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  close(): void {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift() as T });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface FakeQueryPlan {
  sessionId?: string;
  initializationError?: Error;
  initializationDelayMs?: number;
  endImmediately?: boolean;
  account?: Record<string, unknown>;
}

interface FakeQueryInstance {
  options: Record<string, unknown>;
  sessionId: string;
  input: AsyncIterator<unknown>;
  sdk: PushStream<unknown>;
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeClaudeInitMessage(sessionId: string, apiKeySource = "oauth") {
  return {
    type: "system",
    subtype: "init",
    apiKeySource,
    claude_code_version: "2.1.200",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "bypassPermissions",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: `init-${sessionId}`,
    session_id: sessionId
  };
}

function fakeSdk(plans: FakeQueryPlan[] = [{}]) {
  const instances: FakeQueryInstance[] = [];
  const query = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const plan = plans[instances.length] ?? {};
    const sessionId = plan.sessionId ?? `claude-session-${instances.length + 1}`;
    const sdk = new PushStream<unknown>();
    const input = params.prompt[Symbol.asyncIterator]();
    async function* messages() {
      for await (const message of sdk) yield message;
    }
    const generator = messages();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn(() => sdk.close());
    const instance: FakeQueryInstance = { options: params.options, sessionId, input, sdk, interrupt, close };
    instances.push(instance);
    if (plan.endImmediately) sdk.close();
    const initializationResult = vi.fn(async () => {
      if (plan.initializationDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, plan.initializationDelayMs));
      }
      if (plan.initializationError) throw plan.initializationError;
      return {
        account: plan.account ?? {
          apiKeySource: "oauth",
          apiProvider: "firstParty",
          tokenSource: "oauth",
          subscriptionType: "max"
        }
      };
    });
    return Object.assign(generator, {
      initializationResult,
      interrupt,
      close
    });
  });
  return { query, instances };
}

function testConfig(nested?: {
  settleGraceMs?: number;
  holdMaxMs?: number;
  contextRolloverInputTokens?: number;
  contextRolloverHardCapTokens?: number;
  handoffSummaryEnabled?: boolean;
  interruptTimeoutSec?: number;
  maxConcurrentNestedAgents?: number;
}): AppConfig {
  return {
    rootDir: "/tmp/codex-chat-test",
    service: {
      workspace: "/tmp/codex-chat-test",
      stateDir: "/tmp/codex-chat-test-state",
      ipcSocket: "/tmp/codex-chat-test.sock"
    },
    mainAgent: {
      provider: "claude_agent_sdk",
      claude: {
        model: "claude-sonnet-5",
        effort: "high",
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Read", "Write", "Agent"],
        disallowedTools: ["WebSearch"],
        settingSources: [],
        pathToClaudeCodeExecutable: "",
        mainSessionName: "codex-chat-main-claude",
        startupTimeoutSec: 2,
        interruptTimeoutSec: nested?.interruptTimeoutSec ?? 1,
        nestedAgentSettleGraceMs: nested?.settleGraceMs ?? 5_000,
        nestedAgentHoldMaxMs: nested?.holdMaxMs ?? 55_000,
        contextRolloverInputTokens: nested?.contextRolloverInputTokens ?? 800_000,
        contextRolloverHardCapTokens: nested?.contextRolloverHardCapTokens ?? 900_000,
        handoffSummaryEnabled: nested?.handoffSummaryEnabled ?? true,
        handoffSummaryModel: "claude-sonnet-5"
      }
    },
    subagents: {
      claude: { maxConcurrentNestedAgents: nested?.maxConcurrentNestedAgents ?? 2 }
    },
    codex: { providerApiKeyEnvNames: ["OPENROUTER_API_KEY"] }
  } as unknown as AppConfig;
}

function fakeState(initial?: { sessionId: string; behaviorHash?: string }, files?: Record<string, unknown>) {
  const sessions = new Map<string, Record<string, unknown>>();
  if (initial) sessions.set("codex-chat-main-claude", { ...initial });
  const jsonFiles = new Map<string, unknown>(Object.entries(files ?? {}));
  const state = {
    root: "/tmp",
    readJson: vi.fn(async (rel: string, fallback: unknown) =>
      jsonFiles.has(rel) ? jsonFiles.get(rel) : fallback
    ),
    writeJson: vi.fn(async (rel: string, value: unknown) => {
      jsonFiles.set(rel, value);
    }),
    updateJson: vi.fn(async (rel: string, fallback: unknown, fn: (current: unknown) => unknown) => {
      const next = fn(jsonFiles.has(rel) ? jsonFiles.get(rel) : fallback);
      if (next !== undefined) jsonFiles.set(rel, next);
    }),
    getCodexSession: vi.fn(async (name: string) => sessions.get(name)?.sessionId as string | undefined),
    getCodexSessionBehaviorHash: vi.fn(async (name: string) => sessions.get(name)?.behaviorHash as string | undefined),
    getCodexSessionInputTokens: vi.fn(async (name: string) => {
      const value = sessions.get(name)?.lastInputTokens;
      return typeof value === "number" ? value : undefined;
    }),
    setCodexSession: vi.fn(async (name: string, value: Record<string, unknown>) => {
      sessions.set(name, { ...sessions.get(name), ...value });
    }),
    clearCodexSession: vi.fn(async (name: string) => {
      sessions.delete(name);
    })
  } as unknown as StateStore;
  return { state, sessions, jsonFiles };
}

const HANDOFF_FILE = "main_session_handoff.json";

function handoffRecord(jsonFiles: Map<string, unknown>): Record<string, unknown> | null {
  return (jsonFiles.get(HANDOFF_FILE) as Record<string, unknown> | null | undefined) ?? null;
}

function fakeBehavior(hash = "behavior-hash", bootstrap = "behavior bootstrap") {
  return {
    loadBootstrapPrompt: vi.fn().mockResolvedValue(bootstrap),
    hash: vi.fn().mockResolvedValue(hash)
  } as unknown as BehaviorPack;
}

function fakeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };
}

async function loadClient(
  sdk: ReturnType<typeof fakeSdk>,
  state = fakeState().state,
  behavior = fakeBehavior(),
  onCrash = vi.fn(),
  config = testConfig(),
  // The summarizer is the only boundary that would otherwise reach the real
  // transcript on disk and a second SDK query; tests stub it here.
  generateHandoffSummary?: ReturnType<typeof vi.fn>
) {
  vi.resetModules();
  vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
  if (generateHandoffSummary) {
    vi.doMock("../claude-main-handoff.js", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("../claude-main-handoff.js")),
      generateHandoffSummary
    }));
  }
  const { ClaudeMainAgentClient } = await import("../claude-main-agent.js");
  return new ClaudeMainAgentClient(config, state, behavior, fakeLogger() as never, onCrash);
}

function backgroundTasksMessage(
  sessionId: string,
  tasks: Array<{ task_id: string; task_type: string; description: string }>
) {
  return {
    type: "system",
    subtype: "background_tasks_changed",
    tasks,
    uuid: `bg-${sessionId}-${tasks.length}-${Math.random()}`,
    session_id: sessionId
  };
}

/**
 * One API request's usage, carried on an assistant message. This — not the
 * result message — is where context occupancy is read from: a result's `usage`
 * is summed over every request the turn made, so on a multi-tool turn it is a
 * multiple of how full the window actually is.
 */
function assistantRequestUsage(sessionId: string, inputTokens: number, parentToolUseId: string | null = null) {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: {
      role: "assistant",
      content: [],
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    },
    uuid: `assistant-usage-${Math.random()}`,
    session_id: sessionId
  };
}

/** An assistant message issuing one tool call, at parent or nested depth. */
function toolUseMessage(sessionId: string, toolUseId: string, parentToolUseId: string | null = null) {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "sleep 300" } }]
    },
    uuid: `tool-use-${toolUseId}-${Math.random()}`,
    session_id: sessionId
  };
}

/**
 * A tool_progress heartbeat in the exact shape production emits: `heartbeat`
 * true, `tool_use_id` suffixed, and `parent_tool_use_id` naming the
 * originating call. Verified against all 15 such messages captured in this
 * repo's data/subagents/ event streams — none has a null parent.
 */
function heartbeatMessage(sessionId: string, originatingToolUseId: string, elapsedSeconds: number) {
  return {
    type: "tool_progress",
    tool_use_id: `${originatingToolUseId}-heartbeat-0`,
    tool_name: "Bash",
    parent_tool_use_id: originatingToolUseId,
    elapsed_time_seconds: elapsedSeconds,
    heartbeat: true,
    uuid: `heartbeat-${originatingToolUseId}-${elapsedSeconds}`,
    session_id: sessionId
  };
}

function successResult(sessionId: string, result: string, uuid = `result-${Math.random()}`) {
  return { type: "result", subtype: "success", result, errors: [], uuid, session_id: sessionId };
}

function userMessageText(message: unknown): string {
  const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
}

async function collect(stream: AsyncIterable<MainAgentEvent>): Promise<MainAgentEvent[]> {
  const events: MainAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function beginFirstTurn(instance: FakeQueryInstance): Promise<void> {
  await instance.input.next();
  instance.sdk.push(fakeClaudeInitMessage(instance.sessionId));
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-oauth-token";
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  vi.doUnmock("../claude-main-handoff.js");
  vi.restoreAllMocks();
});

describe("ClaudeMainAgentClient", () => {
  test("start succeeds from initializationResult alone and first-turn init persists the fresh session", async () => {
    const sdk = fakeSdk([{ sessionId: "claude-started" }]);
    const { state, sessions } = fakeState();
    const client = await loadClient(sdk, state, fakeBehavior("hash-v1", "bootstrap-v1"));

    await client.start();

    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();
    await expect(client.health()).resolves.toMatchObject({
      ok: true,
      sessionId: undefined,
      detail: "connected (awaiting first turn)"
    });
    const eventsPromise = collect(client.sendTurn({ text: "first turn" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "ready",
      errors: [],
      uuid: "first-result",
      session_id: "claude-started"
    });
    await expect(eventsPromise).resolves.toEqual([{ type: "final", text: "ready" }]);
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "claude-started");
    expect(sessions.get("codex-chat-main-claude")).toMatchObject({
      sessionId: "claude-started",
      provider: "claude_agent_sdk",
      transport: "claude-agent-sdk",
      model: "claude-sonnet-5",
      behaviorHash: "hash-v1"
    });
    expect(sdk.instances[0]?.options).toMatchObject({
      cwd: "/tmp/codex-chat-test",
      model: "claude-sonnet-5",
      effort: "high",
      includePartialMessages: true,
      strictMcpConfig: true,
      title: "codex-chat main"
    });
    const systemPrompt = sdk.instances[0]?.options.systemPrompt as string;
    expect(systemPrompt.startsWith("bootstrap-v1")).toBe(true);
    expect(systemPrompt).toContain("run_in_background: false");
    expect(systemPrompt).toContain("Do not send your final report while any nested agent is still running");
    await client.stop();
  });

  test("passes the stored session as resume and yields behavior refresh once after a hash change", async () => {
    const sdk = fakeSdk([{ sessionId: "stored-session" }]);
    const { state, sessions } = fakeState({ sessionId: "stored-session", behaviorHash: "old-hash" });
    const client = await loadClient(sdk, state, fakeBehavior("new-hash", "fresh bootstrap"));

    await client.start();

    expect(sdk.instances[0]?.options.resume).toBe("stored-session");
    expect(sessions.get("codex-chat-main-claude")).toMatchObject({
      sessionId: "stored-session",
      behaviorHash: "new-hash",
      provider: "claude_agent_sdk"
    });
    await expect(client.health()).resolves.toMatchObject({
      ok: true,
      sessionId: "stored-session",
      detail: "connected (resumed)"
    });
    expect(client.consumePendingBehaviorRefresh()).toBe("fresh bootstrap");
    expect(client.consumePendingBehaviorRefresh()).toBeUndefined();
    await client.stop();
  });

  test("falls back once to a fresh session when resume initialization fails", async () => {
    const sdk = fakeSdk([
      { sessionId: "bad-resume", initializationError: new Error("resume session not found") },
      { sessionId: "fresh-session" }
    ]);
    const { state, sessions } = fakeState({ sessionId: "stored-session", behaviorHash: "same-hash" });
    const client = await loadClient(sdk, state, fakeBehavior("same-hash"));

    await client.start();

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(sdk.instances[0]?.options.resume).toBe("stored-session");
    expect(sdk.instances[1]?.options.resume).toBeUndefined();
    expect((state.clearCodexSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("codex-chat-main-claude");
    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();

    const eventsPromise = collect(client.sendTurn({ text: "fresh first turn" }));
    await beginFirstTurn(sdk.instances[1]!);
    sdk.instances[1]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "fresh answer",
      errors: [],
      uuid: "fresh-result",
      session_id: "fresh-session"
    });
    await eventsPromise;
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "fresh-session");
    await client.stop();
  });

  test("first-turn init overwrites a resumed session when the SDK reports a different id", async () => {
    const sdk = fakeSdk([{ sessionId: "reported-session" }]);
    const { state, sessions } = fakeState({ sessionId: "stored-session", behaviorHash: "same-hash" });
    const client = await loadClient(sdk, state, fakeBehavior("same-hash"));
    await client.start();

    const eventsPromise = collect(client.sendTurn({ text: "resume turn" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "resumed answer",
      errors: [],
      uuid: "resumed-result",
      session_id: "reported-session"
    });
    await eventsPromise;

    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "reported-session");
    expect(sessions.get("codex-chat-main-claude")).toMatchObject({
      sessionId: "reported-session",
      behaviorHash: "same-hash",
      provider: "claude_agent_sdk"
    });
    await expect(client.health()).resolves.toMatchObject({ sessionId: "reported-session" });
    await client.stop();
  });

  test("query death while OAuth initialization is pending fails start", async () => {
    const sdk = fakeSdk([{ endImmediately: true, initializationDelayMs: 20 }]);
    const client = await loadClient(sdk);

    await expect(client.start()).rejects.toThrow("Claude Agent SDK query ended unexpectedly");
    await expect(client.health()).resolves.toMatchObject({ ok: false });
  });

  test("maps partial deltas then one terminal final without duplicated content", async () => {
    const sdk = fakeSdk([{ sessionId: "turn-session" }]);
    const client = await loadClient(sdk);
    await client.start();
    const eventsPromise = collect(client.sendTurn({ text: "hello" }));
    await beginFirstTurn(sdk.instances[0]!);

    sdk.instances[0]!.sdk.push({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      parent_tool_use_id: null,
      uuid: "partial-1",
      session_id: "turn-session"
    });
    sdk.instances[0]!.sdk.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
      parent_tool_use_id: null,
      uuid: "assistant-1",
      session_id: "turn-session"
    });
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "Hello",
      errors: [],
      uuid: "result-1",
      session_id: "turn-session"
    });

    await expect(eventsPromise).resolves.toEqual([
      { type: "delta", text: "Hel" },
      { type: "final", text: "Hello" }
    ]);
    await client.stop();
  });

  test("keeps one SDK query alive across sequential turns", async () => {
    const sdk = fakeSdk([{ sessionId: "persistent-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    const firstEvents = collect(client.sendTurn({ text: "first" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "first answer",
      errors: [],
      uuid: "persistent-result-1",
      session_id: "persistent-session"
    });
    await expect(firstEvents).resolves.toEqual([{ type: "final", text: "first answer" }]);

    const secondEvents = collect(client.sendTurn({ text: "second" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "second answer",
      errors: [],
      uuid: "persistent-result-2",
      session_id: "persistent-session"
    });
    await expect(secondEvents).resolves.toEqual([{ type: "final", text: "second answer" }]);
    expect(sdk.query).toHaveBeenCalledOnce();
    await client.stop();
  });

  test("classifies result errors and terminates the turn", async () => {
    const sdk = fakeSdk([{ sessionId: "error-session" }]);
    const client = await loadClient(sdk);
    await client.start();
    const eventsPromise = collect(client.sendTurn({ text: "hello" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "error_during_execution",
      errors: ["rate limit exceeded"],
      uuid: "result-error",
      session_id: "error-session"
    });

    const events = await eventsPromise;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", message: "rate limit exceeded", kind: "rate_limit" });
    await client.stop();
  });

  test("rejects a second concurrent turn", async () => {
    const sdk = fakeSdk([{ sessionId: "serialized-session" }]);
    const client = await loadClient(sdk);
    await client.start();
    const first = client.sendTurn({ text: "first" })[Symbol.asyncIterator]();
    const firstNext = first.next();
    await beginFirstTurn(sdk.instances[0]!);

    const second = client.sendTurn({ text: "second" })[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toThrow("already has an active turn");

    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "done",
      errors: [],
      uuid: "serialized-result",
      session_id: "serialized-session"
    });
    await expect(firstNext).resolves.toEqual({ done: false, value: { type: "final", text: "done" } });
    await expect(first.next()).resolves.toEqual({ done: true, value: undefined });
    await client.stop();
  });

  test("resetSession clears persisted state, interrupts, and starts fresh", async () => {
    const sdk = fakeSdk([{ sessionId: "before-reset" }, { sessionId: "after-reset" }]);
    const { state, sessions } = fakeState();
    const client = await loadClient(sdk, state);
    await client.start();
    const beforeResetEvents = collect(client.sendTurn({ text: "before reset" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "before reset answer",
      errors: [],
      uuid: "before-reset-result",
      session_id: "before-reset"
    });
    await beforeResetEvents;
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "before-reset");

    const health = await client.resetSession("test-reset");

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(sdk.instances[0]?.interrupt).toHaveBeenCalledOnce();
    expect((state.clearCodexSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("codex-chat-main-claude");
    expect(health).toMatchObject({
      ok: true,
      sessionId: undefined,
      provider: "claude_agent_sdk",
      detail: "connected (awaiting first turn)"
    });
    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();

    const afterResetEvents = collect(client.sendTurn({ text: "after reset" }));
    await beginFirstTurn(sdk.instances[1]!);
    sdk.instances[1]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "after reset answer",
      errors: [],
      uuid: "after-reset-result",
      session_id: "after-reset"
    });
    await afterResetEvents;
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "after-reset");
    await client.stop();
  });

  test("health stays ok while awaiting first turn, then reports the lazily captured session", async () => {
    const sdk = fakeSdk([{ sessionId: "health-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    await expect(client.health()).resolves.toEqual({
      ok: true,
      transport: "claude-agent-sdk",
      provider: "claude_agent_sdk",
      sessionId: undefined,
      detail: "connected (awaiting first turn)"
    });
    const eventsPromise = collect(client.sendTurn({ text: "health turn" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "healthy",
      errors: [],
      uuid: "health-result",
      session_id: "health-session"
    });
    await eventsPromise;
    await expect(client.health()).resolves.toEqual({
      ok: true,
      transport: "claude-agent-sdk",
      provider: "claude_agent_sdk",
      sessionId: "health-session",
      detail: "connected"
    });
    await client.stop();
    expect(sdk.instances[0]?.interrupt).toHaveBeenCalledOnce();
    await expect(client.health()).resolves.toMatchObject({ ok: false, detail: "stopped" });
  });

  test("caps concurrent nested agents in the main loop, at the configured limit, and frees the slot when one finishes", async () => {
    const sdk = fakeSdk([{ sessionId: "cap-session" }]);
    // Configurable: 1 here, not the default 2.
    const client = await loadClient(sdk, fakeState().state, fakeBehavior(), vi.fn(), testConfig({ maxConcurrentNestedAgents: 1 }));
    await client.start();

    const options = sdk.instances[0]!.options as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<Record<string, never>>> }>>;
      systemPrompt?: string;
    };
    expect(options.systemPrompt).toContain("Never run more than 1 nested agent at once");
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<Record<string, never>>;
    const post = options.hooks?.PostToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<Record<string, never>>;
    const agentCall = (toolUseId: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: toolUseId,
      tool_input: { prompt: "investigate", subagent_type: "investigator" }
    });

    expect(await pre(agentCall("toolu_1"))).toMatchObject({
      hookSpecificOutput: { updatedInput: { run_in_background: false } }
    });
    const denied = await pre(agentCall("toolu_2")) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("allows at most 1 at a time");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("work sequentially");

    await post({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: {}, tool_response: {} });
    expect(await pre(agentCall("toolu_3"))).toMatchObject({
      hookSpecificOutput: { updatedInput: { run_in_background: false } }
    });

    // A nested agent the SDK reports as live counts even without a PreToolUse
    // admission of its own (e.g. one that never went through this hook).
    await post({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_3", tool_input: {}, tool_response: {} });
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("cap-session", [{ task_id: "task-1", task_type: "local_agent", description: "investigator" }])
    );
    let deniedByLiveTask = false;
    for (let attempt = 0; attempt < 50 && !deniedByLiveTask; attempt++) {
      const probe = await pre(agentCall("toolu_probe")) as { hookSpecificOutput: { permissionDecision?: string } };
      deniedByLiveTask = probe.hookSpecificOutput.permissionDecision === "deny";
      // An admitted probe must give its slot back, or the NEXT probe would be
      // denied by the probe itself rather than by the live nested task.
      if (!deniedByLiveTask) {
        await post({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_probe", tool_input: {}, tool_response: {} });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    expect(deniedByLiveTask).toBe(true);
    await client.stop();
  });

  test("nested agents that outlive a turn keep holding the cap across the next turn boundary", async () => {
    const sdk = fakeSdk([{ sessionId: "survive-session" }]);
    // Short hold window so the turn is released while the nested agent is
    // still live — the exact case reset() must not forget.
    const client = await loadClient(
      sdk,
      fakeState().state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ maxConcurrentNestedAgents: 1, holdMaxMs: 20 })
    );
    await client.start();
    const options = sdk.instances[0]!.options as {
      hooks?: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<Record<string, never>>> }>>;
    };
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<Record<string, never>>;
    const agentCall = (toolUseId: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: toolUseId,
      tool_input: { prompt: "investigate", subagent_type: "investigator" }
    });

    // One nested agent is live per the SDK. A turn released at
    // `nestedAgentHoldMaxMs` can end while it is still running, and
    // background_tasks_changed only fires on CHANGE — so nothing will re-report
    // it. The next turn must still see it.
    const eventsPromise = collect(client.sendTurn({ text: "first turn" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("survive-session", [{ task_id: "task-1", task_type: "local_agent", description: "investigator" }])
    );
    await waitFor(() => (client as unknown as { liveNestedAgentTasks: unknown[] }).liveNestedAgentTasks.length === 1);
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "done",
      errors: [],
      uuid: "r1",
      session_id: "survive-session"
    });
    // The held result is released at the hold window with the agent still live.
    await eventsPromise;

    const nextTurn = collect(client.sendTurn({ text: "second turn" }));
    // sendTurn's generator is lazy: probe only once the turn has really begun,
    // i.e. after the turn-boundary reset() has run.
    await waitFor(() => (client as unknown as { activeTurn?: unknown }).activeTurn !== undefined);
    const decision = await pre(agentCall("toolu_next")) as { hookSpecificOutput: { permissionDecision?: string } };
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    sdk.instances[0]!.sdk.push({
      type: "result",
      subtype: "success",
      result: "second",
      errors: [],
      uuid: "r2",
      session_id: "survive-session"
    });
    await nextTurn;
    await client.stop();
  });

  test("holds a result that arrives while a nested agent is live, then releases the post-nested result", async () => {
    const sdk = fakeSdk([{ sessionId: "nested-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    const events: MainAgentEvent[] = [];
    let settled = false;
    const done = (async () => {
      for await (const event of client.sendTurn({ text: "fix the bug" })) events.push(event);
      settled = true;
    })();
    await beginFirstTurn(sdk.instances[0]!);

    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("nested-session", [
        { task_id: "task-1", task_type: "local_agent", description: "investigator: find the root cause" },
        { task_id: "task-2", task_type: "local_bash", description: "npm run dev" }
      ])
    );
    // The session reports back while the nested investigator is still running.
    sdk.instances[0]!.sdk.push(successResult("nested-session", "spawned an investigator; nothing fixed yet"));

    await waitFor(() => events.some((event) => event.type === "status"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(events.some((event) => event.type === "final")).toBe(false);
    expect(events[0]).toMatchObject({ type: "status", message: "waiting on 1 nested agent before replying" });

    // The nested agent finishes; the backgrounded dev server keeps running and
    // must not keep holding the reply.
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("nested-session", [{ task_id: "task-2", task_type: "local_bash", description: "npm run dev" }])
    );
    sdk.instances[0]!.sdk.push(successResult("nested-session", "investigator finished; bug fixed and tests pass"));

    await done;
    expect(events.filter((event) => event.type === "final")).toEqual([
      { type: "final", text: "investigator finished; bug fixed and tests pass" }
    ]);
    await client.stop();
  });

  test("a live backgrounded Bash task does not hold a successful result", async () => {
    const sdk = fakeSdk([{ sessionId: "bash-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    const eventsPromise = collect(client.sendTurn({ text: "start the dev server and verify" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("bash-session", [
        { task_id: "task-1", task_type: "local_bash", description: "npm run dev" },
        { task_id: "task-2", task_type: "local_workflow", description: "spec" }
      ])
    );
    sdk.instances[0]!.sdk.push(successResult("bash-session", "fix verified against the dev server"));

    await expect(eventsPromise).resolves.toEqual([{ type: "final", text: "fix verified against the dev server" }]);
    await client.stop();
  });

  test("nudges a quiet session once after its nested agents drain, then settles on that turn's result", async () => {
    const sdk = fakeSdk([{ sessionId: "drain-session" }]);
    const client = await loadClient(sdk, fakeState().state, fakeBehavior(), vi.fn(), testConfig({ settleGraceMs: 20 }));
    await client.start();

    const eventsPromise = collect(client.sendTurn({ text: "fix the bug" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("drain-session", [
        { task_id: "task-1", task_type: "local_agent", description: "implementer: apply the fix" }
      ])
    );
    sdk.instances[0]!.sdk.push(successResult("drain-session", "dispatched an implementer"));
    sdk.instances[0]!.sdk.push(backgroundTasksMessage("drain-session", []));

    // The session never woke on its own; the drain timer nudges it.
    const nudge = await sdk.instances[0]!.input.next();
    expect(nudge.value).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: expect.stringContaining("every nested agent you launched has finished") }]
      }
    });

    sdk.instances[0]!.sdk.push(successResult("drain-session", "implementer's fix reviewed; tests pass"));
    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "final")).toEqual([
      { type: "final", text: "implementer's fix reviewed; tests pass" }
    ]);
    await client.stop();
  });

  test("stopping mid-hold flushes the held reply instead of dropping it", async () => {
    const sdk = fakeSdk([{ sessionId: "stop-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    const eventsPromise = collect(client.sendTurn({ text: "fix the bug" }));
    await beginFirstTurn(sdk.instances[0]!);
    sdk.instances[0]!.sdk.push(
      backgroundTasksMessage("stop-session", [
        { task_id: "task-1", task_type: "local_agent", description: "implementer: apply the fix" }
      ])
    );
    sdk.instances[0]!.sdk.push(successResult("stop-session", "held interim answer"));
    await waitFor(() => client.getRecentLogs(50).join("\n").includes("[TURN HELD]"));

    await client.stop();
    const events = await eventsPromise;
    expect(events.filter((event) => event.type === "final")).toEqual([{ type: "final", text: "held interim answer" }]);
  });

  test("rewrites nested Agent tool calls to run in the foreground", async () => {
    const sdk = fakeSdk([{ sessionId: "hook-session" }]);
    const client = await loadClient(sdk);
    await client.start();

    const options = sdk.instances[0]!.options as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<unknown>> }> };
    };
    const matcher = options.hooks?.PreToolUse?.[0];
    expect(matcher?.matcher).toBe("Agent");
    const hook = matcher?.hooks[0];
    await expect(
      hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: "toolu_1",
        tool_input: { prompt: "investigate", subagent_type: "investigator", run_in_background: true }
      })
    ).resolves.toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { prompt: "investigate", subagent_type: "investigator", run_in_background: false }
      }
    });
    await expect(
      hook?.({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: "toolu_2",
        tool_input: { command: "ls", run_in_background: true }
      })
    ).resolves.toEqual({ continue: true });
    expect(client.getRecentLogs(50).join("\n")).toContain("forced foreground subagent_type=investigator");
    await client.stop();
  });

  test("clearPersistedSession drops the Claude session key without restarting", async () => {
    const sdk = fakeSdk([{ sessionId: "kept-alive" }]);
    const { state, sessions } = fakeState({ sessionId: "kept-alive", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state);
    await client.start();

    await client.clearPersistedSession("watchdog_abort");

    expect((state.clearCodexSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("codex-chat-main-claude");
    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(sdk.instances[0]?.close).not.toHaveBeenCalled();
    await client.stop();
  });

  test("tracks effective input tokens from result usage and stays on the session below the threshold", async () => {
    const sdk = fakeSdk([{ sessionId: "usage-session" }]);
    const { state } = fakeState({ sessionId: "usage-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig({ contextRolloverInputTokens: 1_000 }));
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("usage-session", 590));
    sdk.instances[0]!.sdk.push(successResult("usage-session", "first answer"));
    await expect(first).resolves.toEqual([{ type: "final", text: "first answer" }]);
    expect(client.contextStats()).toEqual({
      sessionId: "usage-session",
      lastTurnInputTokens: 590,
      rolloverThresholdTokens: 1_000,
      rolloverPending: false,
      contextWindowTokens: undefined
    });

    const second = collect(client.sendTurn({ text: "two" }));
    const secondMessage = await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("usage-session", 800));
    sdk.instances[0]!.sdk.push(successResult("usage-session", "second answer"));
    const secondEvents = await second;

    // Under the threshold: same SDK query, no rollover notice, no handoff note.
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(secondEvents).toEqual([{ type: "final", text: "second answer" }]);
    expect(userMessageText(secondMessage.value)).toBe("two");
    expect(client.contextStats()).toMatchObject({ lastTurnInputTokens: 800, rolloverPending: false });
    await client.stop();
  });

  test("a turn ending over the context threshold rolls the next turn onto a fresh session", async () => {
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, sessions } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000, handoffSummaryEnabled: false })
    );
    await client.start();
    expect(sdk.instances[0]?.options.resume).toBe("full-session");

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1105));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    // Armed, but the running turn is never disturbed mid-flight.
    expect(client.contextStats()).toMatchObject({ lastTurnInputTokens: 1_105, rolloverPending: true });
    expect(sdk.query).toHaveBeenCalledTimes(1);

    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => sdk.instances.length === 2);
    const rolledMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    const events = await second;

    expect(sdk.instances[1]?.options.resume).toBeUndefined();
    expect(events[0]).toMatchObject({
      type: "status",
      raw: { event: "claude_context_rollover", previousSessionId: "full-session", previousTurnInputTokens: 1_105 }
    });
    expect(events.at(-1)).toEqual({ type: "final", text: "fresh answer" });
    expect(userMessageText(rolledMessage.value)).toContain("previous main session reached its context limit");
    expect(userMessageText(rolledMessage.value)).toContain("two");
    expect(client.contextStats()).toMatchObject({ rolloverPending: false, lastTurnInputTokens: undefined });
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "rolled-session");
    await client.stop();
  });

  test("summarizes the doomed session out of band and hands the brief to the fresh one", async () => {
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    const summarize = vi.fn().mockResolvedValue({
      summary: "Ongoing: ship the handoff brief.",
      transcriptChars: 1_234,
      transcriptMessages: 12,
      transcriptBytes: 4_567
    });
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1100));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;

    // Summarization is scheduled off the hot path against the doomed session
    // and never resumes it.
    await waitFor(() => handoffRecord(jsonFiles)?.status === "ready");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.[0]).toMatchObject({ sessionId: "full-session", model: "claude-sonnet-5" });
    expect(handoffRecord(jsonFiles)).toMatchObject({
      forSessionId: "full-session",
      inputTokensAtSchedule: 1_100,
      summary: "Ongoing: ship the handoff brief."
    });
    expect(sdk.query).toHaveBeenCalledTimes(1);

    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => sdk.instances.length === 2);
    const rolledMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    const events = await second;

    expect(events[0]).toMatchObject({
      type: "status",
      raw: { event: "claude_context_rollover", handoffSummary: true }
    });
    const text = userMessageText(rolledMessage.value);
    expect(text).toContain("Handoff brief from your previous session (auto-summarized):");
    expect(text).toContain("Ongoing: ship the handoff brief.");
    expect(text).toContain("two");
    // Consumed exactly once: the artifact is invalidated at the boundary.
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("a summarizer failure still rolls over, with the plain handoff note", async () => {
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    const summarize = vi.fn().mockRejectedValue(new Error("transcript missing"));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1100));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "failed");

    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => sdk.instances.length === 2);
    const rolledMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    const events = await second;

    expect(events[0]).toMatchObject({
      type: "status",
      raw: { event: "claude_context_rollover", handoffSummary: false }
    });
    const text = userMessageText(rolledMessage.value);
    expect(text).toContain("previous main session reached its context limit");
    expect(text).not.toContain("Handoff brief");
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("a handoff artifact for a different session is neither resumed around nor carried", async () => {
    const sdk = fakeSdk([{ sessionId: "live-session" }, { sessionId: "next-session" }]);
    const stale = {
      forSessionId: "some-other-session",
      createdAt: new Date().toISOString(),
      inputTokensAtSchedule: 900_000,
      status: "ready",
      summary: "STALE BRIEF"
    };
    const { state, jsonFiles } = fakeState({ sessionId: "live-session", behaviorHash: "behavior-hash" }, {
      "main_session_handoff.json": stale
    });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig(), vi.fn());
    await client.start();
    // The artifact names a session that is not the persisted one, so the
    // resume decision is untouched.
    expect(sdk.instances[0]?.options.resume).toBe("live-session");

    const first = collect(client.sendTurn({ text: "one" }));
    const firstMessage = await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(successResult("live-session", "first answer"));
    await first;
    expect(userMessageText(firstMessage.value)).toBe("one");

    // Watchdog clear of a session the artifact does not describe: nothing is
    // owed to the fresh session, and the foreign brief is left alone.
    await client.clearPersistedSession("watchdog_abort");
    await client.stop();
    await client.start();

    const second = collect(client.sendTurn({ text: "two" }));
    const secondMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("next-session"));
    sdk.instances[1]!.sdk.push(successResult("next-session", "second answer"));
    await second;

    expect(userMessageText(secondMessage.value)).toBe("two");
    expect(handoffRecord(jsonFiles)).toMatchObject({ forSessionId: "some-other-session", summary: "STALE BRIEF" });
    await client.stop();
  });

  test("an armed rollover waits for its summary instead of burning it at the next turn", async () => {
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    let resolveSummary!: (value: unknown) => void;
    const summarize = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveSummary = resolve;
    }));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1100));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "pending");

    // Summary still generating and well under the hard cap: the turn resumes
    // the existing session rather than throwing the brief away.
    const second = collect(client.sendTurn({ text: "two" }));
    const secondMessage = await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1200));
    sdk.instances[0]!.sdk.push(successResult("full-session", "second answer"));
    const secondEvents = await second;

    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(userMessageText(secondMessage.value)).toBe("two");
    expect(secondEvents).toEqual([{ type: "final", text: "second answer" }]);
    // Still armed, and not re-scheduled while it waits.
    expect(client.contextStats()).toMatchObject({ rolloverPending: true });
    expect(summarize).toHaveBeenCalledTimes(1);

    resolveSummary({ summary: "Ongoing: the deferred brief.", transcriptChars: 1, transcriptMessages: 1, transcriptBytes: 1 });
    await waitFor(() => handoffRecord(jsonFiles)?.status === "ready");

    // Resolved: the next boundary rolls over and carries the brief.
    const third = collect(client.sendTurn({ text: "three" }));
    await waitFor(() => sdk.instances.length === 2);
    const rolledMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    const events = await third;

    expect(events[0]).toMatchObject({ type: "status", raw: { event: "claude_context_rollover", handoffSummary: true } });
    const text = userMessageText(rolledMessage.value);
    expect(text).toContain("Ongoing: the deferred brief.");
    expect(text).toContain("three");
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("a deferred rollover stops waiting at the hard cap and uses the plain note", async () => {
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    // Never resolves: the summary is still generating when the cap is hit.
    const summarize = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000, contextRolloverHardCapTokens: 1_500 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1100));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "pending");

    // Under the cap: deferred, and this turn pushes the session over it.
    const second = collect(client.sendTurn({ text: "two" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1600));
    sdk.instances[0]!.sdk.push(successResult("full-session", "second answer"));
    await second;
    expect(sdk.query).toHaveBeenCalledTimes(1);

    const third = collect(client.sendTurn({ text: "three" }));
    await waitFor(() => sdk.instances.length === 2);
    const rolledMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    const events = await third;

    expect(events[0]).toMatchObject({ type: "status", raw: { event: "claude_context_rollover", handoffSummary: false } });
    const text = userMessageText(rolledMessage.value);
    expect(text).toContain("previous main session reached its context limit");
    expect(text).not.toContain("Handoff brief");
    await client.stop();
  });

  test("a watchdog clear hands the brief to the next fresh session", async () => {
    const sdk = fakeSdk([{ sessionId: "wedged-session" }, { sessionId: "recovered-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "wedged-session", behaviorHash: "behavior-hash" });
    const summarize = vi.fn().mockResolvedValue({
      summary: "Ongoing: recover from the wedge.",
      transcriptChars: 10,
      transcriptMessages: 1,
      transcriptBytes: 10
    });
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("wedged-session", 1100));
    sdk.instances[0]!.sdk.push(successResult("wedged-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "ready");

    // Watchdog recovery: clear the persisted session, then restart clean.
    await client.clearPersistedSession("watchdog_abort");
    expect(handoffRecord(jsonFiles)).toMatchObject({ abandoned: true });
    await client.stop();
    await client.start();

    const turn = collect(client.sendTurn({ text: "after the wedge" }));
    const message = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("recovered-session"));
    sdk.instances[1]!.sdk.push(successResult("recovered-session", "recovered answer"));
    const events = await turn;

    expect(sdk.instances[1]?.options.resume).toBeUndefined();
    const text = userMessageText(message.value);
    expect(text).toContain("your previous main session was reset");
    expect(text).toContain("Ongoing: recover from the wedge.");
    expect(text).toContain("after the wedge");
    // No rollover happened at this boundary, so no rollover status event.
    expect(events.every((event) => event.type !== "status")).toBe(true);
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("the pending-rollover marker is readable at the very next turn boundary", async () => {
    // The defect: the marker was written inside a floating async job while
    // recordTurnUsage returned immediately, so the next boundary — which
    // arrives within milliseconds during a live conversation — always read
    // nothing. `context_rollover_deferred` never fired once in 14 days of
    // production and `contextRolloverHardCapTokens` was dead code.
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    const summarize = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000, contextRolloverHardCapTokens: 5_000 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1_100));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;

    // Deliberately NO waitFor: the boundary has to see the marker on its own.
    const second = collect(client.sendTurn({ text: "two" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(successResult("full-session", "second answer"));
    await second;

    // Deferred rather than rolled over, which is only possible if the marker
    // was already observable.
    expect(sdk.query).toHaveBeenCalledTimes(1);
    expect(handoffRecord(jsonFiles)).toMatchObject({ forSessionId: "full-session", status: "pending" });
    expect(client.contextStats()).toMatchObject({ rolloverPending: true });
    await client.stop();
  });

  test("a brief that is still generating at the boundary is kept and carried by a later turn", async () => {
    // The defect: `consumeHandoffSummary` cleared the artifact BEFORE checking
    // whether it was ready, so a brief that finished seconds later had nothing
    // left to patch. Two of six summaries in 14 days were generated and binned.
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    let resolveSummary!: (value: unknown) => void;
    const summarize = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveSummary = resolve;
    }));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      // Hard cap below the observed size, so the rollover happens immediately
      // rather than waiting for the summary.
      testConfig({ contextRolloverInputTokens: 1_000, contextRolloverHardCapTokens: 1_500 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1_600));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "pending");

    // Rollover with the brief still generating: plain note now, brief kept.
    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => sdk.instances.length === 2);
    const plainMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    await second;
    expect(userMessageText(plainMessage.value)).not.toContain("Handoff brief");
    expect(handoffRecord(jsonFiles)).toMatchObject({ forSessionId: "full-session", status: "pending" });

    resolveSummary({ summary: "Ongoing: the late brief.", transcriptChars: 1, transcriptMessages: 1, transcriptBytes: 1 });
    await waitFor(() => handoffRecord(jsonFiles)?.status === "ready");

    // The debt survived: the next turn on the fresh session carries it.
    const third = collect(client.sendTurn({ text: "three" }));
    const briefedMessage = await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "briefed answer"));
    await third;

    const text = userMessageText(briefedMessage.value);
    expect(text).toContain("Ongoing: the late brief.");
    expect(text).toContain("three");
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("a rollover scheduled while another summary is in flight still persists its marker", async () => {
    // The defect: `scheduleHandoffSummary` returned early on the in-flight
    // guard BEFORE writing anything, and the artifact doubles as the persisted
    // pending-rollover flag — so a restart in that window happily resumed a
    // session that was already owed a rollover.
    const sdk = fakeSdk([{ sessionId: "full-session" }, { sessionId: "rolled-session" }]);
    const { state, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" });
    const summarize = vi.fn().mockImplementation(() => new Promise(() => undefined));
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000, contextRolloverHardCapTokens: 1_500 }),
      summarize
    );
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("full-session", 1_600));
    sdk.instances[0]!.sdk.push(successResult("full-session", "first answer"));
    await first;
    await waitFor(() => handoffRecord(jsonFiles)?.status === "pending");

    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => sdk.instances.length === 2);
    await sdk.instances[1]!.input.next();
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("rolled-session"));
    // The fresh session immediately fills up too, while the first summarizer
    // is still running.
    sdk.instances[1]!.sdk.push(assistantRequestUsage("rolled-session", 1_700));
    sdk.instances[1]!.sdk.push(successResult("rolled-session", "fresh answer"));
    await second;

    await waitFor(() => handoffRecord(jsonFiles)?.forSessionId === "rolled-session");
    // Marked terminal, not "pending": nothing may wait on a summary that was
    // never started. But the marker itself exists, which is the safety property.
    expect(handoffRecord(jsonFiles)).toMatchObject({ forSessionId: "rolled-session", status: "skipped" });
    expect(summarize).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  test("context occupancy ignores nested-agent usage and the result's cumulative total", async () => {
    // Ground truth, verified against SDK 0.3.220 on 2026-08-17: a result's
    // `usage` is summed over every API request in the turn, and subagent
    // traffic streams through this same query. Reading either as occupancy is
    // how a 1M-token window reported 2,050,378 "effective input tokens".
    const sdk = fakeSdk([{ sessionId: "usage-session" }]);
    const { state } = fakeState({ sessionId: "usage-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig({ contextRolloverInputTokens: 100_000 }));
    await client.start();

    const turn = collect(client.sendTurn({ text: "run a nested agent" }));
    await sdk.instances[0]!.input.next();
    // Deliberately DECREASING across the turn, as an SDK-side auto-compaction
    // makes it: the last figure is the truth, and a running maximum would
    // leave a compacted session reading as permanently near-full.
    sdk.instances[0]!.sdk.push(assistantRequestUsage("usage-session", 85_000));
    // A nested agent's own conversation, relayed with parent_tool_use_id set.
    sdk.instances[0]!.sdk.push(assistantRequestUsage("usage-session", 900_000, "toolu_nested_1"));
    sdk.instances[0]!.sdk.push(assistantRequestUsage("usage-session", 700));
    sdk.instances[0]!.sdk.push({
      ...successResult("usage-session", "done"),
      usage: { input_tokens: 10, cache_read_input_tokens: 3_000_000, cache_creation_input_tokens: 20_000 },
      modelUsage: { "claude-sonnet-5": { contextWindow: 1_000_000 } }
    });
    await turn;

    expect(client.contextStats()).toMatchObject({
      lastTurnInputTokens: 700,
      rolloverPending: false,
      contextWindowTokens: 1_000_000
    });
    await client.stop();
  });

  test("a hung interrupt cannot strand the watchdog suspension", async () => {
    // The rollover suspends the inactivity deadline across its stop()/start().
    // stop() interrupts the child, and the one case that most needs
    // interrupting — a child wedged on a near-full session — is the one most
    // likely never to answer. A suspension that outlived its `finally` would
    // disable the deadline forever, leaving only the absolute ceiling, which
    // by design never clears a session: nothing would ever recover.
    const sdk = fakeSdk([{ sessionId: "hung-session" }, { sessionId: "next-session" }]);
    const { state } = fakeState({ sessionId: "hung-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000, handoffSummaryEnabled: false, interruptTimeoutSec: 1 })
    );
    await client.start();
    // Never resolves, exactly like a child blocked in epoll.
    sdk.instances[0]!.interrupt.mockImplementation(() => new Promise(() => undefined));

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("hung-session", 1_100));
    sdk.instances[0]!.sdk.push(successResult("hung-session", "first answer"));
    await first;
    expect(client.turnWatchdogState().suspended).toBe(false);

    // The rollover suspends, then blocks in interrupt().
    const second = collect(client.sendTurn({ text: "two" }));
    await waitFor(() => client.turnWatchdogState().suspended === true);
    expect(client.turnWatchdogState().suspendedReason).toBe("context_rollover_restart");

    // The suspension carries its own expiry, so it lifts even though the
    // interrupt never returned and the `finally` never ran.
    (client as unknown as { watchdogSuspendedUntil: number }).watchdogSuspendedUntil = Date.now() - 1;
    expect(client.turnWatchdogState().suspended).toBe(false);
    expect(client.turnWatchdogState().suspendedReason).toBeUndefined();

    // And the interrupt itself is bounded, so the rollover still completes.
    await waitFor(() => sdk.instances.length === 2, 4_000);
    sdk.instances[1]!.sdk.push(fakeClaudeInitMessage("next-session"));
    sdk.instances[1]!.sdk.push(successResult("next-session", "fresh answer"));
    await second;
    expect(client.turnWatchdogState().suspended).toBe(false);
    await client.stop();
  }, 30_000);

  test("only the live turn's own SDK traffic counts as activity", async () => {
    // The SDK's stream is session-scoped: `background_tasks_changed` fires for
    // a dev server some earlier turn backgrounded, and `tool_progress` ticks
    // for whatever is running. Unattributable traffic must not hold the
    // inactivity budget open while the conversation itself is wedged.
    const sdk = fakeSdk([{ sessionId: "activity-session" }]);
    const { state } = fakeState({ sessionId: "activity-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig());
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    // A tool call from the FIRST turn, whose heartbeats outlive it.
    sdk.instances[0]!.sdk.push(toolUseMessage("activity-session", "toolu_old_turn"));
    sdk.instances[0]!.sdk.push(successResult("activity-session", "first answer"));
    await first;

    // Between turns: a leftover background task keeps talking.
    const idleActivityAt = client.turnWatchdogState().lastActivityAt;
    sdk.instances[0]!.sdk.push(backgroundTasksMessage("activity-session", [
      { task_id: "bg-1", task_type: "bash", description: "dev server" }
    ]));
    await waitFor(() => true);
    expect(client.turnWatchdogState().lastActivityAt).toBe(idleActivityAt);

    const second = collect(client.sendTurn({ text: "two" }));
    await sdk.instances[0]!.input.next();
    expect(client.turnWatchdogState().activityEvents).toBe(0);

    // The previous turn's tool is still heartbeating. Not this turn's problem.
    sdk.instances[0]!.sdk.push(heartbeatMessage("activity-session", "toolu_old_turn", 30));
    await waitFor(() => true);
    expect(client.turnWatchdogState().activityEvents).toBe(0);

    // A background task that predates this turn changing state is not progress.
    sdk.instances[0]!.sdk.push(backgroundTasksMessage("activity-session", []));
    await waitFor(() => true);
    expect(client.turnWatchdogState().activityEvents).toBe(0);

    // This turn's own call, and its heartbeat, are.
    sdk.instances[0]!.sdk.push(toolUseMessage("activity-session", "toolu_this_turn"));
    await waitFor(() => client.turnWatchdogState().activityEvents === 1);
    sdk.instances[0]!.sdk.push(heartbeatMessage("activity-session", "toolu_this_turn", 30));
    await waitFor(() => client.turnWatchdogState().activityEvents === 2);

    sdk.instances[0]!.sdk.push(successResult("activity-session", "second answer"));
    await second;
    await client.stop();
  });

  test("a long quiet tool call stays alive on heartbeats alone (W3)", async () => {
    // Regression pin for the shape that actually occurs in production: EVERY
    // tool_progress message captured in data/subagents/ is heartbeat:true with
    // parent_tool_use_id set to the originating call. job_46baa638's single
    // Bash ran 119.8s emitting nothing else — excluding heartbeats would have
    // aborted it ~40s from the finish line, making every build, test suite or
    // clone longer than the inactivity window unfinishable.
    const sdk = fakeSdk([{ sessionId: "long-tool-session" }]);
    const { state } = fakeState({ sessionId: "long-tool-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig());
    await client.start();

    const turn = collect(client.sendTurn({ text: "run the suite" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(toolUseMessage("long-tool-session", "toolu_long_bash"));
    await waitFor(() => client.turnWatchdogState().activityEvents === 1);

    // 30s-interval heartbeats spanning well past the 80s inactivity budget.
    let expectedEvents = 1;
    for (const elapsed of [30, 60, 90, 120]) {
      sdk.instances[0]!.sdk.push(heartbeatMessage("long-tool-session", "toolu_long_bash", elapsed));
      expectedEvents += 1;
      await waitFor(() => client.turnWatchdogState().activityEvents === expectedEvents);
    }
    // Five attributable events: the tool_use plus four heartbeats. A watchdog
    // reading this can never see the turn as silent.
    expect(client.turnWatchdogState().activityEvents).toBe(5);

    sdk.instances[0]!.sdk.push(successResult("long-tool-session", "suite green"));
    await turn;
    await client.stop();
  });

  test("a nested agent's own long tool call is attributable to the parent turn", async () => {
    // Nested agents stream their assistant messages through the SAME query
    // with parent_tool_use_id set, so their tool_use ids are observable and
    // must join the turn's set — otherwise a nested agent running one long
    // silent Bash reads as a stalled parent turn.
    const sdk = fakeSdk([{ sessionId: "nested-session" }]);
    const { state } = fakeState({ sessionId: "nested-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig());
    await client.start();

    const turn = collect(client.sendTurn({ text: "delegate it" }));
    await sdk.instances[0]!.input.next();
    // Parent launches a nested agent...
    sdk.instances[0]!.sdk.push(toolUseMessage("nested-session", "toolu_agent_call"));
    // ...which issues its own Bash, relayed with parent_tool_use_id set.
    sdk.instances[0]!.sdk.push(toolUseMessage("nested-session", "toolu_nested_bash", "toolu_agent_call"));
    await waitFor(() => client.turnWatchdogState().activityEvents === 2);

    const before = client.turnWatchdogState().activityEvents;
    sdk.instances[0]!.sdk.push(heartbeatMessage("nested-session", "toolu_nested_bash", 60));
    await waitFor(() => client.turnWatchdogState().activityEvents === before + 1);

    sdk.instances[0]!.sdk.push(successResult("nested-session", "delegated"));
    await turn;
    await client.stop();
  });

  test("an owed rollover outlives its brief's six-hour expiry", async () => {
    // The artifact carries two things: a summary, which goes stale, and a
    // rollover DEBT, which does not. Expiring both let startup resume a
    // session that was already too full — straight back into the wedge.
    const sdk = fakeSdk([{ sessionId: "fresh-session" }]);
    const owed = {
      forSessionId: "oversized-session",
      createdAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
      inputTokensAtSchedule: 850_000,
      status: "ready",
      summary: "STALE BRIEF"
    };
    const { state, sessions, jsonFiles } = fakeState(
      { sessionId: "oversized-session", behaviorHash: "behavior-hash" },
      { "main_session_handoff.json": owed }
    );
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig(), vi.fn());

    await client.start();

    // The debt was enforced: no resume, and the oversized key is dropped.
    expect(sdk.instances[0]?.options.resume).toBeUndefined();
    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();

    const turn = collect(client.sendTurn({ text: "after the outage" }));
    const message = await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(fakeClaudeInitMessage("fresh-session"));
    sdk.instances[0]!.sdk.push(successResult("fresh-session", "answer"));
    await turn;

    // ...but the stale brief was NOT carried into the fresh session.
    const text = userMessageText(message.value);
    expect(text).not.toContain("STALE BRIEF");
    expect(text).toContain("after the outage");
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("a resumed session re-seeds its context occupancy from state", async () => {
    // Post-restart blindness: without this a resumed near-full session has no
    // occupancy until a turn COMPLETES — and a session wedged because it is
    // full never completes one, so the watchdog has no wedge evidence in
    // exactly the case it was built for.
    const sdk = fakeSdk([{ sessionId: "resumed-session" }]);
    const { state } = fakeState({ sessionId: "resumed-session", behaviorHash: "behavior-hash" });
    await state.setCodexSession("codex-chat-main-claude", { sessionId: "resumed-session", lastInputTokens: 812_345 });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig({ contextRolloverInputTokens: 800_000 }));

    await client.start();

    expect(client.contextStats()).toMatchObject({
      sessionId: "resumed-session",
      lastTurnInputTokens: 812_345
    });
    await client.stop();
  });

  test("persisting a new session id drops the previous session's occupancy", async () => {
    // `setCodexSession` merges, so an occupancy figure outlives the session it
    // was measured against unless dropped explicitly. Pairing a new id with the
    // old session's tokens would re-seed a false "near full" reading on the
    // next restart: a bogus rollover plus fabricated wedge evidence against a
    // conversation that has barely started.
    const sdk = fakeSdk([{ sessionId: "old-session" }]);
    const { state, sessions } = fakeState({ sessionId: "old-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig({ contextRolloverInputTokens: 900_000 }));
    await client.start();

    const first = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(assistantRequestUsage("old-session", 850_000));
    sdk.instances[0]!.sdk.push(successResult("old-session", "first answer"));
    await first;
    await waitFor(() => sessions.get("codex-chat-main-claude")?.lastInputTokens === 850_000);

    // The SDK reports a different session id (resume divergence).
    sdk.instances[0]!.sdk.push(fakeClaudeInitMessage("brand-new-session"));
    await waitFor(() => sessions.get("codex-chat-main-claude")?.sessionId === "brand-new-session");

    expect(sessions.get("codex-chat-main-claude")?.lastInputTokens).toBeUndefined();
    expect(client.contextStats()).toMatchObject({ sessionId: "brand-new-session", lastTurnInputTokens: undefined });
    await client.stop();
  });

  test("falls back to the result's last usage iteration when no parent assistant message carried usage", async () => {
    const sdk = fakeSdk([{ sessionId: "iter-session" }]);
    const { state } = fakeState({ sessionId: "iter-session", behaviorHash: "behavior-hash" });
    const client = await loadClient(sdk, state, fakeBehavior(), vi.fn(), testConfig({ contextRolloverInputTokens: 100_000 }));
    await client.start();

    const turn = collect(client.sendTurn({ text: "one" }));
    await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push({
      ...successResult("iter-session", "done"),
      usage: {
        input_tokens: 8,
        cache_read_input_tokens: 5_124,
        cache_creation_input_tokens: 1_864,
        // The last iteration is the final request, and its own prompt size is
        // the occupancy figure — 1,866 against a 6,996 cumulative total.
        iterations: [{ input_tokens: 2, cache_read_input_tokens: 1_786, cache_creation_input_tokens: 78 }]
      }
    });
    await turn;

    expect(client.contextStats()).toMatchObject({ lastTurnInputTokens: 1_866 });
    await client.stop();
  });

  test("a rollover owed across a restart starts fresh instead of resuming the oversized session", async () => {
    const sdk = fakeSdk([{ sessionId: "restarted-session" }]);
    const pending = {
      forSessionId: "full-session",
      createdAt: new Date().toISOString(),
      inputTokensAtSchedule: 934_000,
      status: "ready",
      summary: "Ongoing: survive the restart."
    };
    const { state, sessions, jsonFiles } = fakeState({ sessionId: "full-session", behaviorHash: "behavior-hash" }, {
      "main_session_handoff.json": pending
    });
    const client = await loadClient(
      sdk,
      state,
      fakeBehavior(),
      vi.fn(),
      testConfig({ contextRolloverInputTokens: 1_000 }),
      vi.fn()
    );

    await client.start();

    // The pending-rollover flag survived the restart: no resume, and the
    // oversized session id is dropped from state.
    expect(sdk.instances[0]?.options.resume).toBeUndefined();
    expect(sessions.get("codex-chat-main-claude")).toBeUndefined();

    const turn = collect(client.sendTurn({ text: "after restart" }));
    const message = await sdk.instances[0]!.input.next();
    sdk.instances[0]!.sdk.push(fakeClaudeInitMessage("restarted-session"));
    sdk.instances[0]!.sdk.push(successResult("restarted-session", "answer"));
    await turn;

    const text = userMessageText(message.value);
    expect(text).toContain("Ongoing: survive the restart.");
    expect(text).toContain("after restart");
    expect(handoffRecord(jsonFiles)).toBeNull();
    await client.stop();
  });

  test("extracts only user/assistant text from a session transcript, tail-first", async () => {
    const { claudeTranscriptPath, readTranscriptExcerpt } = await import("../claude-main-handoff.js");
    const home = await mkdtemp(join(tmpdir(), "codex-chat-handoff-"));
    const path = claudeTranscriptPath("/home/tim/pkg/tim/codex-chat", "sess-1", home);
    expect(path).toBe(join(home, ".claude", "projects", "-home-tim-pkg-tim-codex-chat", "sess-1.jsonl"));
    await mkdir(dirname(path), { recursive: true });
    const lines = [
      JSON.stringify({ type: "custom-title", customTitle: "codex-chat main" }),
      JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text: "old question" }] } }),
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "old answer" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] }
      }),
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", content: "huge tool output" }] } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }),
      "{ not json",
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "recent question" } })
    ];
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    const excerpt = await readTranscriptExcerpt(path);
    expect(excerpt.text).toBe("USER: old question\n\nASSISTANT: old answer\n\nUSER: recent question");
    expect(excerpt.messages).toBe(3);
    expect(excerpt.text).not.toContain("huge tool output");
    expect(excerpt.text).not.toContain("subagent chatter");
    expect(excerpt.text).not.toContain("hmm");

    // Budget spends from the tail backwards.
    const tail = await readTranscriptExcerpt(path, 40);
    expect(tail.text).toBe("USER: recent question");
    await rm(home, { recursive: true, force: true });
  });

  test("rejects initialization when the SDK reports a non-first-party provider", async () => {
    const sdk = fakeSdk([{ account: { apiKeySource: "oauth", apiProvider: "bedrock" } }]);
    const client = await loadClient(sdk);

    await expect(client.start()).rejects.toThrow(/first-party subscription OAuth.*apiProvider=bedrock/);
    await expect(client.health()).resolves.toMatchObject({
      ok: false,
      provider: "claude_agent_sdk",
      transport: "claude-agent-sdk"
    });
  });
});
