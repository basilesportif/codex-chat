import { describe, expect, test } from "vitest";
import { FenceCloseScanner, parseDirectives } from "../directives.js";

describe("directive parsing", () => {
  test("accepts a valid codex-chat fenced directive block", () => {
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
      "effort": "high",
      "serviceTier": "fast",
      "codexProfile": "openrouter",
      "modelProvider": "openrouter",
      "serviceTierMode": "omit"
    }
  ]
}
\`\`\`

After`);

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.cleanText).toBe("Before\n\n\nAfter");
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("dispatch_subagent");
    if (action?.type === "dispatch_subagent") {
      expect(action.summary).toBe("Inspect logs");
      expect(action.model).toBe("gpt-5.5");
      expect(action.effort).toBe("high");
      expect(action.serviceTier).toBe("fast");
      expect(action.codexProfile).toBe("openrouter");
      expect(action.modelProvider).toBe("openrouter");
      expect(action.serviceTierMode).toBe("omit");
    }
  });


  test.each([
    ["claude_agent_sdk", "claude_agent_sdk"],
    ["claude", "claude_agent_sdk"],
    ["claude_code", "claude_agent_sdk"],
    ["claude-agent-sdk", "claude_agent_sdk"],
    ["exec", "codex_exec"],
    ["codex_exec", "codex_exec"],
    ["app-server", "codex_app_server"],
    ["app_server", "codex_app_server"],
    ["codex_app_server", "codex_app_server"]
  ])("dispatch_subagent backend %s normalizes to %s", (alias, canonical) => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"dispatch_subagent","idempotencyKey":"job-backend","profile":"debugger","prompt":"Inspect","route":"return_to_main","summary":"Inspect","model":"claude-opus-4-8","effort":"medium","serviceTier":"fast","backend":"${alias}"}]}
\`\`\``);

    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("dispatch_subagent");
    if (action?.type === "dispatch_subagent") expect(action.backend).toBe(canonical);
  });

  test("dispatch_subagent backend is optional and defaults to undefined", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"dispatch_subagent","idempotencyKey":"job-no-backend","profile":"debugger","prompt":"Inspect","route":"return_to_main","summary":"Inspect","model":"gpt-5.5","effort":"medium","serviceTier":"fast"}]}
\`\`\``);

    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    if (action?.type === "dispatch_subagent") expect(action.backend).toBeUndefined();
  });

  test("rejects unknown dispatch_subagent backend values", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"dispatch_subagent","idempotencyKey":"job-bad-backend","profile":"debugger","prompt":"Inspect","route":"return_to_main","summary":"Inspect","model":"gpt-5.5","effort":"medium","serviceTier":"fast","backend":"gemini"}]}
\`\`\``);

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });

  test("rejects invalid dispatch_subagent serviceTier", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"dispatch_subagent","idempotencyKey":"job-fast-bad","profile":"debugger","prompt":"Inspect","route":"return_to_main","summary":"Inspect","model":"gpt-5.5","effort":"medium","serviceTier":"priority"}]}
\`\`\``);

    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
  });

  test("does not parse removed BEGIN CODEXCHAT marker", () => {
    const text = `BEGIN CODEXCHAT DIRECTIVE V1
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"sentinel-1","text":"Hello"}]}
END CODEXCHAT DIRECTIVE`;
    const parsed = parseDirectives(text);
    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.cleanText).toBe(text);
  });

  test("reports invalid directives without leaking raw fragments", () => {
    const parsed = parseDirectives(`Visible

\`\`\`codex-chat
{ "version": 1, "actions": [] }
\`\`\``);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.cleanText).toBe("Visible");
    expect(parsed.cleanText).not.toContain("actions");
  });

  test("strips unterminated directive fragments from user-facing text", () => {
    const parsed = parseDirectives(`Visible

\`\`\`codex-chat
{"version":1,"actions":[`);

    expect(parsed.blocks).toEqual([]);
    expect(parsed.errors).toEqual(["Unterminated codex-chat directive block"]);
    expect(parsed.cleanText).toBe("Visible");
  });

  test.each(["summary", "model", "effort", "serviceTier"])("dispatch_subagent requires %s", (field) => {
    const action: Record<string, unknown> = {
      type: "dispatch_subagent",
      idempotencyKey: "job-missing-field",
      profile: "debugger",
      prompt: "Inspect the logs",
      route: "return_to_main",
      summary: "Inspect logs",
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "standard"
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

    expect(parsed.errors).toEqual([]);
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks.flatMap((block) => block.actions.map((action) => action.type))).toEqual(["notify_owner", "send_text"]);
    expect(parsed.cleanText).toBe("One\nTwo");
  });

  test("accepts steer_subagent directive", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"steer_subagent","idempotencyKey":"steer-1","jobId":"job_deadbeef","text":"Please summarize what you have and stop."}]}
\`\`\``);

    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("steer_subagent");
    if (action?.type === "steer_subagent") {
      expect(action.jobId).toBe("job_deadbeef");
      expect(action.text).toContain("summarize");
    }
  });

  test("rejects unknown directive types", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{ "version": 1, "actions": [ { "type": "get_logs", "idempotencyKey": "logs-old" } ] }
\`\`\``);
    expect(parsed.blocks).toHaveLength(0);
    expect(parsed.errors).toHaveLength(1);
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

describe("send_image directive", () => {
  test("accepts deleteAfterSend cleanup option", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_image","idempotencyKey":"generated-image-1","path":"data/artifacts/generated-images/pink-giraffe.png","deleteAfterSend":true}]}
\`\`\``);

    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_image");
    if (action?.type === "send_image") expect(action.deleteAfterSend).toBe(true);
  });
});

describe("send_text format", () => {
  test("accepts format: markdownv2", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"md-1","text":"*bold*","format":"markdownv2"}]}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_text");
    if (action?.type === "send_text") expect(action.format).toBe("markdownv2");
  });

  test("accepts format: markdown", () => {
    const payload = { version: 1, actions: [{ type: "send_text", idempotencyKey: "md-service-1", text: "```ts\nconst x = 1;\n```", format: "markdown" }] };
    const parsed = parseDirectives(`\`\`\`codex-chat
${JSON.stringify(payload)}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_text");
    if (action?.type === "send_text") expect(action.format).toBe("markdown");
  });

  test("send_text without format parses", () => {
    const parsed = parseDirectives(`\`\`\`codex-chat
{"version":1,"actions":[{"type":"send_text","idempotencyKey":"plain-1","text":"hello"}]}
\`\`\``);
    expect(parsed.errors).toEqual([]);
    const action = parsed.blocks[0]?.actions[0];
    expect(action?.type).toBe("send_text");
    if (action?.type === "send_text") expect(action.format).toBeUndefined();
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

describe("FenceCloseScanner", () => {
  test("triggers when a close fence completes as a full line", () => {
    const scanner = new FenceCloseScanner();
    expect(scanner.append("```codex-chat\n")).toBe(false);
    expect(scanner.append('{"version":1}\n')).toBe(false);
    expect(scanner.append("```\n")).toBe(true);
    expect(scanner.append("more prose\n")).toBe(false);
  });

  test("triggers on a trailing close fence without a newline (matches parseDirectives semantics)", () => {
    const scanner = new FenceCloseScanner();
    expect(scanner.append("```codex-chat\n{}\n``")).toBe(false);
    expect(scanner.append("`")).toBe(true);
    // Same pending fence should not retrigger without new fence evidence.
    expect(scanner.append("")).toBe(false);
  });

  test("a transient pending-fence match does not suppress a later real fence", () => {
    const scanner = new FenceCloseScanner();
    expect(scanner.append("```")).toBe(true);
    // Pending line extends into a non-fence line: no new completion.
    expect(scanner.append("codex-chat\n")).toBe(false);
    expect(scanner.append('{"version":1}\n')).toBe(false);
    expect(scanner.append("```\n")).toBe(true);
  });

  test("counts multiple fences across one chunk and handles split CRLF", () => {
    const scanner = new FenceCloseScanner();
    expect(scanner.append("```codex-chat\n{}\n```\nmid\n```codex-chat\n{}\n```\n")).toBe(true);
    expect(scanner.append("tail\r")).toBe(false);
    expect(scanner.append("\n```\r")).toBe(true);
    expect(scanner.append("\n")).toBe(false);
  });
});
