import type { Logger } from "pino";
import type { BehaviorPack } from "./behavior.js";
import { ClaudeMainAgentClient } from "./claude-main-agent.js";
import type { AppConfig } from "./config.js";
import { AppServerCodexClient, type CodexCrashHandler } from "./codex.js";
import type { StateStore } from "./state.js";
import type { MainAgentClient } from "./types.js";

export function assertMainAgentConfig(config: AppConfig): void {
  if (config.mainAgent.provider === "claude_agent_sdk" && config.employees.enabled) {
    throw new Error("Claude main loop does not support durable Employees yet");
  }
}

export function createMainAgentClient(
  config: AppConfig,
  state: StateStore,
  behavior: BehaviorPack,
  logger: Logger,
  onCrash?: CodexCrashHandler
): { client: MainAgentClient; appServerClient?: AppServerCodexClient } {
  assertMainAgentConfig(config);

  if (config.mainAgent.provider === "codex") {
    const appServerClient = new AppServerCodexClient(config, state, behavior, logger, onCrash);
    return { client: appServerClient, appServerClient };
  }

  return { client: new ClaudeMainAgentClient(config, state, behavior, logger, onCrash) };
}
