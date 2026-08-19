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

/**
 * The nested-agent rules with `{{FAILURE_NOUN}}` resolved (e.g. `failed job`).
 * When a concurrency cap is in force the fan-out rule is appended, so the model
 * learns the limit from its preamble instead of only from a denial.
 */
export function claudeNestedAgentPromptRules(failureNoun: string, maxConcurrentNestedAgents = 0): string[] {
  const rules = CLAUDE_NESTED_AGENT_PROMPT_RULES.map((rule) => rule.replaceAll("{{FAILURE_NOUN}}", failureNoun));
  if (maxConcurrentNestedAgents > 0) {
    rules.push(
      `Never run more than ${maxConcurrentNestedAgents} nested agent${maxConcurrentNestedAgents === 1 ? "" : "s"} at once — this host has limited memory and each nested agent is its own process. Additional Agent calls are denied until a running one finishes; launch them in batches of at most ${maxConcurrentNestedAgents}, or work sequentially.`
    );
  }
  return rules;
}

/**
 * The permission-denial text a capped `Agent` call gets back. Instructive on
 * purpose: the model must know the call did not start, that waiting or going
 * sequential are the two ways forward, and that hammering retry is not.
 */
export function claudeNestedAgentFanoutDenialReason(cap: number, liveCount: number): string {
  return [
    `codex-chat runs nested agents in the foreground and allows at most ${cap} at a time; ${liveCount} ${liveCount === 1 ? "is" : "are"} already running, so this Agent call was NOT started.`,
    "The host has ~3.8GB of RAM and each nested agent is a separate process holding its own payloads — unbounded fan-out is what OOM-killed this service before.",
    "Wait for a running nested agent to finish and then launch this one, or just do the work sequentially yourself. Do not retry in a tight loop, and do not report back as if this agent had run."
  ].join(" ");
}

/**
 * Per-session concurrency guard for nested `Agent` calls.
 *
 * Two independent views of "how many nested agents are live", because neither
 * alone is sufficient:
 *
 * - **Admitted tool calls.** The forced-foreground rewrite stops a *single*
 *   Agent call from detaching, but it cannot stop the model from emitting
 *   three Agent tool_use blocks in ONE assistant message — which is exactly
 *   the 2026-08-18 OOM. Those run in parallel and their `PreToolUse` hooks can
 *   all fire before any of them registers as a background task, so the hook
 *   has to count its own admissions.
 * - **Live nested background tasks.** Covers anything that did detach (a call
 *   that arrived already `run_in_background: false`-free of our rewrite, a
 *   task inherited from earlier in the session) and is the same view that
 *   already gates job/turn completion.
 *
 * The two are `max()`-ed rather than summed: the same nested agent normally
 * shows up in both, and double-counting would halve the effective cap.
 */
export class ClaudeNestedAgentLimiter {
  /** Agent calls admitted by `PreToolUse` that have not yet reported back. */
  private readonly admittedToolUseIds = new Set<string>();
  /** Nested-agent task ids from the last `background_tasks_changed` payload. */
  private liveTaskIds = new Set<string>();

  /** `maxConcurrent <= 0` disables the cap (rewrite-only behaviour). */
  constructor(private readonly maxConcurrent: number) {}

  get cap(): number {
    return this.maxConcurrent;
  }

  liveCount(): number {
    return Math.max(this.admittedToolUseIds.size, this.liveTaskIds.size);
  }

  /** REPLACE semantics, mirroring {@link normalizeClaudeBackgroundTasks}. */
  noteLiveNestedAgentTasks(tasks: ReadonlyArray<ClaudeBackgroundTask>): void {
    this.liveTaskIds = new Set(tasks.map((task) => task.taskId));
  }

  /**
   * Drops every admitted-but-unreleased call. Called at turn boundaries so a
   * `PostToolUse` that never arrives (interrupt, killed child, SDK hiccup)
   * cannot wedge the cap shut for the rest of a long-lived session.
   *
   * Deliberately does NOT clear {@link liveTaskIds}: a turn CAN end with
   * nested agents still running — `releaseHeldResultOnMaxHold` in
   * `claude-main-agent.ts` releases a held result once `nestedAgentHoldMaxMs`
   * (55s) elapses, and an investigator routinely runs minutes past that. The
   * live set is the only surviving evidence of those agents, it is maintained
   * with REPLACE semantics from the SDK (so it self-heals on the next
   * payload), and `background_tasks_changed` only fires on CHANGE — clearing
   * it here would blind the cap for as long as the set stays stable and let
   * the next turn admit a second full batch on top of the running one.
   */
  reset(): void {
    this.admittedToolUseIds.clear();
  }

  /**
   * A call with no `tool_use_id` cannot be released later, so it is counted as
   * a no-op admit rather than under a synthetic key: an un-releasable slot
   * would leak and tighten the cap forever. Unreachable in practice —
   * `PreToolUseHookInput.tool_use_id` is non-optional in the SDK types — and
   * this fails in the safe direction if that ever changes.
   */
  private admit(toolUseId: string | undefined): void {
    if (toolUseId) this.admittedToolUseIds.add(toolUseId);
  }

  private release(toolUseId: string | undefined): void {
    if (toolUseId) this.admittedToolUseIds.delete(toolUseId);
  }

  /**
   * Builds the `PreToolUse` hook: denies an `Agent` call once the cap is
   * reached, and otherwise rewrites it to run in the foreground.
   *
   * `onRewrite`/`onDenied` record the decision in whatever observability the
   * call site has (per-job `events.jsonl` for children, the ring buffer and
   * structured logger for the main loop) and must never throw.
   */
  buildPreToolUseHook(handlers: {
    onRewrite: (info: { subagentType?: string }) => Promise<void> | void;
    onDenied: (info: { subagentType?: string; liveCount: number; cap: number }) => Promise<void> | void;
  }): (hookInput: ClaudeHookInput) => Promise<ClaudeHookJsonOutput> {
    return async (hookInput: ClaudeHookInput): Promise<ClaudeHookJsonOutput> => {
      if (hookInput.hook_event_name !== "PreToolUse" || hookInput.tool_name !== CLAUDE_AGENT_TOOL_NAME) {
        return { continue: true };
      }
      const toolInput = (hookInput.tool_input && typeof hookInput.tool_input === "object"
        ? hookInput.tool_input
        : {}) as Record<string, unknown>;
      const subagentType = typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined;
      const toolUseId = typeof hookInput.tool_use_id === "string" ? hookInput.tool_use_id : undefined;
      const live = this.liveCount();
      if (this.maxConcurrent > 0 && live >= this.maxConcurrent) {
        await Promise.resolve(onDeniedSafely(handlers.onDenied, { subagentType, liveCount: live, cap: this.maxConcurrent }));
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: claudeNestedAgentFanoutDenialReason(this.maxConcurrent, live)
          }
        };
      }
      this.admit(toolUseId);
      if (toolInput.run_in_background === false) return { continue: true };
      await Promise.resolve(handlers.onRewrite({ subagentType })).catch(() => undefined);
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

  /**
   * Builds the `PostToolUse` / `PostToolUseFailure` hook that frees an
   * admitted slot. Registered for both events so an errored or interrupted
   * nested agent releases its slot too.
   */
  buildPostToolUseHook(): (hookInput: ClaudeHookInput) => Promise<ClaudeHookJsonOutput> {
    return async (hookInput: ClaudeHookInput): Promise<ClaudeHookJsonOutput> => {
      if (hookInput.hook_event_name !== "PostToolUse" && hookInput.hook_event_name !== "PostToolUseFailure") {
        return { continue: true };
      }
      if (hookInput.tool_name !== CLAUDE_AGENT_TOOL_NAME) return { continue: true };
      this.release(typeof hookInput.tool_use_id === "string" ? hookInput.tool_use_id : undefined);
      return { continue: true };
    };
  }
}

function onDeniedSafely(
  onDenied: (info: { subagentType?: string; liveCount: number; cap: number }) => Promise<void> | void,
  info: { subagentType?: string; liveCount: number; cap: number }
): Promise<void> {
  return Promise.resolve(onDenied(info)).catch(() => undefined);
}
