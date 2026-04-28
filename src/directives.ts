import { z } from "zod";

const routeSchema = z.enum(["return_to_main", "send_to_user", "send_progress_and_return", "send_to_admins", "store_only", "silent"]);

const baseAction = z.object({
  type: z.string(),
  idempotencyKey: z.string().min(1).optional()
});

const sendTextAction = baseAction.extend({
  type: z.literal("send_text"),
  chatId: z.number().int().optional(),
  text: z.string().min(1),
  replyToMessageId: z.number().int().optional(),
  format: z.enum(["text", "markdownv2"]).optional()
});

const sendImageAction = baseAction.extend({
  type: z.literal("send_image"),
  chatId: z.number().int().optional(),
  path: z.string().optional(),
  fileId: z.string().optional(),
  caption: z.string().optional(),
  asDocument: z.boolean().optional(),
  replyToMessageId: z.number().int().optional()
}).refine((value) => value.path || value.fileId, "send_image requires path or fileId");

const sendDocumentAction = baseAction.extend({
  type: z.literal("send_document"),
  chatId: z.number().int().optional(),
  path: z.string(),
  caption: z.string().optional(),
  replyToMessageId: z.number().int().optional()
});

const dispatchSubagentAction = baseAction.extend({
  type: z.literal("dispatch_subagent"),
  profile: z.string().min(1),
  prompt: z.string().min(1),
  route: routeSchema.default("return_to_main"),
  timeoutSec: z.number().int().positive().optional(),
  summary: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]),
  images: z.array(z.string()).optional()
});

const cancelJobAction = baseAction.extend({
  type: z.literal("cancel_job"),
  jobId: z.string().min(1)
});

const notifyOwnerAction = baseAction.extend({
  type: z.literal("notify_owner"),
  text: z.string().min(1)
});

const enqueueMainAction = baseAction.extend({
  type: z.literal("enqueue_main"),
  text: z.string().min(1),
  route: routeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const reactAction = baseAction.extend({
  type: z.literal("react"),
  chatId: z.number().int().optional(),
  messageId: z.number().int(),
  emoji: z.string().min(1)
});

export const directiveActionSchema = z.discriminatedUnion("type", [
  sendTextAction,
  sendImageAction,
  sendDocumentAction,
  dispatchSubagentAction,
  cancelJobAction,
  notifyOwnerAction,
  enqueueMainAction,
  reactAction
]);

export const directiveBlockSchema = z.object({
  version: z.literal(1),
  actions: z.array(directiveActionSchema).min(1)
});

export type DirectiveAction = z.infer<typeof directiveActionSchema>;
export type DirectiveBlock = z.infer<typeof directiveBlockSchema>;

export interface DirectiveParseResult {
  cleanText: string;
  blocks: DirectiveBlock[];
  errors: string[];
}

const directiveFence = /```codex-chat\s*([\s\S]*?)```/g;
const sentinelStart = /^[ \t]*BEGIN CODEXCHAT DIRECTIVE V1[ \t]*$/;
const sentinelEnd = /^[ \t]*END CODEXCHAT DIRECTIVE[ \t]*$/;

interface TextRange {
  start: number;
  end: number;
}

interface RawDirectiveBlock extends TextRange {
  body: string;
  complete: boolean;
  kind: "fence" | "sentinel";
}

interface SourceLine extends TextRange {
  content: string;
}

export function parseDirectives(text: string): DirectiveParseResult {
  const blocks: DirectiveBlock[] = [];
  const errors: string[] = [];
  const rawBlocks = collectRawDirectiveBlocks(text);
  for (const rawBlock of rawBlocks) {
    if (!rawBlock.complete) {
      errors.push("Unterminated codex-chat sentinel directive block");
      continue;
    }
    try {
      const parsed = JSON.parse(rawBlock.body);
      const block = directiveBlockSchema.parse(parsed);
      for (const action of block.actions) {
        if (action.type !== "enqueue_main" && !action.idempotencyKey) {
          errors.push(`Directive action ${action.type} is missing idempotencyKey`);
        }
      }
      blocks.push(block);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const cleanText = stripRanges(text, rawBlocks).trim();
  return { cleanText, blocks, errors };
}

function collectRawDirectiveBlocks(text: string): RawDirectiveBlock[] {
  const markdownFenceRanges = collectMarkdownFenceRanges(text);
  const blocks = [
    ...collectDirectiveFenceBlocks(text),
    ...collectSentinelBlocks(text, markdownFenceRanges)
  ].sort((left, right) => left.start - right.start);
  return removeOverlappingBlocks(blocks);
}

function collectDirectiveFenceBlocks(text: string): RawDirectiveBlock[] {
  const blocks: RawDirectiveBlock[] = [];
  directiveFence.lastIndex = 0;
  for (const match of text.matchAll(directiveFence)) {
    if (match.index === undefined) continue;
    blocks.push({
      start: match.index,
      end: match.index + match[0].length,
      body: match[1] ?? "",
      complete: true,
      kind: "fence"
    });
  }
  return blocks;
}

function collectSentinelBlocks(text: string, markdownFenceRanges: TextRange[]): RawDirectiveBlock[] {
  const blocks: RawDirectiveBlock[] = [];
  const lines = collectLines(text);
  for (let i = 0; i < lines.length; i++) {
    const startLine = lines[i];
    if (!startLine) continue;
    if (!sentinelStart.test(startLine.content)) continue;
    if (isInsideRange(startLine.start, markdownFenceRanges)) continue;

    const bodyStart = startLine.end;
    let endLine: SourceLine | undefined;
    let endLineIndex = i;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      if (!candidate) continue;
      if (sentinelEnd.test(candidate.content)) {
        endLine = candidate;
        endLineIndex = j;
        break;
      }
    }

    if (endLine) {
      blocks.push({
        start: startLine.start,
        end: endLine.end,
        body: text.slice(bodyStart, endLine.start),
        complete: true,
        kind: "sentinel"
      });
      i = endLineIndex;
    } else {
      blocks.push({
        start: startLine.start,
        end: text.length,
        body: text.slice(bodyStart),
        complete: false,
        kind: "sentinel"
      });
      break;
    }
  }
  return blocks;
}

function collectLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const linePattern = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
  for (const match of text.matchAll(linePattern)) {
    if (match[0] === "" && match.index === text.length) break;
    const start = match.index ?? 0;
    const raw = match[0];
    lines.push({
      start,
      end: start + raw.length,
      content: raw.replace(/(?:\r\n|\n|\r)$/, "")
    });
  }
  return lines;
}

function collectMarkdownFenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = collectLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const opening = line.content.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening) continue;

    const marker = opening[1] ?? "";
    const markerChar = marker[0];
    if (markerChar !== "`" && markerChar !== "~") continue;

    let end = text.length;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j];
      if (!candidate) continue;
      if (isClosingFence(candidate.content, markerChar, marker.length)) {
        end = candidate.end;
        i = j;
        break;
      }
    }
    ranges.push({ start: line.start, end });
  }
  return ranges;
}

function isClosingFence(line: string, markerChar: "`" | "~", minLength: number): boolean {
  const escaped = markerChar === "`" ? "`" : "~";
  const closing = new RegExp(`^[ \\t]{0,3}${escaped}{${minLength},}[ \\t]*$`);
  return closing.test(line);
}

function isInsideRange(index: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => range.start <= index && index < range.end);
}

function removeOverlappingBlocks(blocks: RawDirectiveBlock[]): RawDirectiveBlock[] {
  const result: RawDirectiveBlock[] = [];
  for (const block of blocks) {
    const previous = result[result.length - 1];
    if (previous && block.start < previous.end) continue;
    result.push(block);
  }
  return result;
}

function stripRanges(text: string, ranges: TextRange[]): string {
  if (ranges.length === 0) return text;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    result += text.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  result += text.slice(cursor);
  return result;
}
