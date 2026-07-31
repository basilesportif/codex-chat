import { describe, expect, test } from "vitest";
import type { AppConfig } from "../config.js";
import {
  formatRuntimeIdentityBlock,
  mainLoopRuntimeIdentity,
  stampMainLoopDisclosure,
  type MainLoopRuntimeIdentity
} from "../main-loop-disclosure.js";

const config = {
  mainAgent: {
    claude: {
      model: "claude-sonnet-5",
      effort: "high"
    }
  },
  codex: {
    model: "gpt-5.6-luna",
    effort: "xhigh",
    serviceTier: "fast"
  }
} as AppConfig;

const claudeIdentity: MainLoopRuntimeIdentity = {
  provider: "claude_agent_sdk",
  model: "claude-sonnet-5",
  effort: "high",
  tier: "standard"
};

describe("main-loop runtime disclosure", () => {
  test("rewrites the literal false Claude main-loop status while preserving the todos body", () => {
    const input = "main_loop: model=gpt-5.6-luna effort=xhigh tier=fast\n\nYou have 5 todos:";

    expect(stampMainLoopDisclosure(input, claudeIdentity)).toBe(
      "main_loop: model=claude-sonnet-5 effort=high tier=standard\n\nYou have 5 todos:"
    );
  });

  test("rewrites every bracket disclosure with optional comma separators", () => {
    const canonical = "main_loop: model=claude-sonnet-5 effort=high tier=standard";
    expect(stampMainLoopDisclosure(
      "Before main_loop[model=gpt-5.6-luna, effort=xhigh, tier=fast] between main_loop[model=gpt-5.6-luna effort=xhigh tier=fast] after",
      claudeIdentity
    )).toBe(`Before ${canonical} between ${canonical} after`);
  });

  test("leaves a correct Codex disclosure unchanged", () => {
    const identity = mainLoopRuntimeIdentity(config, "codex");
    const input = "main_loop: model=gpt-5.6-luna effort=xhigh tier=fast";

    expect(stampMainLoopDisclosure(input, identity)).toBe(input);
  });

  test("leaves text without a disclosure unchanged", () => {
    const inputs = [
      "You have 5 todos.",
      "The main_loop is currently working.",
      "main_loop: effort=xhigh tier=fast"
    ];

    for (const input of inputs) expect(stampMainLoopDisclosure(input, claudeIdentity)).toBe(input);
  });

  test("derives the configured identity for both main providers", () => {
    expect(mainLoopRuntimeIdentity(config, "codex")).toEqual({
      provider: "codex",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      tier: "fast"
    });
    expect(mainLoopRuntimeIdentity(config, "claude_agent_sdk")).toEqual(claudeIdentity);
  });

  test("formats an authoritative prompt instruction with provider and model", () => {
    const block = formatRuntimeIdentityBlock(claudeIdentity);

    expect(block).toContain("authoritative");
    expect(block).toContain("provider=claude_agent_sdk");
    expect(block).toContain("model=claude-sonnet-5");
  });
});
