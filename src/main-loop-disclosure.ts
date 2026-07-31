import type { AppConfig } from "./config.js";
import type { MainAgentProvider } from "./types.js";

export interface MainLoopRuntimeIdentity {
  provider: MainAgentProvider;
  model: string;
  effort: string;
  tier: string;
}

export function mainLoopRuntimeIdentity(config: AppConfig, provider: MainAgentProvider): MainLoopRuntimeIdentity {
  if (provider === "claude_agent_sdk") {
    return {
      provider,
      model: config.mainAgent.claude.model,
      effort: config.mainAgent.claude.effort,
      tier: "standard"
    };
  }

  return {
    provider,
    model: config.codex.model,
    effort: config.codex.effort,
    tier: config.codex.serviceTier
  };
}

export function formatRuntimeIdentityBlock(id: MainLoopRuntimeIdentity): string {
  return `Main-loop runtime (service-stamped, authoritative): provider=${id.provider} model=${id.model} effort=${id.effort} tier=${id.tier}. When disclosing main_loop status, use exactly these values — never a value remembered from earlier turns.`;
}

const DISCLOSURE_VALUE = String.raw`[^\s,\]]+`;
const COLON_DISCLOSURE = new RegExp(
  String.raw`\bmain_loop\s*:\s*model\s*=\s*${DISCLOSURE_VALUE}\s+effort\s*=\s*${DISCLOSURE_VALUE}\s+tier\s*=\s*${DISCLOSURE_VALUE}`,
  "g"
);
const BRACKET_DISCLOSURE = new RegExp(
  String.raw`\bmain_loop\s*\[\s*model\s*=\s*${DISCLOSURE_VALUE}\s*,?\s*effort\s*=\s*${DISCLOSURE_VALUE}\s*,?\s*tier\s*=\s*${DISCLOSURE_VALUE}\s*\]`,
  "g"
);

export function stampMainLoopDisclosure(text: string, id: MainLoopRuntimeIdentity): string {
  const canonical = `main_loop: model=${id.model} effort=${id.effort} tier=${id.tier}`;
  return text.replace(COLON_DISCLOSURE, canonical).replace(BRACKET_DISCLOSURE, canonical);
}
