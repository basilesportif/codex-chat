import { describe, expect, test } from "vitest";
import type { DispatchSubagentAction } from "../subagent-routing.js";
import { classifySubagentWorkload, normalizeSubagentRouting } from "../subagent-routing.js";

function action(overrides: Partial<DispatchSubagentAction> = {}): DispatchSubagentAction {
  return {
    type: "dispatch_subagent",
    idempotencyKey: "route-test",
    profile: "implementer",
    route: "return_to_main",
    summary: "Do the task",
    prompt: "Do the task",
    model: "gpt-5.6-sol",
    effort: "high",
    serviceTier: "fast",
    ...overrides
  };
}

describe("subagent workload routing", () => {
  test.each([
    ["CRM", "Read the CRM skill and update Neville's existing follow-up using --on-behalf-of."] as const,
    ["calendar", "Read the calendar skill and list tomorrow's calendar events."] as const,
    ["project", "Use project scripts to update the existing project note without creating a duplicate."] as const,
    ["research", "Research current vendor options and summarize the findings."] as const
  ])("normalizes routine %s work to Luna xhigh fast", (_domain, prompt) => {
    const result = normalizeSubagentRouting(action({ prompt }), "Please handle this routine task");

    expect(result).toMatchObject({ changed: true, workload: "routine_non_coding" });
    expect(result.action).toMatchObject({ model: "gpt-5.6-luna", effort: "xhigh", serviceTier: "fast" });
  });

  test("the operator profile defaults to routine non-coding, independent of mutation verbs", () => {
    const input = action({ profile: "operator", prompt: "Delete the selected external record and verify the result." });

    expect(classifySubagentWorkload(input)).toBe("routine_non_coding");
    expect(normalizeSubagentRouting(input, "delete that record").action).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "xhigh",
      serviceTier: "fast"
    });
  });

  test("explicit coding work wins over a mistakenly selected operator profile", () => {
    const input = action({ profile: "operator", prompt: "Debug the TypeScript source code regression." });

    expect(classifySubagentWorkload(input)).toBe("coding");
  });

  test("normalizes coding, debugging, review, architecture, and deploy work to Sol high fast", () => {
    const input = action({
      profile: "implementer",
      prompt: "Debug the TypeScript service, fix the regression, run tests, and prepare the deployment.",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      serviceTier: "standard"
    });

    expect(normalizeSubagentRouting(input, "fix the service regression")).toMatchObject({
      changed: true,
      workload: "coding",
      action: { model: "gpt-5.6-sol", effort: "high", serviceTier: "fast" }
    });
  });

  test("preserves an explicit user model request", () => {
    const input = action({ prompt: "Update the CRM follow-up." });

    expect(normalizeSubagentRouting(input, "Use gpt-5.6-sol for this CRM update")).toEqual({
      action: input,
      changed: false,
      workload: "routine_non_coding"
    });
  });

  test("preserves explicit effort and service-tier choices while correcting the default model", () => {
    const input = action({ prompt: "Update the CRM follow-up.", effort: "medium", serviceTier: "standard" });
    const result = normalizeSubagentRouting(input, "Use medium effort and standard tier for this CRM update");

    expect(result.action).toMatchObject({ model: "gpt-5.6-luna", effort: "medium", serviceTier: "standard" });
  });

  test.each([
    action({
      prompt: "Research the CRM record with Claude.",
      backend: "claude_agent_sdk",
      model: "claude-opus-4-8"
    }),
    action({
      prompt: "Research the CRM record through OpenRouter.",
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      serviceTierMode: "omit",
      model: "z-ai/glm-5.2"
    })
  ])("preserves Claude and provider overrides", (input) => {
    expect(normalizeSubagentRouting(input, input.prompt)).toMatchObject({ action: input, changed: false });
  });
});
