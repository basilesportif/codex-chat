import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query as queryClaudeAgentSdk,
  type EffortLevel as ClaudeEffortLevel,
  type Options as ClaudeAgentSdkOptions
} from "@anthropic-ai/claude-agent-sdk";
import { withTimeout, type ChildEnvSource } from "./claude-auth.js";
import type { AppConfig } from "./config.js";

/**
 * Summarizing the conversation a rolled-over main session is about to lose.
 *
 * Everything here runs OUT of the turn hot path: the summarizer is a separate
 * one-shot SDK query against a fresh session (never a resume of the near-full
 * main session — adding turns to the session we are abandoning is exactly what
 * wedged it in the first place), and its source is the main session's
 * on-disk JSONL transcript rather than any live session state.
 */

/** Hard ceiling on bytes read from a transcript (they reach several MB). */
const MAX_TRANSCRIPT_READ_BYTES = 32 * 1024 * 1024;
/** Conversation text handed to the summarizer, tail-biased. */
export const DEFAULT_TRANSCRIPT_BUDGET_CHARS = 120_000;
/** Per-message truncation so one giant paste cannot eat the whole budget. */
const MAX_MESSAGE_CHARS = 6_000;
/** Belt-and-braces cap on whatever the summarizer produces. */
export const MAX_HANDOFF_SUMMARY_CHARS = 6_000;
/** Generous: this never blocks a user turn, it only wastes a background job. */
export const DEFAULT_HANDOFF_SUMMARY_TIMEOUT_MS = 240_000;

const HANDOFF_SUMMARY_SYSTEM_PROMPT = [
  "You write handoff briefs. You are given a transcript excerpt of a long assistant/user conversation whose session is being retired because it filled its context window.",
  "A fresh session will start with only your brief as memory of everything that came before.",
  "Write the brief for that successor session.",
  "Cover, in this order, only what is present:",
  "1. Active or ongoing tasks and their current state (what is done, what is in flight, what is blocked).",
  "2. Standing instructions and preferences the user stated during this conversation.",
  "3. Key facts and decisions the successor would otherwise have to re-derive (paths, names, ids, chosen approaches).",
  "4. Anything explicitly promised to the user but not yet delivered.",
  "Rules: prefer recent content over older content; be concrete and specific; do not speculate; omit sections that have no content.",
  "Hard limit 600 words. Output the brief only — no preamble, no sign-off, no offer to help."
].join("\n");

export interface TranscriptExcerpt {
  text: string;
  chars: number;
  messages: number;
  transcriptBytes: number;
}

export interface GenerateHandoffSummaryInput {
  readonly config: AppConfig;
  readonly sessionId: string;
  readonly safeEnv: ChildEnvSource;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly budgetChars?: number;
}

export interface HandoffSummaryResult {
  summary: string;
  transcriptChars: number;
  transcriptMessages: number;
  transcriptBytes: number;
}

/**
 * Where Claude Code stores a session's JSONL transcript: `~/.claude/projects/`
 * plus the session's cwd with every non-alphanumeric character replaced by a
 * dash (`/home/tim/pkg/tim/codex-chat` -> `-home-tim-pkg-tim-codex-chat`).
 */
export function claudeTranscriptPath(workspace: string, sessionId: string, home = homedir()): string {
  const encoded = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  return join(home, ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * Pull the human-readable conversation out of a transcript: user and assistant
 * text only, most recent first until the budget is spent, then re-ordered
 * chronologically. Tool calls, tool results, thinking blocks and sidechain
 * (subagent) entries are dropped — they are the bulk of the file and the least
 * useful part of a handoff.
 */
export async function readTranscriptExcerpt(
  path: string,
  budgetChars = DEFAULT_TRANSCRIPT_BUDGET_CHARS
): Promise<TranscriptExcerpt> {
  const info = await stat(path);
  const readBytes = Math.min(info.size, MAX_TRANSCRIPT_READ_BYTES);
  const handle = await open(path, "r");
  let raw: string;
  try {
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, info.size - readBytes);
    raw = buffer.toString("utf8");
  } finally {
    await handle.close();
  }
  const lines = raw.split("\n");
  // A tailed read almost certainly starts mid-line.
  if (readBytes < info.size) lines.shift();

  const selected: string[] = [];
  let chars = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const rendered = renderTranscriptEntry(entry);
    if (!rendered) continue;
    if (chars + rendered.length > budgetChars) break;
    selected.push(rendered);
    chars += rendered.length;
  }
  selected.reverse();
  return { text: selected.join("\n\n"), chars, messages: selected.length, transcriptBytes: info.size };
}

function renderTranscriptEntry(entry: Record<string, unknown>): string | undefined {
  if (entry.isSidechain === true) return undefined;
  const type = entry.type;
  if (type !== "user" && type !== "assistant") return undefined;
  const message = entry.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const record = block as Record<string, unknown>;
      // tool_use / tool_result / thinking blocks are dropped entirely.
      if (record.type !== "text" || typeof record.text !== "string") continue;
      text += text ? `\n${record.text}` : record.text;
    }
  }
  text = text.trim();
  if (!text) return undefined;
  if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}\n[...truncated]`;
  return `${type === "user" ? "USER" : "ASSISTANT"}: ${text}`;
}

/**
 * Read the retiring session's transcript and summarize it with a throwaway
 * one-shot SDK query. Never resumes anything, never persists a session id, and
 * runs with no tools, so it cannot touch codex-chat state.
 */
export async function generateHandoffSummary(input: GenerateHandoffSummaryInput): Promise<HandoffSummaryResult> {
  const path = claudeTranscriptPath(input.config.service.workspace, input.sessionId);
  const excerpt = await readTranscriptExcerpt(path, input.budgetChars ?? DEFAULT_TRANSCRIPT_BUDGET_CHARS);
  if (!excerpt.text.trim()) throw new Error(`transcript ${path} contained no conversation text`);

  const prompt = [
    "Transcript excerpt (oldest first; the end is the most recent exchange):",
    "<<<TRANSCRIPT",
    excerpt.text,
    "TRANSCRIPT",
    "",
    "Write the handoff brief now."
  ].join("\n");

  const options: ClaudeAgentSdkOptions = {
    cwd: input.config.service.workspace,
    env: {
      ...input.safeEnv,
      CLAUDE_AGENT_SDK_CLIENT_APP: "codex-chat/main-handoff"
    },
    systemPrompt: HANDOFF_SUMMARY_SYSTEM_PROMPT,
    model: input.model,
    effort: "low" as ClaudeEffortLevel,
    // No tools at all: this session only has to read the prompt and write prose.
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    settingSources: [],
    maxTurns: 1,
    strictMcpConfig: true,
    includePartialMessages: false,
    title: "codex-chat main handoff summary"
  };
  const executable = input.config.mainAgent.claude.pathToClaudeCodeExecutable.trim();
  if (executable) options.pathToClaudeCodeExecutable = executable;

  const query = queryClaudeAgentSdk({ prompt, options });
  try {
    const summary = await withTimeout(
      collectSummaryText(query),
      input.timeoutMs ?? DEFAULT_HANDOFF_SUMMARY_TIMEOUT_MS,
      "Claude handoff summarization timed out"
    );
    const trimmed = summary.trim();
    if (!trimmed) throw new Error("handoff summarizer produced no text");
    return {
      summary: trimmed.length > MAX_HANDOFF_SUMMARY_CHARS ? `${trimmed.slice(0, MAX_HANDOFF_SUMMARY_CHARS)}…` : trimmed,
      transcriptChars: excerpt.chars,
      transcriptMessages: excerpt.messages,
      transcriptBytes: excerpt.transcriptBytes
    };
  } finally {
    try {
      (query as { close?: () => void }).close?.();
    } catch {
      // A closed/ended query is the normal case here.
    }
  }
}

async function collectSummaryText(query: AsyncIterable<unknown>): Promise<string> {
  let assistantText = "";
  for await (const message of query) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.type === "assistant") {
      const content = (record.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const blockRecord = block as Record<string, unknown>;
          if (blockRecord.type === "text" && typeof blockRecord.text === "string") assistantText += blockRecord.text;
        }
      }
      continue;
    }
    if (record.type !== "result") continue;
    if (record.subtype === "success") {
      return typeof record.result === "string" && record.result.trim() ? record.result : assistantText;
    }
    const errors = Array.isArray(record.errors) && record.errors.length > 0 ? record.errors.join("; ") : String(record.subtype);
    throw new Error(`handoff summarizer failed: ${errors}`);
  }
  if (assistantText.trim()) return assistantText;
  throw new Error("handoff summarizer query ended without a result");
}
