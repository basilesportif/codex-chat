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
      "route": "return_to_main",
      "summary": "Inspect logs",
      "model": "gpt-5.5",
      "effort": "high"
    }
  ]
}
\`\`\`

After`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("dispatch_subagent");
    if (action?.type === "dispatch_subagent") {
      expect(action.summary).toBe("Inspect logs");
      expect(action.model).toBe("gpt-5.5");
      expect(action.effort).toBe("high");
    }
  });

  test("accepts a line-delimited sentinel directive block", () => {
    const parsed = parseDirectives(`Before

BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"sentinel-1","text":"Hello"}]}
END CODEXCHAT DIRECTIVE

After`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.actions[0]?.type).toBe("send_text");
    expect(parsed.cleanText).toBe("Before\n\n\nAfter");
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

  test("reports invalid sentinel directives without leaking raw fragments", () => {
    const parsed = parseDirectives(`Visible

BEGIN CODEXCHAT DIRECTIVE V1
{ "version": 1, "actions": [] }
END CODEXCHAT DIRECTIVE`);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.cleanText).toBe("Visible");
    expect(parsed.cleanText).not.toContain("BEGIN CODEXCHAT");
    expect(parsed.cleanText).not.toContain("\"actions\"");
  });

  test("strips unterminated sentinel fragments from user-facing text", () => {
    const parsed = parseDirectives(`Visible

BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[`);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toEqual(["Unterminated codex-chat sentinel directive block"]);
    expect(parsed.cleanText).toBe("Visible");
  });

  test.each(["summary", "model", "effort"])("dispatch_subagent requires %s", (field) => {
    const action: Record<string, unknown> = {
      type: "dispatch_subagent",
      idempotencyKey: "job-missing-field",
      profile: "debugger",
      prompt: "Inspect the logs",
      route: "return_to_main",
      summary: "Inspect logs",
      model: "gpt-5.5",
      effort: "high"
    };
    delete action[field];

    const parsed = parseDirectives(`\`\`\`codex-chat
${JSON.stringify({ version: 1, actions: [action] })}
\`\`\``);

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
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

  test("extracts multiple mixed sentinel and fenced directives in order", () => {
    const parsed = parseDirectives(`One
BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[{"type":"notify_owner","idempotencyKey":"ops-sentinel","text":"Heads up"}]}
END CODEXCHAT DIRECTIVE
Two
\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"send-fence","text":"Hello"}]}
\`\`\`
Three
BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[{"type":"react","idempotencyKey":"react-sentinel","messageId":7,"emoji":"👀"}]}
END CODEXCHAT DIRECTIVE`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks.flatMap((block) => block.actions.map((action) => action.type))).toEqual(["notify_owner", "send_text", "react"]);
    expect(parsed.cleanText).toBe("One\nTwo\n\nThree");
  });

  test("rejects unknown directive types", () => {
    // get_logs was removed from the schema — it is now handled at the service
    // level before Codex ever sees the message. Any directive block emitted by
    // an old Codex session that still contains "get_logs" should fail validation.
    const parsed = parseDirectives(`\`\`\`codex-chat
{ "version": 1, "actions": [ { "type": "get_logs", "idempotencyKey": "logs-old" } ] }
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

  test("preserves normal Markdown code fences", () => {
    const markdown = `Here is an example:
\`\`\`text
BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"example","text":"not a directive"}]}
END CODEXCHAT DIRECTIVE
\`\`\`
Done`;
    const parsed = parseDirectives(markdown);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.cleanText).toBe(markdown);
  });
});

// Manual verification of MarkdownV2 rendering:
// 1. From a Telegram chat connected to codex-chat, send a message that asks for
//    bold, italic, or code-block output (e.g. "reply with bold + a code block").
// 2. Confirm the agent emits a `send_text` directive containing
//    "format": "markdownv2" and properly escaped text.
// 3. Verify Telegram renders the formatting (bold/italic/code) instead of
//    showing raw asterisks/backticks. If you see raw chars, the format flag
//    was dropped on the way to bot.api.sendMessage — check service.ts and
//    telegram.ts wiring.
describe("send_text format", () => {
  test("accepts format: markdownv2", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"md-1","text":"*bold*","format":"markdownv2"}]}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_text");
    if (action?.type === "send_text") {
      expect(action.format).toBe("markdownv2");
    }
  });

  test("send_text without format still parses (defaults to plain)", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"plain-1","text":"hello"}]}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_text");
    if (action?.type === "send_text") {
      expect(action.format).toBeUndefined();
    }
  });

  test("rejects unknown format value", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"bad-1","text":"x","format":"html"}]}
\`\`\``);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("react directive", () => {
  test("parses a valid react directive", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"react","idempotencyKey":"react-1","messageId":42,"emoji":"👀"}]}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("react");
    if (action?.type === "react") {
      expect(action.messageId).toBe(42);
      expect(action.emoji).toBe("👀");
    }
  });

  test("react requires messageId and emoji", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"react","idempotencyKey":"react-bad"}]}
\`\`\``);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});
