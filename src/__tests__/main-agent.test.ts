import type { Logger } from "pino";
import { describe, expect, test } from "vitest";
import type { BehaviorPack } from "../behavior.js";
import type { AppConfig } from "../config.js";
import { AppServerCodexClient } from "../codex.js";
import { createMainAgentClient } from "../main-agent.js";
import type { StateStore } from "../state.js";
import type { MainAgentProvider } from "../types.js";

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

  test("rejects the not-yet-implemented Claude Agent SDK provider", () => {
    expect(() =>
      createMainAgentClient(configFor("claude_agent_sdk"), state, behavior, logger, () => undefined)
    ).toThrow(
      "mainAgent.provider=claude_agent_sdk is not implemented yet (landing in the next change); set mainAgent.provider=codex."
    );
  });

  test("rejects durable Employees with the Claude main loop", () => {
    expect(() =>
      createMainAgentClient(configFor("claude_agent_sdk", true), state, behavior, logger, () => undefined)
    ).toThrow("Claude main loop does not support durable Employees yet");
  });
});
