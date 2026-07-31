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
  account?: Record<string, unknown>;
}

interface FakeQueryInstance {
  options: Record<string, unknown>;
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
      yield fakeClaudeInitMessage(sessionId);
      for await (const message of sdk) yield message;
    }
    const generator = messages();
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn(() => sdk.close());
    const instance: FakeQueryInstance = { options: params.options, input, sdk, interrupt, close };
    instances.push(instance);
    return Object.assign(generator, {
      initializationResult: plan.initializationError
        ? vi.fn().mockRejectedValue(plan.initializationError)
        : vi.fn().mockResolvedValue({
            account: plan.account ?? {
              apiKeySource: "oauth",
              apiProvider: "firstParty",
              tokenSource: "oauth",
              subscriptionType: "max"
            }
          }),
      interrupt,
      close
    });
  });
  return { query, instances };
}

function testConfig(): AppConfig {
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
        startupTimeoutSec: 2
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
  onCrash = vi.fn()
) {
  vi.resetModules();
  vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
  const { ClaudeMainAgentClient } = await import("../claude-main-agent.js");
  return new ClaudeMainAgentClient(testConfig(), state, behavior, fakeLogger() as never, onCrash);
}

async function collect(stream: AsyncIterable<MainAgentEvent>): Promise<MainAgentEvent[]> {
  const events: MainAgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
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
  test("start persists the provider-scoped session id and behavior hash", async () => {
    const sdk = fakeSdk([{ sessionId: "claude-started" }]);
    const { state, sessions } = fakeState();
    const client = await loadClient(sdk, state, fakeBehavior("hash-v1", "bootstrap-v1"));

    await client.start();

    expect(sessions.get("codex-chat-main-claude")).toMatchObject({
      sessionId: "claude-started",
      provider: "claude_agent_sdk",
      transport: "claude-agent-sdk",
      model: "claude-sonnet-5",
      behaviorHash: "hash-v1"
    });
    expect(sdk.instances[0]?.options).toMatchObject({
      cwd: "/tmp/codex-chat-test",
      systemPrompt: "bootstrap-v1",
      model: "claude-sonnet-5",
      effort: "high",
      includePartialMessages: true,
      strictMcpConfig: true,
      title: "codex-chat main"
    });
    await client.stop();
  });

  test("passes the stored session as resume and yields behavior refresh once after a hash change", async () => {
    const sdk = fakeSdk([{ sessionId: "claude-resumed" }]);
    const { state } = fakeState({ sessionId: "stored-session", behaviorHash: "old-hash" });
    const client = await loadClient(sdk, state, fakeBehavior("new-hash", "fresh bootstrap"));

    await client.start();

    expect(sdk.instances[0]?.options.resume).toBe("stored-session");
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
    expect(sessions.get("codex-chat-main-claude")?.sessionId).toBe("fresh-session");
    await client.stop();
  });

  test("maps partial deltas then one terminal final without duplicated content", async () => {
    const sdk = fakeSdk([{ sessionId: "turn-session" }]);
    const client = await loadClient(sdk);
    await client.start();
    const eventsPromise = collect(client.sendTurn({ text: "hello" }));
    await sdk.instances[0]!.input.next();

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
    await sdk.instances[0]!.input.next();
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
    await sdk.instances[0]!.input.next();
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
    await sdk.instances[0]!.input.next();

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
    const { state } = fakeState();
    const client = await loadClient(sdk, state);
    await client.start();

    const health = await client.resetSession("test-reset");

    expect(sdk.query).toHaveBeenCalledTimes(2);
    expect(sdk.instances[0]?.interrupt).toHaveBeenCalledOnce();
    expect((state.clearCodexSession as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("codex-chat-main-claude");
    expect(health).toMatchObject({ ok: true, sessionId: "after-reset", provider: "claude_agent_sdk" });
    await client.stop();
  });

  test("stop interrupts and health reports the Claude provider and transport", async () => {
    const sdk = fakeSdk([{ sessionId: "health-session" }]);
    const client = await loadClient(sdk);
    await client.start();

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
