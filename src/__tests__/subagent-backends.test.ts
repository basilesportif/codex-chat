import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { SubagentJob } from "../types.js";

const tempDirs: string[] = [];

function fakeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: {
      name: "codex-chat",
      workspace: rootDir,
      stateDir: "state",
      logLevel: "silent",
      timezone: "Etc/UTC",
      ipcSocket: "data/run/codex-chat.sock"
    },
    codex: {
      binary: "codex",
      transport: "app-server",
      appServerHost: "127.0.0.1",
      appServerPort: 49345,
      model: "gpt-test",
      effort: "medium",
      profile: "",
      modelProvider: "",
      serviceTierMode: "auto",
      providerApiKeyEnvNames: ["OPENROUTER_API_KEY"],
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      mainSessionName: "codex-chat-main",
      startupTimeoutSec: 1,
      turnTimeoutSec: 1,
      keepAliveSec: 60,
      extraConfig: [],
      addDirs: [],
      serviceTier: "fast"
    },
    subagents: {
      enabled: true,
      backend: "codex_app_server",
      maxConcurrent: 1,
      defaultModel: "",
      defaultEffort: "medium",
      defaultServiceTier: "fast",
      defaultCodexProfile: "",
      defaultModelProvider: "",
      serviceTierMode: "auto",
      allowProviderOverride: false,
      allowedCodexProfiles: [],
      allowedModelProviders: [],
      defaultTimeoutSec: 10,
      maxTimeoutSec: 10,
      maxPromptBytes: 262_144,
      artifactDir: "data/subagents",
      childSocketDir: "data/run/subagents",
      childStartupTimeoutSec: 1,
      childInterruptGraceMs: 50,
      allowedProfiles: [],
      cleanupArtifacts: false
    }
  } as AppConfig;
}

afterEach(async () => {
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN;
  delete process.env.CLAUDE_CODE_OAUTH_SCOPES;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("node:child_process");
  vi.doUnmock("ws");
  vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function enableClaude(config: AppConfig): AppConfig {
  config.subagents.backend = "claude_agent_sdk";
  config.subagents.claude = {
    enabled: true,
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
  return config;
}

function subagentJob(root: string, id = "job_claude00000000000000000000000000"): SubagentJob {
  return {
    id,
    profile: "implementer",
    route: "return_to_main",
    status: "running",
    promptPath: join(root, "prompt.md"),
    artifactDir: root
  };
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(predicate()).toBe(true);
}

function fakeClaudeInitMessage(sessionId = "claude-session", apiKeySource = "oauth") {
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
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: sessionId
  };
}

describe("app-server subagent backend", () => {
  test("starts regular subagents as ephemeral and does not resume them", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-backend-"));
    tempDirs.push(root);
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    vi.doMock("ws", () => {
      class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        readyState = 1;

        constructor(readonly url: string) {
          super();
          queueMicrotask(() => this.emit("open"));
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          sent.push({ method: message.method, params: message.params });
          const result = message.method === "thread/start"
            ? { thread: { id: "subagent-thread" } }
            : message.method === "turn/start" ? { turn: { id: "turn-1" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexAppServerChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_ephemeral000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    const started = await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "fast",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const threadStart = sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      serviceName: "codex-chat-subagent",
      serviceTier: "fast",
      ephemeral: true
    });
    const turnStart = sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ serviceTier: "fast" });
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("features.fast_mode=true");
    expect(args).toContain('service_tier="fast"');
    expect(threadStart?.params).not.toHaveProperty("persistExtendedHistory");
    expect(sent.some((message) => message.method === "thread/resume")).toBe(false);
    expect(job.backendThreadId).toBe("subagent-thread");
    await started.kill("SIGTERM");
    await backend.shutdown();
  });



  test("wires OpenRouter profile/provider without Fast tier config", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-backend-"));
    tempDirs.push(root);
    process.env.CODEX_HOME = root;
    await writeFile(join(root, "openrouter.config.toml"), `
model = "z-ai/glm-5.2"
model_provider = "openrouter"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "responses"
env_key = "OPENROUTER_API_KEY"
`);
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const spawn = vi.fn(() => fakeChild());
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    vi.doMock("ws", () => {
      class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        readyState = 1;
        constructor(readonly url: string) {
          super();
          queueMicrotask(() => this.emit("open"));
        }
        send(raw: string): void {
          const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          sent.push({ method: message.method, params: message.params });
          const result = message.method === "thread/start"
            ? { thread: { id: "openrouter-thread" } }
            : message.method === "turn/start" ? { turn: { id: "turn-openrouter" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }
        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexAppServerChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_openrouter0000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root,
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      serviceTierMode: "omit"
    };

    const started = await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "anthropic/claude-sonnet-4.5",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "omit",
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("--profile");
    expect(args).toContain("model_provider=\"openrouter\"");
    expect(args).toContain("model_providers.openrouter.base_url=\"https://openrouter.ai/api/v1\"");
    expect(args).toContain("model_providers.openrouter.wire_api=\"responses\"");
    expect(args).toContain("model_providers.openrouter.env_key=\"OPENROUTER_API_KEY\"");
    expect(args).not.toContain("features.fast_mode=true");
    expect(args).not.toContain('service_tier="fast"');
    const threadStart = sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ modelProvider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    expect(threadStart?.params).not.toHaveProperty("serviceTier");
    const turnStart = sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).toMatchObject({ model: "anthropic/claude-sonnet-4.5", effort: "medium" });
    expect(turnStart?.params).not.toHaveProperty("serviceTier");
    expect(turnStart?.params).not.toHaveProperty("modelProvider");
    await started.kill("SIGTERM");
    await backend.shutdown();
  });

  test("does not accept a stale websocket if the spawned subagent app-server exits during startup", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-backend-"));
    tempDirs.push(root);
    const child = fakeChild();
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      });
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    vi.doMock("ws", () => {
      class FakeWebSocket extends EventEmitter {
        static OPEN = 1;
        readyState = 1;

        constructor(readonly url: string) {
          super();
          queueMicrotask(() => this.emit("open"));
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> };
          const result = message.method === "thread/start"
            ? { thread: { id: "stale-subagent-thread" } }
            : message.method === "turn/start" ? { turn: { id: "turn-stale" } } : {};
          queueMicrotask(() => this.emit("message", JSON.stringify({ id: message.id, result })));
        }

        close(): void {
          this.readyState = 3;
          this.emit("close");
        }
      }
      return { default: FakeWebSocket };
    });
    const { CodexAppServerChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexAppServerChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_stale0000000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    await expect(backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow(/exited during startup/);

    expect(job.backendThreadId).toBeUndefined();
    await backend.shutdown();
  });
});

describe("Claude Agent SDK subagent backend", () => {
  test("streams an OAuth-only Claude session, writes events and final message, and strips API-key env", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    process.env.ANTHROPIC_API_KEY = "anthropic-api-secret";
    process.env.OPENROUTER_API_KEY = "openrouter-secret";
    const prompts: unknown[] = [];
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        const first = await iterator.next();
        prompts.push(first.value);
        yield fakeClaudeInitMessage();
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "assistant text" }] },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000002",
          session_id: "claude-session"
        };
        yield {
          type: "result",
          subtype: "success",
          result: "final answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000003",
          session_id: "claude-session"
        };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth", subscriptionType: "max" },
          fast_mode_state: "on"
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root);
    const started = await backend.start({
      job,
      assembledPrompt: "do claude work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "xhigh",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    expect(queryMock).toHaveBeenCalledOnce();
    const options = queryMock.mock.calls[0]?.[0].options as Record<string, unknown> & { env: Record<string, string | undefined>; settings: Record<string, unknown> };
    expect(options.model).toBe("claude-opus-4-8");
    expect(options.effort).toBe("xhigh");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toMatchObject({ fastMode: true, fastModePerSessionOptIn: true });
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret-value");
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(prompts[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "do claude work" }] }
    });
    expect(job.backendThreadId).toBe("claude-session");
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("final answer");
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_sdk_message");
    expect(events).toContain("serviceTierIgnored");
    expect(events).not.toContain("oauth-secret-value");
    expect(events).not.toContain("anthropic-api-secret");
    await backend.shutdown();
  });

  test("fast mode is only applied on models that support it", async () => {
    vi.resetModules();
    const { claudeFastModeSupported } = await import("../subagent-backends.js");
    expect(claudeFastModeSupported("claude-opus-4-8")).toBe(true);
    expect(claudeFastModeSupported("claude-opus-4-7")).toBe(true);
    expect(claudeFastModeSupported("opus")).toBe(true);
    expect(claudeFastModeSupported("")).toBe(true); // SDK default — let the SDK decide
    expect(claudeFastModeSupported("claude-fable-5")).toBe(false);
    expect(claudeFastModeSupported("fable")).toBe(false);
    expect(claudeFastModeSupported("claude-sonnet-5")).toBe(false);
    expect(claudeFastModeSupported("claude-haiku-4-5")).toBe(false);
  });

  test("a Fable job with serviceTier fast runs without fast-mode settings", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        await params.prompt[Symbol.asyncIterator]().next();
        yield fakeClaudeInitMessage();
        yield {
          type: "result",
          subtype: "success",
          result: "fable answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000021",
          session_id: "claude-session"
        };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth", subscriptionType: "max" }
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudefablefast00000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "fable task",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-fable-5",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    const options = queryMock.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.settings).toBeUndefined();
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain('"fastModeSettingApplied":false');
    await backend.shutdown();
  });

  test("a steer absorbed into the running turn settles after the grace window with the combined result", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const prompts: unknown[] = [];
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        prompts.push((await iterator.next()).value);
        yield fakeClaudeInitMessage();
        // The steer arrives early and is absorbed into the in-flight run:
        // one combined result, and then the SDK goes quiet awaiting input.
        prompts.push((await iterator.next()).value);
        yield {
          type: "result",
          subtype: "success",
          result: "summary text PINEAPPLE",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000031",
          session_id: "claude-session"
        };
        // Stay alive like the real CLI does in streaming-input mode — block
        // on the next input, which never comes.
        await iterator.next();
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth", subscriptionType: "max" }
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    config.subagents.claude!.steerSettleGraceMs = 100;
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudesteerabsorb000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "long task",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await backend.steer(job.id, "end with the word PINEAPPLE");

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("summary text PINEAPPLE");
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_turn_result_deferred");
    expect(events).toContain("claude_steer_settle_grace_elapsed");
    await backend.shutdown();
  });

  test("SDK activity during an in-flight grace settle aborts it and the steered turn's result wins", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";

    // Gate the events.jsonl append so settleFromGrace blocks mid-await while
    // we inject the steered turn's messages.
    const fsActual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let gateNextEventAppend = false;
    let releaseAppend!: () => void;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.doMock("node:fs/promises", () => ({
      ...fsActual,
      appendFile: vi.fn(async (path: unknown, ...rest: unknown[]) => {
        if (gateNextEventAppend && String(path).endsWith("events.jsonl")) {
          gateNextEventAppend = false;
          await appendGate;
        }
        return (fsActual.appendFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
      })
    }));

    // Push-driven fake SDK stream so the test controls emission timing.
    const sdkMessages: unknown[] = [];
    let wakeSdk: (() => void) | undefined;
    const pushSdk = (message: unknown) => {
      sdkMessages.push(message);
      wakeSdk?.();
    };
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
      async function* messages() {
        void params.prompt[Symbol.asyncIterator]().next();
        while (true) {
          while (sdkMessages.length === 0) {
            await new Promise<void>((resolve) => {
              wakeSdk = resolve;
            });
          }
          const next = sdkMessages.shift();
          if (next === null) return;
          yield next;
        }
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth", subscriptionType: "max" }
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    config.subagents.claude!.steerSettleGraceMs = 30;
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudegracerace00000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "long task",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    pushSdk(fakeClaudeInitMessage());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await backend.steer(job.id, "end with PINEAPPLE");
    // Turn 1's result arrives with the steer outstanding → deferred + timer.
    gateNextEventAppend = true;
    pushSdk({ type: "result", subtype: "success", result: "turn one answer", errors: [], uuid: "00000000-0000-4000-8000-000000000041", session_id: "claude-session" });
    // Let the 30ms grace timer fire; settleFromGrace blocks on the gated append.
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The steered turn now shows up while the grace settle is in flight…
    pushSdk({ type: "result", subtype: "success", result: "steered final answer", errors: [], uuid: "00000000-0000-4000-8000-000000000042", session_id: "claude-session" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // …then the blocked grace settle resumes and must abort.
    releaseAppend();

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("steered final answer");
    pushSdk(null); // end the fake SDK stream
    await backend.shutdown();
  });

  test("a steer queued mid-turn keeps the session open until the steered turn's result", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const prompts: unknown[] = [];
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        prompts.push((await iterator.next()).value);
        yield fakeClaudeInitMessage();
        // The steer arrives while turn 1 is still running…
        prompts.push((await iterator.next()).value);
        // …then turn 1 finishes, and the steered turn runs as turn 2.
        yield {
          type: "result",
          subtype: "success",
          result: "turn one answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000011",
          session_id: "claude-session"
        };
        yield {
          type: "result",
          subtype: "success",
          result: "steered final answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000012",
          session_id: "claude-session"
        };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth", subscriptionType: "max" }
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudesteer000000000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "long task",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await backend.steer(job.id, "actually also cover the edge cases");

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    expect(prompts[1]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "actually also cover the edge cases" }] }
    });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("steered final answer");
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_steer_enqueued");
    expect(events).toContain("claude_turn_result_deferred");
    await backend.shutdown();
  });

  test("accepts subscription OAuth when SDK init event reports apiKeySource none", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield fakeClaudeInitMessage("claude-session-none", "none");
        yield {
          type: "result",
          subtype: "success",
          result: "final answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000005",
          session_id: "claude-session-none"
        };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiProvider: "firstParty", subscriptionType: "Claude Max" },
          fast_mode_state: "off"
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudeapikeynone000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "do claude work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "medium",
      serviceTier: "fast",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    expect(job.backendThreadId).toBe("claude-session-none");
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("final answer");
    await backend.shutdown();
  });

  test("enqueues steering text as a follow-up SDK user message", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const prompts: unknown[] = [];
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        prompts.push((await iterator.next()).value);
        yield fakeClaudeInitMessage("claude-steer-session");
        prompts.push((await iterator.next()).value);
        yield {
          type: "result",
          subtype: "success",
          result: "steered result",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000004",
          session_id: "claude-steer-session"
        };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({ account: { apiKeySource: "oauth", apiProvider: "firstParty" } }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudesteer0000000000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "initial",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-sonnet-5",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await waitFor(() => prompts.length === 1 && job.activeTurnId === "claude-agent-sdk-stream");
    await backend.steer(job.id, "please narrow the fix");
    await waitFor(() => prompts.length === 2);
    expect(prompts[1]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "please narrow the fix" }] }
    });
    await expect(started.finished).resolves.toMatchObject({ code: 0 });
    await backend.shutdown();
  });

  test("interrupt calls SDK interrupt and close fallback on failure", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const interrupt = vi.fn().mockRejectedValue(new Error("interrupt failed"));
    const close = vi.fn(() => resolveClosed());
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
        async function* messages() {
          const iterator = params.prompt[Symbol.asyncIterator]();
          await iterator.next();
          yield fakeClaudeInitMessage("claude-interrupt-session");
          await closed;
        }
        return Object.assign(messages(), {
          initializationResult: vi.fn().mockResolvedValue({ account: { apiKeySource: "oauth", apiProvider: "firstParty" } }),
          interrupt,
          close
        });
      })
    }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudeinterrupt00000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "initial",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-sonnet-5",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await backend.interrupt(job.id, "test");
    expect(interrupt).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    await expect(started.finished).resolves.toMatchObject({ code: null, signal: "SIGTERM" });
    await backend.shutdown();
  });

  test("fails readiness before query start when OAuth is missing", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CONFIG_DIR = join(root, "missing-claude-config");
    const queryMock = vi.fn();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudenooauth000000000000000000");
    await expect(backend.start({
      job,
      assembledPrompt: "initial",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-sonnet-5",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    })).rejects.toThrow(/requires subscription OAuth/);
    expect(queryMock).not.toHaveBeenCalled();
    await expect(readFile(join(root, "events.jsonl"), "utf8")).resolves.toContain("claude_readiness_failed");
  });
});

describe("codex exec subagent backend", () => {
  test("skips Codex git repo checks for private assistant workspaces", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    const child = fakeChild() as ReturnType<typeof fakeChild> & {
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    child.stdin = { end: vi.fn() };
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_exec0000000000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "standard",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    expect(spawn).toHaveBeenCalledOnce();
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--skip-git-repo-check");
    expect(args.indexOf("--skip-git-repo-check")).toBeLessThan(args.indexOf("--cd"));
    await backend.shutdown();
  });



  test("wires OpenRouter profile for codex_exec without Fast tier config", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    const child = fakeChild() as ReturnType<typeof fakeChild> & { stdin: { end: ReturnType<typeof vi.fn> } };
    child.stdin = { end: vi.fn() };
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_execopenrouter000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root
    };

    await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "anthropic/claude-sonnet-4.5",
      effort: "medium",
      serviceTier: "fast",
      serviceTierMode: "omit",
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--profile");
    expect(args).toContain("openrouter");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet-4.5");
    expect(args).not.toContain("features.fast_mode=true");
    expect(args).not.toContain('service_tier="fast"');
    await backend.shutdown();
  });

  test("adds Codex Fast config for fast codex_exec subagents", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    const child = fakeChild() as ReturnType<typeof fakeChild> & {
      stdin: { end: ReturnType<typeof vi.fn> };
    };
    child.stdin = { end: vi.fn() };
    const spawn = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const job: SubagentJob = {
      id: "job_execfast0000000000000000000000000",
      profile: "implementer",
      route: "return_to_main",
      status: "running",
      promptPath: join(root, "prompt.md"),
      artifactDir: root,
      serviceTier: "fast"
    };

    await backend.start({
      job,
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "fast",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).toContain("features.fast_mode=true");
    expect(args).toContain('service_tier="fast"');
    await backend.shutdown();
  });

});
