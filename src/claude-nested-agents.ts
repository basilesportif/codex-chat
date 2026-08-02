import type {
  HookInput as ClaudeHookInput,
  HookJSONOutput as ClaudeHookJsonOutput
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Shared nested-agent guards for every Claude Agent SDK session codex-chat
 * drives — both the child-job backend (`subagent-backends.ts`) and the main
 * loop (`claude-main-agent.ts`).
 *
 * Agent SDK 0.3.220 defaults the `Agent` tool's `run_in_background` to `true`,
 * so a nested agent returns a "running in the background" tool result
 * immediately and the parent session can finish its turn while the real work
 * is still running. Both call sites need the same three guards: rewrite the
 * tool input to run in the foreground, gate turn/job completion on the live
 * nested-agent set, and tell the model the same rules in its preamble.
 */

export const CLAUDE_AGENT_TOOL_NAME = "Agent";

/**
 * `task_type` values in the SDK's `background_tasks_changed` payload are the
 * raw task-state discriminants (Claude Code 2.1.220 builds the payload as
 * `{task_id: t.id, task_type: t.type, description: t.description}`). Nested
 * Agent-tool runs register as `local_agent`; `remote_agent` and
 * `in_process_teammate` are the other agent-shaped kinds. Backgrounded Bash
 * (`local_bash`), `local_workflow`, and `mcp_task` are deliberately excluded:
 * a session that leaves a dev server or watcher running must still be able to
 * complete. `subagent` is the friendly label the same tasks carry elsewhere in
 * the SDK surface, accepted here so a label-shaped payload still gates.
 */
const CLAUDE_NESTED_AGENT_TASK_TYPES = new Set(["local_agent", "remote_agent", "in_process_teammate", "subagent"]);

export function isClaudeNestedAgentTask(taskType: string): boolean {
  const normalized = taskType.trim().toLowerCase();
  return CLAUDE_NESTED_AGENT_TASK_TYPES.has(normalized) || normalized.endsWith("_agent");
}

/** One entry of the SDK's `system` / `background_tasks_changed` task set. */
export interface ClaudeBackgroundTask {
  taskId: string;
  taskType: string;
  description: string;
}

/**
 * REPLACE semantics per the SDK contract for `background_tasks_changed`: the
 * payload always carries the whole live set, so callers swap rather than pair
 * start/stop edges and a missed bookend cannot wedge a stale "still running".
 */
export function normalizeClaudeBackgroundTasks(
  tasks: ReadonlyArray<{ task_id: string; task_type: string; description: string }>
): ClaudeBackgroundTask[] {
  return tasks.map((task) => ({ taskId: task.task_id, taskType: task.task_type, description: task.description }));
}

/**
 * Pushed as a follow-up user turn when the SDK reports that every background
 * task has drained but the parent session went quiet without producing a
 * post-nested report. Without it a job/turn could sit held until its timeout.
 */
export const CLAUDE_NESTED_AGENTS_DRAINED_NUDGE = [
  "codex-chat notice: every nested agent you launched has finished, but you reported back before their results were in.",
  "Read each nested agent's output now, verify the work actually landed, finish anything still outstanding yourself, and then send your real final report."
].join("\n");

const CLAUDE_NESTED_AGENT_FOREGROUND_CONTEXT =
  "codex-chat runs nested agents in the foreground. Wait for this agent's result before continuing, and never report back while nested work is running.";

/**
 * Preamble rules given to every codex-chat-driven Claude session that can call
 * the `Agent` tool. `{{REPORT_NOUN}}` is substituted per call site so the child
 * copy stays byte-for-byte what it was before this text moved here.
 */
const CLAUDE_NESTED_AGENT_PROMPT_RULES = [
  "Never background a nested agent: always call the Agent tool with run_in_background: false (codex-chat rewrites the call if you forget) and never use isolation: \"remote\". Wait for each nested agent's result before continuing.",
  "Do not send your final report while any nested agent is still running. Your final message must come after every nested agent has finished, you have read its output, and you have verified the work actually landed — an early report is treated as a {{FAILURE_NOUN}}."
];

/** The nested-agent rules with `{{FAILURE_NOUN}}` resolved (e.g. `failed job`). */
export function claudeNestedAgentPromptRules(failureNoun: string): string[] {
  return CLAUDE_NESTED_AGENT_PROMPT_RULES.map((rule) => rule.replaceAll("{{FAILURE_NOUN}}", failureNoun));
}

/**
 * Builds the `PreToolUse` hook that rewrites every `Agent` call to run in the
 * foreground. `onRewrite` records the rewrite in whatever observability the
 * call site has (per-job `events.jsonl` for children, the ring buffer and
 * structured logger for the main loop) and must never throw.
 */
export function buildForceForegroundNestedAgentsHook(
  onRewrite: (info: { subagentType?: string }) => Promise<void> | void
): (hookInput: ClaudeHookInput) => Promise<ClaudeHookJsonOutput> {
  return async (hookInput: ClaudeHookInput): Promise<ClaudeHookJsonOutput> => {
    if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== CLAUDE_AGENT_TOOL_NAME) {
      return { continue: true };
    }
    const toolInput = (hookInput.tool_input && typeof hookInput.tool_input === "object"
      ? hookInput.tool_input
      : {}) as Record<string, unknown>;
    if (toolInput.run_in_background === false) return { continue: true };
    await Promise.resolve(
      onRewrite({ subagentType: typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined })
    ).catch(() => undefined);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: { ...toolInput, run_in_background: false },
        additionalContext: CLAUDE_NESTED_AGENT_FOREGROUND_CONTEXT
      }
    };
  };
}
