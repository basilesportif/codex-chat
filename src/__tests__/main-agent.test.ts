import type { Logger } from "pino";
import { describe, expect, test, vi } from "vitest";
import type { BehaviorPack } from "../behavior.js";
import type { AppConfig } from "../config.js";
import { ClaudeMainAgentClient } from "../claude-main-agent.js";
import { AppServerCodexClient } from "../codex.js";
import { createMainAgentClient } from "../main-agent.js";
import type { StateStore } from "../state.js";
import type { MainAgentClient, MainAgentEvent, MainAgentProvider } from "../types.js";

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
