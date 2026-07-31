import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { BehaviorPack } from "../behavior.js";
import type { AppConfig } from "../config.js";
import { ClaudeMainAgentClient } from "../claude-main-agent.js";
import { AppServerCodexClient } from "../codex.js";
import { MainAgentSwitcher, createMainAgentClient } from "../main-agent.js";
import type { StateStore } from "../state.js";
import type { MainAgentClient, MainAgentEvent, MainAgentHealth, MainAgentProvider } from "../types.js";

const state = {} as StateStore;
const behavior = {} as BehaviorPack;
const logger = {} as Logger;

function configFor(provider: MainAgentProvider, employeesEnabled = false): AppConfig {
  return {
    mainAgent: { provider },
    employees: { enabled: employeesEnabled }
  } as unknown as AppConfig;
}

describe("main-agent client factory", () => {
  test("returns an AppServerCodexClient for the codex provider", () => {
    const result = createMainAgentClient(configFor("codex"), state, behavior, logger, () => undefined);

    expect(result.client).toBeInstanceOf(AppServerCodexClient);
    expect(result.appServerClient).toBe(result.client);
  });

  test("returns a ClaudeMainAgentClient for the Claude Agent SDK provider", () => {
    const result = createMainAgentClient(
      configFor("claude_agent_sdk"),
      state,
      behavior,
      logger,
      () => undefined
    );

    expect(result.client).toBeInstanceOf(ClaudeMainAgentClient);
    expect(result.appServerClient).toBeUndefined();
  });

  test("rejects durable Employees with the Claude main loop", () => {
    expect(() =>
      createMainAgentClient(configFor("claude_agent_sdk", true), state, behavior, logger, () => undefined)
    ).toThrow("Claude main loop does not support durable Employees yet");
  });
});

type FakeMainClient = MainAgentClient & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  health: ReturnType<typeof vi.fn>;
  resetSession: ReturnType<typeof vi.fn>;
  getRecentLogs: ReturnType<typeof vi.fn>;
  consumePendingBehaviorRefresh: ReturnType<typeof vi.fn>;
};

function fakeMainClient(
  provider: MainAgentProvider,
  events: () => AsyncIterable<MainAgentEvent> = async function* () {
    yield { type: "final", text: provider };
  }
): FakeMainClient {
  const health: MainAgentHealth = {
    ok: true,
    transport: provider === "codex" ? "app-server" : "claude-agent-sdk",
    provider,
    sessionId: `${provider}-session`
  };
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockResolvedValue(health),
    sendTurn: vi.fn(events),
    resetSession: vi.fn().mockResolvedValue(health),
    getRecentLogs: vi.fn().mockReturnValue([`${provider} log`]),
    consumePendingBehaviorRefresh: vi.fn().mockReturnValue(`${provider} refresh`)
  } as FakeMainClient;
}

function switcherHarness(options: {
  configured?: MainAgentProvider;
  override?: MainAgentProvider;
  employeesEnabled?: boolean;
  graceMs?: number;
  clients?: Partial<Record<MainAgentProvider, FakeMainClient>>;
  onCrash?: (reason: string) => void;
} = {}) {
  const configured = options.configured ?? "codex";
  const clients = {
    codex: options.clients?.codex ?? fakeMainClient("codex"),
    claude_agent_sdk: options.clients?.claude_agent_sdk ?? fakeMainClient("claude_agent_sdk")
  };
  const crashHandlers = new Map<MainAgentProvider, (reason: string) => void>();
  const persistOverride = vi.fn().mockResolvedValue(undefined);
  const createClient = vi.fn((provider: MainAgentProvider, onCrash: (reason: string) => void) => {
    crashHandlers.set(provider, onCrash);
    return clients[provider];
  });
  const switcher = new MainAgentSwitcher({
    configuredProvider: configured,
    employeesEnabled: options.employeesEnabled ?? false,
    createClient,
    loadOverride: vi.fn().mockResolvedValue(options.override),
    persistOverride,
    onCrash: options.onCrash,
    switchGraceMs: options.graceMs
  });
  return { switcher, clients, createClient, persistOverride, crashHandlers };
}

describe("MainAgentSwitcher", () => {
  test("delegates the MainAgentClient contract to the active inner client", async () => {
    const { switcher, clients } = switcherHarness();

    await switcher.start();
    const events: MainAgentEvent[] = [];
    for await (const event of switcher.sendTurn({ text: "hello" })) events.push(event);

    expect(events).toEqual([{ type: "final", text: "codex" }]);
    expect(await switcher.health()).toMatchObject({ provider: "codex", sessionId: "codex-session" });
    expect(await switcher.resetSession("test")).toMatchObject({ provider: "codex" });
    expect(switcher.getRecentLogs(3, true)).toEqual(["codex log"]);
    expect(switcher.consumePendingBehaviorRefresh()).toBe("codex refresh");
    await switcher.stop();

    expect(clients.codex.start).toHaveBeenCalledOnce();
    expect(clients.codex.resetSession).toHaveBeenCalledWith("test");
    expect(clients.codex.getRecentLogs).toHaveBeenCalledWith(3, true);
    expect(clients.codex.stop).toHaveBeenCalledOnce();
  });

  test("same-provider switches are no-ops", async () => {
    const { switcher, clients, createClient, persistOverride } = switcherHarness();
    await switcher.start();

    const health = await switcher.switchProvider("codex", "test");

    expect(health).toMatchObject({ provider: "codex", sessionId: "codex-session" });
    expect(createClient).toHaveBeenCalledOnce();
    expect(clients.codex.stop).not.toHaveBeenCalled();
    expect(persistOverride).not.toHaveBeenCalled();
  });

  test("switches the inner client and persists the runtime override", async () => {
    const { switcher, clients, persistOverride } = switcherHarness();
    await switcher.start();

    const health = await switcher.switchProvider("claude_agent_sdk", "telegram:1");

    expect(clients.codex.stop).toHaveBeenCalledOnce();
    expect(clients.claude_agent_sdk.start).toHaveBeenCalledOnce();
    expect(persistOverride).toHaveBeenCalledWith("claude_agent_sdk", "telegram:1");
    expect(health).toMatchObject({ provider: "claude_agent_sdk", sessionId: "claude_agent_sdk-session" });
    expect((await switcher.providerStatus()).source).toBe("override");
  });

  test("loads the persisted override before starting the configured provider", async () => {
    const { switcher, clients } = switcherHarness({ override: "claude_agent_sdk" });

    await switcher.start();

    expect(switcher.provider).toBe("claude_agent_sdk");
    expect(clients.codex.start).not.toHaveBeenCalled();
    expect(clients.claude_agent_sdk.start).toHaveBeenCalledOnce();
  });

  test("waits for an in-flight turn, then interrupts it after the grace period", async () => {
    vi.useFakeTimers();
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const codex = fakeMainClient("codex", async function* () {
      await turnGate;
      yield { type: "final", text: "late" };
    });
    codex.stop.mockImplementation(async () => releaseTurn());
    const { switcher, clients } = switcherHarness({ graceMs: 15_000, clients: { codex } });
    await switcher.start();
    const pendingTurn = switcher.sendTurn({ text: "stuck" })[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(0);

    const switching = switcher.switchProvider("claude_agent_sdk", "test");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(codex.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await switching;

    expect(codex.stop).toHaveBeenCalledOnce();
    expect(clients.claude_agent_sdk.start).toHaveBeenCalledOnce();
    await pendingTurn;
    vi.useRealTimers();
  });

  test("rolls back when the new provider fails to start", async () => {
    const claude = fakeMainClient("claude_agent_sdk");
    claude.start.mockRejectedValue(new Error("claude start failed"));
    const { switcher, clients, persistOverride } = switcherHarness({ clients: { claude_agent_sdk: claude } });
    await switcher.start();

    await expect(switcher.switchProvider("claude_agent_sdk", "test"))
      .rejects.toThrow("claude start failed; rolled back to codex");

    expect(switcher.provider).toBe("codex");
    expect(clients.codex.start).toHaveBeenCalledTimes(2);
    expect(persistOverride).not.toHaveBeenCalled();
  });

  test("surfaces both the switch and rollback errors", async () => {
    const codex = fakeMainClient("codex");
    codex.start.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("codex rollback failed"));
    const claude = fakeMainClient("claude_agent_sdk");
    claude.start.mockRejectedValue(new Error("claude start failed"));
    const { switcher } = switcherHarness({ clients: { codex, claude_agent_sdk: claude } });
    await switcher.start();

    await expect(switcher.switchProvider("claude_agent_sdk", "test"))
      .rejects.toThrow("claude start failed; rollback to codex also failed: codex rollback failed");
    expect(switcher.provider).toBe("codex");
  });

  test("routes crashes only from the active inner client", async () => {
    const onCrash = vi.fn();
    const { switcher, crashHandlers } = switcherHarness({ onCrash });
    await switcher.start();
    const staleCrash = crashHandlers.get("codex")!;
    await switcher.switchProvider("claude_agent_sdk", "test");

    staleCrash("old crashed");
    crashHandlers.get("claude_agent_sdk")!("active crashed");

    expect(onCrash).toHaveBeenCalledOnce();
    expect(onCrash).toHaveBeenCalledWith("active crashed", undefined);
  });

  test("refuses Claude while durable Employees are enabled", async () => {
    const { switcher, clients, persistOverride } = switcherHarness({ employeesEnabled: true });
    await switcher.start();

    await expect(switcher.switchProvider("claude_agent_sdk", "test"))
      .rejects.toThrow("Cannot switch the main provider to Claude while durable Employees are enabled");
    expect(clients.codex.stop).not.toHaveBeenCalled();
    expect(persistOverride).not.toHaveBeenCalled();
  });
});

describe("main-agent minimal contract parity", () => {
  test("start → turn → final → health → stop has the same event shape for Codex-shaped and fake-backed Claude clients", async () => {
    vi.resetModules();
    const previousOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "contract-oauth-token";
    let releaseQuery!: () => void;
    const query = vi.fn((params: { prompt: AsyncIterable<unknown> }) => {
      async function* messages() {
        yield {
          type: "system",
          subtype: "init",
          apiKeySource: "oauth",
          session_id: "contract-claude-session"
        };
        await params.prompt[Symbol.asyncIterator]().next();
        yield {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
          session_id: "contract-claude-session"
        };
        yield {
          type: "result",
          subtype: "success",
          result: "okay",
          errors: [],
          session_id: "contract-claude-session"
        };
        await new Promise<void>((resolve) => {
          releaseQuery = resolve;
        });
      }
      const iterator = messages();
      return Object.assign(iterator, {
        initializationResult: vi.fn().mockResolvedValue({
          account: { apiKeySource: "oauth", apiProvider: "firstParty" }
        }),
        interrupt: vi.fn().mockResolvedValue(undefined),
        close: vi.fn(() => releaseQuery?.())
      });
    });
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query }));
    const { ClaudeMainAgentClient: MockedClaudeMainAgentClient } = await import("../claude-main-agent.js");

    const claudeConfig = {
      rootDir: "/tmp",
      service: { workspace: "/tmp", stateDir: "/tmp", ipcSocket: "/tmp/codex-chat-contract.sock" },
      mainAgent: {
        provider: "claude_agent_sdk",
        claude: {
          model: "claude-sonnet-5",
          effort: "high",
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          allowedTools: ["Read"],
          disallowedTools: [],
          settingSources: [],
          pathToClaudeCodeExecutable: "",
          mainSessionName: "contract-claude",
          startupTimeoutSec: 2
        }
      },
      codex: { providerApiKeyEnvNames: [] }
    } as unknown as AppConfig;
    const claudeState = {
      root: "/tmp",
      getCodexSession: vi.fn().mockResolvedValue(undefined),
      getCodexSessionBehaviorHash: vi.fn().mockResolvedValue(undefined),
      setCodexSession: vi.fn().mockResolvedValue(undefined),
      clearCodexSession: vi.fn().mockResolvedValue(undefined)
    } as unknown as StateStore;
    const claudeBehavior = {
      loadBootstrapPrompt: vi.fn().mockResolvedValue("contract bootstrap"),
      hash: vi.fn().mockResolvedValue("contract hash")
    } as unknown as BehaviorPack;
    const contractLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const claude = new MockedClaudeMainAgentClient(
      claudeConfig,
      claudeState,
      claudeBehavior,
      contractLogger
    );

    let codexStarted = false;
    let codexStopped = false;
    const codexShaped: MainAgentClient = {
      async start() {
        codexStarted = true;
      },
      async stop() {
        codexStopped = true;
      },
      async health() {
        return { ok: codexStarted && !codexStopped, transport: "app-server", provider: "codex", sessionId: "contract-codex" };
      },
      async *sendTurn() {
        yield { type: "delta", text: "ok" } as const;
        yield { type: "final", text: "okay" } as const;
      }
    };

    async function exercise(client: MainAgentClient) {
      await client.start();
      const events: MainAgentEvent[] = [];
      for await (const event of client.sendTurn({ text: "contract turn" })) events.push(event);
      const health = await client.health();
      await client.stop();
      return { events, health };
    }

    const codexResult = await exercise(codexShaped);
    const claudeResult = await exercise(claude);

    expect(claudeResult.events).toEqual(codexResult.events);
    expect(claudeResult.events.map((event) => event.type)).toEqual(["delta", "final"]);
    expect(codexResult.health.ok).toBe(true);
    expect(claudeResult.health).toMatchObject({
      ok: true,
      transport: "claude-agent-sdk",
      provider: "claude_agent_sdk",
      sessionId: "contract-claude-session"
    });
    expect(codexStopped).toBe(true);
    if (previousOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOauthToken;
    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  });
});
