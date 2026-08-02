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

function testConfig(nested?: { settleGraceMs?: number; holdMaxMs?: number }): AppConfig {
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
        nestedAgentSettleGraceMs: nested?.settleGraceMs ?? 5_000,
        nestedAgentHoldMaxMs: nested?.holdMaxMs ?? 55_000
      }
    },
    codex: { providerApiKeyEnvNames: ["OPENROUTER_API_KEY"] }
  } as unknown as AppConfig;
}

function fakeState(initial?: { sessionId: string; behaviorHash?: string }) {
  const sessions = new Map<string, Record<string, unknown>>();
  if (initial) sessions.set("codex-chat-main-claude", { ...initial });
  const state = {
    root: "/tmp",
    getCodexSession: vi.fn(async (name: string) => sessions.get(name)?.sessionId as string | undefined),
    getCodexSessionBehaviorHash: vi.fn(async (name: string) => sessions.get(name)?.behaviorHash as string | undefined),
    setCodexSession: vi.fn(async (name: string, value: Record<string, unknown>) => {
      sessions.set(name, { ...sessions.get(name), ...value });
    }),
    clearCodexSession: vi.fn(async (name: string) => {
      sessions.delete(name);
    })
  } as unknown as StateStore;
  return { state, sessions };
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
  config = testConfig()
) {
  vi.resetModules();
  vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
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

function successResult(sessionId: string, result: string, uuid = `result-${Math.random()}`) {
  return { type: "result", subtype: "success", result, errors: [], uuid, session_id: sessionId };
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
