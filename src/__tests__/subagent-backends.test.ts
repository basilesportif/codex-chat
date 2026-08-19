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
  delete process.env.BRAIN_SUBJECT_ID;
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
    implementerModel: "sonnet",
    investigatorModel: "sonnet",
    reviewerModel: "claude-opus-4-8",
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

/**
 * Push-driven fake Claude Agent SDK query: the test controls exactly when each
 * SDK message is emitted, and every user turn pushed into the streaming input
 * is captured in `prompts`.
 */
function pushDrivenSdkStream() {
  const pending: unknown[] = [];
  const prompts: unknown[] = [];
  let wake: (() => void) | undefined;
  const push = (message: unknown): void => {
    pending.push(message);
    wake?.();
  };
  const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    const iterator = params.prompt[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const next = await iterator.next().catch(() => ({ done: true, value: undefined }));
        if (next.done) return;
        prompts.push(next.value);
      }
    })();
    async function* messages() {
      for (;;) {
        while (pending.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const next = pending.shift();
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
  return { queryMock, prompts, push, end: () => push(null) };
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
    process.env.BRAIN_SUBJECT_ID = "person:stale";
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
      brainSubjectId: "person:person_tim",
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const args = spawn.mock.calls[0]?.[1] as string[];
    const env = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.BRAIN_SUBJECT_ID).toBe("person:person_tim");
    expect(env.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
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
    process.env.BRAIN_SUBJECT_ID = "person:stale";
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

    const env = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env).not.toHaveProperty("BRAIN_SUBJECT_ID");
    expect(env.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
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
    process.env.BRAIN_SUBJECT_ID = "person:stale";
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

    const { ClaudeAgentSdkChildAgentBackend, nativeAgentGuidance } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    config.subagents.claude!.implementerModel = "haiku";
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root);
    const startInput: Parameters<typeof backend.start>[0] = {
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
      brainSubjectId: "person:person_tim",
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    };
    const started = await backend.start(startInput);

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    expect(queryMock).toHaveBeenCalledOnce();
    const options = queryMock.mock.calls[0]?.[0].options as Record<string, unknown> & { env: Record<string, string | undefined>; settings: Record<string, unknown> };
    expect(options.model).toBe("claude-opus-4-8");
    expect(options.effort).toBe("xhigh");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toMatchObject({ fastMode: true, fastModePerSessionOptIn: true });
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret-value");
    expect(options.env.BRAIN_SUBJECT_ID).toBe("person:person_tim");
    expect(options.env.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
    expect(options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options.env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(options.tools).toEqual(["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "Agent"]);
    expect(options.allowedTools).toEqual(options.tools);
    expect(options.disallowedTools).toEqual([]);
    const agents = options.agents as Record<string, {
      model?: string;
      effort?: string;
      tools?: string[];
      disallowedTools?: string[];
    }>;
    expect(Object.keys(agents)).toEqual(["implementer", "investigator", "reviewer"]);
    expect(agents).toMatchObject({
      implementer: {
        description: expect.stringContaining("Implement a bounded"),
        model: "haiku",
        effort: "high",
        tools: ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "MultiEdit"]
      },
      investigator: {
        description: expect.stringContaining("read-only"),
        model: "sonnet",
        effort: "medium",
        tools: ["Read", "Glob", "Grep", "Bash"],
        disallowedTools: ["Write", "Edit", "MultiEdit"]
      },
      reviewer: {
        description: expect.stringContaining("Review code changes"),
        model: "claude-opus-4-8",
        effort: "high",
        tools: ["Read", "Glob", "Grep", "Bash"],
        disallowedTools: ["Write", "Edit", "MultiEdit"],
        prompt: expect.stringContaining("findings first")
      }
    });
    expect(agents.implementer?.tools).toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(agents.investigator?.tools).not.toEqual(expect.arrayContaining(["Write", "Edit"]));
    expect(agents.reviewer?.tools).not.toEqual(expect.arrayContaining(["Write", "Edit"]));
    const guidance = nativeAgentGuidance(agents as never, 2);
    const initialText = (prompts[0] as { message: { content: Array<{ text: string }> } }).message.content[0]?.text;
    expect(initialText).toBe(`do claude work\n\n${guidance}`);
    expect(initialText).toContain("implementer (haiku)");
    expect(startInput.assembledPrompt).toBe("do claude work");
    expect(JSON.stringify(job)).not.toContain("Native subagents");
    expect(job.backendThreadId).toBe("claude-session");
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("final answer");
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_sdk_message");
    expect(events).toContain("serviceTierIgnored");
    expect(events).not.toContain("oauth-secret-value");
    expect(events).not.toContain("anthropic-api-secret");
    await backend.shutdown();
  });

  test("strips stale BRAIN_SUBJECT_ID from Claude Agent SDK env when no subject is set", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    process.env.BRAIN_SUBJECT_ID = "person:stale";
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        const iterator = params.prompt[Symbol.asyncIterator]();
        await iterator.next();
        yield fakeClaudeInitMessage();
        yield {
          type: "result",
          subtype: "success",
          result: "final answer",
          errors: [],
          uuid: "00000000-0000-4000-8000-000000000004",
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
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const started = await backend.start({
      job: subagentJob(root, "job_claudenobrain000000000000000000"),
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
    const options = queryMock.mock.calls[0]?.[0].options as Record<string, unknown> & { env: Record<string, string | undefined> };
    expect(options.env).not.toHaveProperty("BRAIN_SUBJECT_ID");
    expect(options.env.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
    await backend.shutdown();
  });

  test("forces the native Agent tool even when a stale config narrows or disallows it", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      async function* messages() {
        await params.prompt[Symbol.asyncIterator]().next();
        yield fakeClaudeInitMessage();
        yield { type: "result", subtype: "success", result: "done", errors: [], uuid: "00000000-0000-4000-8000-000000000009", session_id: "claude-session" };
      }
      return Object.assign(messages(), {
        initializationResult: vi.fn().mockResolvedValue({ account: { apiKeySource: "oauth", apiProvider: "firstParty", tokenSource: "oauth" } }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn()
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    config.subagents.claude!.allowedTools = ["Read"];
    config.subagents.claude!.disallowedTools = ["Agent", "Bash"];
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudeagenttool0000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "do claude work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-4-8",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    const options = queryMock.mock.calls[0]?.[0].options as Record<string, unknown>;
    expect(options.tools).toEqual(["Read", "Agent"]);
    expect(options.allowedTools).toEqual(["Read", "Agent"]);
    expect(options.disallowedTools).toEqual(["Bash"]);
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain('"agentToolEnabled":true');
    expect(events).toContain('"nativeAgents":["implementer","investigator","reviewer"]');
    await backend.shutdown();
  });

  test("fast mode is only applied on models that support it", async () => {
    vi.resetModules();
    const { claudeFastModeSupported } = await import("../subagent-backends.js");
    expect(claudeFastModeSupported("claude-opus-5")).toBe(true);
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

  test("a result emitted while a nested agent is still live does not complete the job; the post-nested result wins", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const stream = pushDrivenSdkStream();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: stream.queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    // Long enough that the drain nudge never fires before the real result.
    config.subagents.claude!.steerSettleGraceMs = 5_000;
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudenestedlive0000000000000000");
    const onJobUpdated = vi.fn().mockResolvedValue(undefined);
    const started = await backend.start({
      job,
      assembledPrompt: "fix the bug",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-5",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated
    });

    stream.push(fakeClaudeInitMessage());
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "task-1", task_type: "local_agent", description: "investigator: find the root cause" },
        { task_id: "task-2", task_type: "local_bash", description: "npm run dev" }
      ],
      uuid: "00000000-0000-4000-8000-000000000051",
      session_id: "claude-session"
    });
    // The parent reports back while the nested investigator is still running.
    stream.push({
      type: "result",
      subtype: "success",
      result: "spawned an investigator; nothing fixed yet",
      errors: [],
      uuid: "00000000-0000-4000-8000-000000000052",
      session_id: "claude-session"
    });

    await waitFor(() => job.waitingOnNestedAgents === 1);
    let settled = false;
    void started.finished.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(started.isAlive()).toBe(true);
    expect(job.activeTurnId).toBe("claude-agent-sdk-stream");
    await expect(readFile(join(root, "last-message.md"), "utf8").catch(() => "")).resolves.toBe("");

    // The nested agent finishes; the backgrounded dev server is still running
    // and must not keep holding the job.
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-2", task_type: "local_bash", description: "npm run dev" }],
      uuid: "00000000-0000-4000-8000-000000000053",
      session_id: "claude-session"
    });
    stream.push({
      type: "result",
      subtype: "success",
      result: "investigator finished; bug fixed and tests pass",
      errors: [],
      uuid: "00000000-0000-4000-8000-000000000054",
      session_id: "claude-session"
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("investigator finished; bug fixed and tests pass");
    expect(job.waitingOnNestedAgents).toBeUndefined();
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_result_held_for_nested_agents");
    expect(events).toContain("claude_background_tasks_changed");
    stream.end();
    await backend.shutdown();
  });

  test("a live backgrounded Bash task does not hold a successful result", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const stream = pushDrivenSdkStream();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: stream.queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudebashbackground000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "start the dev server and verify the fix",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-5",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    stream.push(fakeClaudeInitMessage());
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "task-1", task_type: "local_bash", description: "npm run dev" },
        { task_id: "task-2", task_type: "local_workflow", description: "spec" }
      ],
      uuid: "00000000-0000-4000-8000-000000000071",
      session_id: "claude-session"
    });
    stream.push({
      type: "result",
      subtype: "success",
      result: "fix verified against the dev server",
      errors: [],
      uuid: "00000000-0000-4000-8000-000000000072",
      session_id: "claude-session"
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("fix verified against the dev server");
    expect(job.waitingOnNestedAgents).toBeUndefined();
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_background_tasks_changed");
    expect(events).not.toContain("claude_result_held_for_nested_agents");
    stream.end();
    await backend.shutdown();
  });

  test("a parent that stays quiet after its nested agents drain is nudged for the post-nested report", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const stream = pushDrivenSdkStream();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: stream.queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    config.subagents.claude!.steerSettleGraceMs = 30;
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudenesteddrain000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "fix the bug",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-5",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    stream.push(fakeClaudeInitMessage());
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-1", task_type: "local_agent", description: "implementer: apply the fix" }],
      uuid: "00000000-0000-4000-8000-000000000061",
      session_id: "claude-session"
    });
    stream.push({
      type: "result",
      subtype: "success",
      result: "dispatched an implementer",
      errors: [],
      uuid: "00000000-0000-4000-8000-000000000062",
      session_id: "claude-session"
    });
    await waitFor(() => job.waitingOnNestedAgents === 1);
    stream.push({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [],
      uuid: "00000000-0000-4000-8000-000000000063",
      session_id: "claude-session"
    });

    // The parent never woke on its own; the drain timer nudges it.
    await waitFor(() => stream.prompts.length === 2, 200);
    expect(stream.prompts[1]).toMatchObject({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: expect.stringContaining("every nested agent you launched has finished") }] }
    });

    stream.push({
      type: "result",
      subtype: "success",
      result: "implementer's fix reviewed; tests pass",
      errors: [],
      uuid: "00000000-0000-4000-8000-000000000064",
      session_id: "claude-session"
    });

    await expect(started.finished).resolves.toMatchObject({ code: 0, signal: null });
    await expect(readFile(join(root, "last-message.md"), "utf8")).resolves.toBe("implementer's fix reviewed; tests pass");
    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_nested_agents_drained_nudge");
    stream.end();
    await backend.shutdown();
  });

  test("rewrites nested Agent tool calls to run in the foreground", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const stream = pushDrivenSdkStream();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: stream.queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new ClaudeAgentSdkChildAgentBackend(enableClaude(testConfig(root)), fakeLogger() as never);
    const job = subagentJob(root, "job_claudeforeground0000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "fix the bug",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-5",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const options = stream.queryMock.mock.calls[0]?.[0].options as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<(input: unknown, id?: string, opts?: unknown) => Promise<unknown>> }> };
    };
    const matcher = options.hooks?.PreToolUse?.[0];
    expect(matcher?.matcher).toBe("Agent");
    const hook = matcher?.hooks[0];
    const agentDecision = await hook?.({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: "toolu_1",
      tool_input: { prompt: "investigate", subagent_type: "investigator", run_in_background: true }
    });
    expect(agentDecision).toMatchObject({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { prompt: "investigate", subagent_type: "investigator", run_in_background: false }
      }
    });
    const bashDecision = await hook?.({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_2",
      tool_input: { command: "ls", run_in_background: true }
    });
    expect(bashDecision).toEqual({ continue: true });

    // The child preamble also forbids backgrounded nested agents.
    const initialPrompt = (stream.prompts[0] as { message: { content: Array<{ text: string }> } }).message.content[0]?.text ?? "";
    expect(initialPrompt).toContain("run_in_background: false");
    expect(initialPrompt).toContain("Do not send your final report while any nested agent is still running");

    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_nested_agent_forced_foreground");
    stream.end();
    await started.kill("SIGTERM");
    await backend.shutdown();
  });

  test("caps concurrent nested agents: the call past the cap is denied, and a slot frees when one finishes", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-claude-"));
    tempDirs.push(root);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret-value";
    const stream = pushDrivenSdkStream();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: stream.queryMock }));

    const { ClaudeAgentSdkChildAgentBackend } = await import("../subagent-backends.js");
    const config = enableClaude(testConfig(root));
    // Cap of 2 is the default; set it explicitly to prove it is configurable.
    config.subagents.claude!.maxConcurrentNestedAgents = 2;
    const backend = new ClaudeAgentSdkChildAgentBackend(config, fakeLogger() as never);
    const job = subagentJob(root, "job_claudefanoutcap0000000000000000");
    const started = await backend.start({
      job,
      assembledPrompt: "investigate three things",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "claude-opus-5",
      effort: "high",
      serviceTier: "fast",
      serviceTierMode: "auto",
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    });

    const options = stream.queryMock.mock.calls[0]?.[0].options as {
      hooks?: Record<string, Array<{ matcher?: string; hooks: Array<(input: unknown) => Promise<never>> }>>;
    };
    const pre = options.hooks?.PreToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<Record<string, never>>;
    const post = options.hooks?.PostToolUse?.[0]?.hooks[0] as (input: unknown) => Promise<Record<string, never>>;
    expect(options.hooks?.PostToolUse?.[0]?.matcher).toBe("Agent");
    expect(options.hooks?.PostToolUseFailure?.[0]?.matcher).toBe("Agent");

    const agentCall = (toolUseId: string) => ({
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_use_id: toolUseId,
      tool_input: { prompt: "investigate", subagent_type: "investigator", run_in_background: true }
    });

    // The model fires three Agent calls in one message (the 2026-08-18 OOM
    // shape): the first two are admitted and rewritten to the foreground.
    for (const id of ["toolu_1", "toolu_2"]) {
      expect(await pre(agentCall(id))).toMatchObject({
        continue: true,
        hookSpecificOutput: { updatedInput: { run_in_background: false } }
      });
    }
    const denied = await pre(agentCall("toolu_3")) as {
      continue: boolean;
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(denied.continue).toBe(true);
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("allows at most 2 at a time");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("was NOT started");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("Wait for a running nested agent to finish");

    // One finishes -> the slot frees and the next call is admitted again.
    await post({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_1", tool_input: {}, tool_response: {} });
    expect(await pre(agentCall("toolu_4"))).toMatchObject({
      continue: true,
      hookSpecificOutput: { updatedInput: { run_in_background: false } }
    });
    // ...and the cap holds again at the same ceiling.
    expect(await pre(agentCall("toolu_5"))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" }
    });

    // Non-Agent tools are untouched by the cap.
    expect(await pre({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_6", tool_input: { command: "ls" } }))
      .toEqual({ continue: true });

    const events = await readFile(join(root, "events.jsonl"), "utf8");
    expect(events).toContain("claude_nested_agent_fanout_capped");
    // The launch prompt states the same limit the hook enforces.
    const initialPrompt = (stream.prompts[0] as { message: { content: Array<{ text: string }> } }).message.content[0]?.text ?? "";
    expect(initialPrompt).toContain("Never run more than 2 nested agents at once");
    stream.end();
    await started.kill("SIGTERM");
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
    const queryMock = vi.fn((params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
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
      });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

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

    const options = queryMock.mock.calls[0]?.[0].options as { agents: Record<string, unknown> };
    expect(Object.keys(options.agents)).toEqual(["implementer", "investigator", "reviewer"]);
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

  test("passes BRAIN_SUBJECT_ID to codex_exec only when a subject is set", async () => {
    vi.resetModules();
    const root = await mkdtemp(join(tmpdir(), "codex-chat-subagent-exec-"));
    tempDirs.push(root);
    process.env.BRAIN_SUBJECT_ID = "person:stale";
    const children: Array<ReturnType<typeof fakeChild> & { stdin: { end: ReturnType<typeof vi.fn> } }> = [];
    const spawn = vi.fn(() => {
      const child = fakeChild() as ReturnType<typeof fakeChild> & { stdin: { end: ReturnType<typeof vi.fn> } };
      child.stdin = { end: vi.fn() };
      children.push(child);
      return child;
    });
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn };
    });
    const { CodexExecChildAgentBackend } = await import("../subagent-backends.js");
    const backend = new CodexExecChildAgentBackend(testConfig(root), fakeLogger() as never);
    const baseInput = {
      assembledPrompt: "do work",
      lastMessagePath: join(root, "last-message.md"),
      stdoutPath: join(root, "events.jsonl"),
      stderrPath: join(root, "stderr.log"),
      appServerLogPath: join(root, "app-server.log"),
      model: "gpt-test",
      effort: "medium",
      serviceTier: "standard" as const,
      images: [],
      onJobUpdated: vi.fn().mockResolvedValue(undefined)
    };

    await backend.start({
      ...baseInput,
      job: subagentJob(root, "job_execbrain000000000000000000000"),
      brainSubjectId: "person:person_tim"
    });
    await backend.start({
      ...baseInput,
      job: subagentJob(root, "job_execnobrain0000000000000000000")
    });

    const firstEnv = spawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    const secondEnv = spawn.mock.calls[1]?.[2]?.env as NodeJS.ProcessEnv;
    expect(firstEnv.BRAIN_SUBJECT_ID).toBe("person:person_tim");
    expect(firstEnv.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
    expect(secondEnv.BRAIN_IPC_SOCKET).toBe(join(root, "data/run/codex-chat.sock"));
    expect(secondEnv).not.toHaveProperty("BRAIN_SUBJECT_ID");
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
