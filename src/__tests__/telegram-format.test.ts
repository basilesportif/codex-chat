import { describe, expect, test } from "vitest";
import { renderTelegramMarkdown } from "../telegram-format.js";

describe("Telegram Markdown renderer", () => {
  test("renders fenced code blocks as Telegram HTML pre/code", () => {
    const rendered = renderTelegramMarkdown("Before\n```ts\nconst x = 1 < 2;\n```\nAfter");
    expect(rendered.parseMode).toBe("HTML");
    expect(rendered.text).toContain('<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>');
    expect(rendered.text).not.toContain("```");
  });

  test("renders inline code and escapes HTML", () => {
    const rendered = renderTelegramMarkdown("Use `a < b` & continue");
    expect(rendered.parseMode).toBe("HTML");
    expect(rendered.text).toBe("Use <code>a &lt; b</code> &amp; continue");
  });

  test("leaves plain text without parse mode when no markdown is present", () => {
    const rendered = renderTelegramMarkdown("plain text");
    expect(rendered).toEqual({ text: "plain text", parseMode: undefined });
  });
});
