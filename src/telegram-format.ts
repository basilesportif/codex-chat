export interface RenderedTelegramText {
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;"
};

export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPE[char] ?? char);
}

export function renderTelegramMarkdown(text: string): RenderedTelegramText {
  const source = text || "(empty response)";
  let rendered = "";
  let cursor = 0;
  let usedHtml = false;
  const fencePattern = /(^|\n)```([^\n`]*)\n([\s\S]*?)(?:\n```(?=\n|$)|$)/g;

  for (const match of source.matchAll(fencePattern)) {
    const matchStart = match.index ?? 0;
    const prefix = match[1] ?? "";
    const fenceStart = matchStart + prefix.length;
    rendered += renderInlineMarkdown(source.slice(cursor, fenceStart));
    const lang = sanitizeCodeLanguage((match[2] ?? "").trim());
    const body = match[3] ?? "";
    const classAttr = lang ? ` class="language-${escapeTelegramHtml(lang)}"` : "";
    rendered += `<pre><code${classAttr}>${escapeTelegramHtml(body)}</code></pre>`;
    cursor = matchStart + match[0].length;
    usedHtml = true;
  }

  rendered += renderInlineMarkdown(source.slice(cursor));
  return { text: rendered || "(empty response)", parseMode: usedHtml || rendered !== source ? "HTML" : undefined };
}

function sanitizeCodeLanguage(lang: string): string {
  return lang.replace(/[^a-zA-Z0-9_+.-]/g, "").slice(0, 32);
}

function renderInlineMarkdown(text: string): string {
  let out = "";
  let cursor = 0;
  const inlineCodePattern = /`([^`\n]+)`/g;
  for (const match of text.matchAll(inlineCodePattern)) {
    const start = match.index ?? 0;
    out += escapeTelegramHtml(text.slice(cursor, start));
    out += `<code>${escapeTelegramHtml(match[1] ?? "")}</code>`;
    cursor = start + match[0].length;
  }
  out += escapeTelegramHtml(text.slice(cursor));
  return renderBoldItalic(out);
}

function renderBoldItalic(escapedText: string): string {
  return escapedText
    .replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*_])\*([^*\n][^*\n]*?[^*\n])\*(?!\*)/g, "$1<i>$2</i>");
}
