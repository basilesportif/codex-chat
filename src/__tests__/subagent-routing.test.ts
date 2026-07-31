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

describe("Claude-main subagent routing enforcement", () => {
  test("rewrites a precedent-driven Luna dispatch for a routine calendar lookup to Sonnet", () => {
    const input = action({
      profile: "operator",
      prompt: "Look up next event on football calendar",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      serviceTier: "fast"
    });

    expect(normalizeSubagentRouting(input, "Look up next event on football calendar", "claude_agent_sdk")).toMatchObject({
      changed: true,
      workload: "routine_non_coding",
      action: {
        model: "claude-sonnet-5",
        effort: "high",
        serviceTier: "standard",
        backend: "claude_agent_sdk"
      }
    });
  });

  test("rewrites a Sol implementer dispatch for coding work to Fable", () => {
    const input = action({
      prompt: "Implement the service code change and run the tests.",
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "fast"
    });

    expect(normalizeSubagentRouting(input, "Implement the service code change", "claude_agent_sdk")).toMatchObject({
      changed: true,
      workload: "coding",
      action: {
        model: "claude-fable-5",
        effort: "medium",
        serviceTier: "standard",
        backend: "claude_agent_sdk"
      }
    });
  });

  test("rewrites an unknown GPT workload to the safe Sonnet default", () => {
    const input = action({ prompt: "Handle this.", model: "gpt-5.6-sol" });

    expect(normalizeSubagentRouting(input, "Handle this", "claude_agent_sdk")).toMatchObject({
      changed: true,
      workload: "unknown",
      action: {
        model: "claude-sonnet-5",
        effort: "high",
        serviceTier: "standard",
        backend: "claude_agent_sdk"
      }
    });
  });

  test("honors an explicit Luna request through the Codex normalization path", () => {
    const input = action({ prompt: "Look up the calendar event.", model: "gpt-5.6-luna", effort: "xhigh" });

    expect(normalizeSubagentRouting(input, "use luna for this lookup", "claude_agent_sdk")).toEqual({
      action: input,
      changed: false,
      workload: "routine_non_coding"
    });
  });

  test("honors an explicit Codex request", () => {
    const input = action({ prompt: "Handle this.", model: "gpt-5.6-luna", effort: "xhigh" });

    expect(normalizeSubagentRouting(input, "use codex for this", "claude_agent_sdk")).toEqual({
      action: input,
      changed: false,
      workload: "unknown"
    });
  });

  test("preserves explicitly requested effort during a Claude rewrite", () => {
    const input = action({ profile: "operator", prompt: "Look up the calendar event.", effort: "xhigh" });
    const result = normalizeSubagentRouting(input, "Look up the calendar event with xhigh effort", "claude_agent_sdk");

    expect(result).toMatchObject({ changed: true, workload: "routine_non_coding" });
    expect(result.action).toMatchObject({
      model: "claude-sonnet-5",
      effort: "xhigh",
      serviceTier: "standard",
      backend: "claude_agent_sdk"
    });
  });

  test("an existing Fable action gets the shared medium-effort default", () => {
    const input = action({ model: "claude-fable-5", backend: "claude_agent_sdk", effort: "xhigh", serviceTier: "standard" });
    const result = normalizeSubagentRouting(input, "Review this", "claude_agent_sdk");

    expect(result.action).toEqual({ ...input, effort: "medium" });
    expect(result.changed).toBe(true);
  });

  test("an explicit effort on an existing Fable action is untouched", () => {
    const input = action({ model: "claude-fable-5", backend: "claude_agent_sdk", effort: "xhigh", serviceTier: "standard" });

    expect(normalizeSubagentRouting(input, "Review this with xhigh effort", "claude_agent_sdk")).toEqual({
      action: input,
      changed: false,
      workload: "unknown"
    });
  });

  test("an explicit provider override passes through unchanged", () => {
    const input = action({
      codexProfile: "openrouter",
      modelProvider: "openrouter",
      serviceTierMode: "omit",
      model: "z-ai/glm-5.2"
    });

    expect(normalizeSubagentRouting(input, "Handle this", "claude_agent_sdk")).toEqual({
      action: input,
      changed: false,
      workload: "unknown"
    });
  });
});

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

  test("keeps Codex-mode defaults when the provider argument is omitted", () => {
    const routine = action({ profile: "operator", prompt: "Look up the calendar event.", model: "gpt-5.6-sol" });
    const coding = action({ prompt: "Debug the TypeScript service.", model: "gpt-5.6-luna", effort: "xhigh" });

    expect(normalizeSubagentRouting(routine, "Look up the calendar event").action).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "xhigh",
      serviceTier: "fast"
    });
    expect(normalizeSubagentRouting(coding, "Debug the TypeScript service").action).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
      serviceTier: "fast"
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

describe("Fable effort default", () => {
  test.each([["fable"], ["claude-fable-5"]] as const)(
    "%s defaults to medium effort when no effort was explicitly requested",
    (model) => {
      const input = action({ model, backend: "claude_agent_sdk", effort: "xhigh", serviceTier: "standard" });
      const result = normalizeSubagentRouting(input, "Use Fable to review this");
      expect(result.changed).toBe(true);
      expect(result.action.effort).toBe("medium");
      expect(result.action.model).toBe(model);
    }
  );

  test("an explicit effort request on Fable is preserved", () => {
    const input = action({ model: "fable", backend: "claude_agent_sdk", effort: "xhigh", serviceTier: "standard" });
    const result = normalizeSubagentRouting(input, "Use Fable at xhigh effort for this");
    expect(result.action.effort).toBe("xhigh");
    expect(result.changed).toBe(false);
  });

  test("Fable already at medium is a no-op", () => {
    const input = action({ model: "fable", backend: "claude_agent_sdk", effort: "medium", serviceTier: "standard" });
    const result = normalizeSubagentRouting(input, "Use Fable to review this");
    expect(result.action.effort).toBe("medium");
    expect(result.changed).toBe(false);
  });

  test("a non-Fable Claude model (opus) keeps its effort", () => {
    const input = action({ model: "opus", backend: "claude_agent_sdk", effort: "xhigh", serviceTier: "fast" });
    const result = normalizeSubagentRouting(input, "Use Opus to review this");
    expect(result.action.effort).toBe("xhigh");
    expect(result.changed).toBe(false);
  });
});
