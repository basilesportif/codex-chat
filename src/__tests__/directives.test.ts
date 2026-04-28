import { describe, expect, test } from "vitest";
import { parseDirectives } from "../directives.js";

describe("directive parsing", () => {
  test("accepts a valid directive block", () => {
    const parsed = parseDirectives(`Before

\`\`\`codex-chat
{
  "version": 1,
  "actions": [
    {
      "type": "dispatch_subagent",
      "idempotencyKey": "job-1",
      "profile": "debugger",
      "prompt": "Inspect the logs",
      "route": "return_to_main"
    }
  ]
}
\`\`\`

After`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.actions[0]?.type).toBe("dispatch_subagent");
  });

  test("reports invalid directives without throwing", () => {
    const parsed = parseDirectives(`Visible

\`\`\`codex-chat
{ "version": 1, "actions": [] }
\`\`\``);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.cleanText).toBe("Visible");
  });

  test("extracts multiple directives from one message", () => {
    const parsed = parseDirectives(`One
\`\`\`codex-chat
{"version":1,"actions":[{"type":"notify_owner","idempotencyKey":"ops-1","text":"Heads up"}]}
\`\`\`
Two
\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"send-1","text":"Hello"}]}
\`\`\``);

    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks.flatMap((block) => block.actions.map((action) => action.type))).toEqual(["notify_owner", "send_text"]);
  });

  test("accepts get_logs directives with default and explicit line counts", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{
  "version": 1,
  "actions": [
    { "type": "get_logs", "idempotencyKey": "logs-1" },
    { "type": "get_logs", "idempotencyKey": "logs-2", "lines": 200 }
  ]
}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const actions = parsed.blocks[0]!.actions;
    expect(actions[0]?.type).toBe("get_logs");
    expect((actions[0] as { lines?: number }).lines).toBeUndefined();
    expect((actions[1] as { lines?: number }).lines).toBe(200);
  });

  test("rejects get_logs with excessive line counts", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{ "version": 1, "actions": [ { "type": "get_logs", "idempotencyKey": "logs-3", "lines": 999999 } ] }
\`\`\``);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });

  test("strips directive fences from user-facing text", () => {
    const parsed = parseDirectives(`Keep this
\`\`\`codex-chat
{"version":1,"actions":[{"type":"notify_owner","idempotencyKey":"ops-2","text":"hidden"}]}
\`\`\`
And this`);

    expect(parsed.cleanText).toBe("Keep this\n\nAnd this");
    expect(parsed.cleanText).not.toContain("codex-chat");
  });
});
