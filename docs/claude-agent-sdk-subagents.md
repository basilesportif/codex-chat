# Claude Agent SDK subagent backend

`claude_agent_sdk` is the opt-in child-agent backend for running codex-chat subagents through the Anthropic Claude Agent SDK instead of Codex. It is intended for local, Tim-owned use with Claude subscription OAuth only.

## Enablement and auth

1. Verify Claude Code is installed and new enough:
   - `claude --version`
   - Opus 4.8 requires Claude Code v2.1.154 or later.
   - Fable 5 requires Claude Code v2.1.170 or later.
   - Sonnet 5 requires Claude Code v2.1.197 or later.
   - Claude Code v2.1.200 or later validates Agent SDK `setModel()` strings; this machine tested with v2.1.201.
2. Verify subscription OAuth without printing secrets:
   - preferred: `claude auth login`, which stores local `~/.claude/.credentials.json` credentials;
   - alternate: `claude setup-token`, then provide `CLAUDE_CODE_OAUTH_TOKEN` to the service environment.
3. Set `[subagents.claude].enabled = true`. Then route jobs to Claude one of three ways:
   - **per dispatch (primary)**: include `backend: "claude_agent_sdk"` (alias `"claude"`) in a `dispatch_subagent` directive — routes only that job, leaving the configured/override default untouched;
   - runtime override: `agent backend claude` flips the default for all new/queued jobs (canary/recovery lever);
   - config: `subagents.backend = "claude_agent_sdk"` makes Claude the configured default.

Do not configure this backend with API keys. codex-chat strips Anthropic API keys, Bedrock/Vertex/Foundry/gateway provider env vars, OpenRouter/Codex provider keys, OpenAI transcription keys, and Slack/ingest secrets before starting Claude SDK children. Readiness requires either local Claude OAuth credentials or `CLAUDE_CODE_OAUTH_TOKEN`; non-OAuth auth sources are rejected.

## Current Claude model strings and aliases

Use full model IDs in codex-chat dispatches and config examples when pinning behavior. Claude Code aliases are convenient interactively, but aliases can update over time.

| Purpose | Full Claude API / Agent SDK model string | Claude Code alias notes |
| --- | --- | --- |
| Most capable generally available model | `claude-fable-5` | `fable`; `best` uses Fable 5 when available, otherwise latest Opus. Fable may trigger safety fallback for some cyber/bio requests. |
| Complex agentic coding / enterprise work | `claude-opus-5` | Flagship since 2026-07-24; near-Fable intelligence at half the price, supports fast mode. `opus` resolves to Opus 5 (verified live 2026-07-31). `claude-opus-4-8` remains available as a pinned older snapshot. |
| Daily coding / speed-intelligence balance | `claude-sonnet-5` | `sonnet` currently resolves to Sonnet 5 on the Anthropic API. |
| Fast, efficient work | `claude-haiku-4-5-20251001` | alias `claude-haiku-4-5`; Claude Code alias `haiku`. |

Anthropic's current model-ID convention for Claude 4.6 and later uses dateless pinned IDs such as `claude-opus-4-8` and `claude-sonnet-5`; they are fixed model snapshots, not evergreen pointers. Older pre-4.6 aliases such as `claude-haiku-4-5` resolve to dated snapshots.

## codex-chat dispatch semantics

- `backend: "claude_agent_sdk"` in a `dispatch_subagent` directive routes that single job to Claude. Aliases `"claude"`, `"claude_code"`, and `"claude-agent-sdk"` normalize to the canonical kind. Jobs without a `backend` field use the configured/override default. Explicitly routed queued jobs keep their backend when the runtime override changes.
- `model` is passed through to the Claude Agent SDK unchanged. For Opus 5, dispatch with `model: "claude-opus-5"`; for Fable 5, dispatch with `model: "claude-fable-5"`.
- `effort` maps to the Claude SDK `effort` option for `low`, `medium`, `high`, and `xhigh`.
- `effort: "none"` or `"minimal"` disables Claude thinking. Do not use those with `claude-fable-5`, because Fable 5 has always-on adaptive thinking and rejects explicit disabled thinking. Prefer `high` for most Fable work and `xhigh` only for the most capability-sensitive workloads.
- Claude has no Codex `serviceTier` equivalent. codex-chat records the requested tier for observability. When `serviceTier: "fast"` and `[subagents.claude].fastMode = true`, codex-chat passes Claude Code fast-mode settings when the installed SDK supports them; otherwise tier is ignored.
- `codexProfile` and `modelProvider` are Codex-provider concepts; the service **rejects** a Claude-routed dispatch that includes them. `serviceTierMode` is resolved for observability only.
- The backend is steerable while its SDK streaming input session is active; `agent steer <ref> <text>` enqueues a follow-up user message in the same Claude session.

## Native nested agents

Every Claude-backed codex-chat child session gets the SDK-native `Agent` tool and three programmatic agent definitions:

- `implementer` writes and edits code, runs relevant tests/builds, and uses `high` effort. Its model comes from `[subagents.claude].implementerModel` (default `sonnet`).
- `investigator` performs read-only code, repository, and log research with `medium` effort. Its model comes from `[subagents.claude].investigatorModel` (default `sonnet`), and edit tools are explicitly disallowed.
- `reviewer` performs findings-first, read-only code review with `high` effort. Its model comes from `[subagents.claude].reviewerModel` (default `claude-opus-5`).

The corresponding environment overrides are `CODEX_CHAT_SUBAGENTS_CLAUDE_IMPLEMENTER_MODEL`, `CODEX_CHAT_SUBAGENTS_CLAUDE_INVESTIGATOR_MODEL`, and `CODEX_CHAT_SUBAGENTS_CLAUDE_REVIEWER_MODEL`. Aliases and full Claude model IDs are passed through to the SDK unchanged.

Before the backend pushes the first user message, it appends generated guidance naming these agents, their configured models, their capabilities, the preferred implement-review orchestration pattern, and the foreground/no-early-report rules below. The stored `SubagentJob` prompt is not changed, and later steering messages are not augmented.

Native nested agents run **inside** the parent Claude session; they are not separate `SubagentManager` jobs. Cancelling or timing out the parent job interrupts the SDK query and takes its nested agents down with it.

### Nested agents always run in the foreground, and never complete a job early

Agent SDK 0.3.220 defaults the `Agent` tool's `run_in_background` to `true`: a nested agent returns a "running in the background" tool result immediately, so the parent can finish its turn — and codex-chat would settle the job and close the query — while the real work is still running. Three layers prevent that:

1. **Tool-input rewrite (structural).** Every Claude-backed child session installs a `PreToolUse` hook matched to the `Agent` tool that rewrites the call with `run_in_background: false`. Each rewrite is logged to the job's `events.jsonl` as `claude_nested_agent_forced_foreground`. The three agent definitions also declare `background: false`.
2. **Completion gating (structural).** The session tracks the SDK's `system` / `background_tasks_changed` message, which carries the full set of live background tasks with REPLACE semantics. Only the **nested-agent** subset gates completion: `task_type` in that payload is the raw task-state discriminant, so codex-chat counts `local_agent` (what the `Agent` tool registers), `remote_agent`, `in_process_teammate`, and anything else ending in `_agent`. Backgrounded `Bash` (`local_bash`), `local_workflow`, and `mcp_task` are ignored, so a child that leaves a dev server, watcher, or `tail -f` running still completes normally. The full set is still recorded in the `claude_background_tasks_changed` event for observability.

   If a successful `result` arrives while a nested agent is live, the job is **not** completed: the result is held (`claude_result_held_for_nested_agents`), `activeTurnId` stays set so the job remains running and steerable, and `SubagentJob.waitingOnNestedAgents` is set so `agents` status shows `waiting on N nested agents`. The job settles on the next successful result once no nested agent is live. If the nested agents drain and the parent then stays silent for `[subagents.claude].steerSettleGraceMs`, codex-chat pushes one follow-up user turn (`claude_nested_agents_drained_nudge`) asking for the post-nested report, and settles on that turn's result; a second silent drain settles with whatever result was last recorded. The parent job timeout still applies as the outer bound.
3. **Prompt guidance.** The generated child preamble forbids backgrounded nested agents and remote isolation, and forbids sending a final report while any nested agent is still running.

## Fable to GPT-5.5 coding helper evaluation

A Claude SDK option that lets Fable ask GPT-5.5 for coding help was evaluated but not implemented in this pass. The safe shape is a narrow SDK/MCP tool exposed only to Claude-backed sessions, not a raw `Bash`/CLI escape hatch and not a codex-chat-managed child dispatch. Existing codex-chat Codex launch paths are split between `codex exec` (`CodexExecChildAgentBackend.buildArgs`) and the app-server backend; both already centralize sandbox, approval, fast-mode, profile/provider, and sanitized Codex environment handling.

Concrete follow-up plan:

1. Add a service-owned Claude SDK MCP tool such as `codex_gpt55_coding_help` with a schema limited to `{question, files?, diff?, maxPromptBytes?}` and no arbitrary command field.
2. Execute through an internal wrapper that reuses `sanitizeCodexChildProcessEnv`, fixed `codex exec --json --output-last-message ... --model gpt-5.6-sol -c model_reasoning_effort=high -c features.fast_mode=true -c service_tier=fast --sandbox <configured> -c ask_for_approval=<configured>`, with workspace pinned to `config.service.workspace` and artifacts written under the parent Claude job directory.
3. Capture stdout/stderr/last-message and a JSONL tool event so the parent Claude job and codex-chat job status expose what ran; redact provider credentials exactly like the existing Codex child path.
4. Wire cancellation to the parent Claude SDK job so an interrupted/killed Claude child also kills any nested Codex helper process tree; enforce one helper call at a time per Claude job plus timeout/max bytes limits.
5. Add cost/rate-limit controls before enabling by default: explicit config flag, model allowlist, concurrency limit, timeout, and a clear error surface when the Codex provider rejects `gpt-5.6-sol` or Fast tier.

Tradeoffs:

- Claude-native nested `Agent`: best visibility inside Claude, clean cancellation within the SDK, and no cross-provider secret surface, but it cannot call GPT models.
- SDK tool shelling out to Codex: enables Fable→GPT coding consultation and can reuse existing Codex env sanitization, but it adds nested process lifecycle, cost/rate-limit, artifact retention, and observability responsibilities. It should be implemented only as the narrow audited wrapper above.

## Low-risk canary pattern

Use a no-tool prompt and write outputs only under the job artifact directory:

```json
{
  "backend": "claude_agent_sdk",
  "model": "claude-opus-4-8",
  "effort": "medium",
  "serviceTier": "fast",
  "claude": {
    "enabled": true,
    "permissionMode": "plan",
    "allowedTools": [],
    "settingSources": [],
    "fastMode": true
  }
}
```

Prompt: `Low-risk canary only. Do not edit files and do not use tools. Reply with exactly: CLAUDE_BACKEND_OPUS_4_8_CANARY_OK`.

Record the artifact directory, `events.jsonl`, `last-message.md`, the exact model string, Claude Code version, SDK package version, and whether the SDK initialization account reported first-party subscription OAuth. Do not print tokens, credential contents, or API key values.

## Primary references

- Anthropic model overview: `https://platform.claude.com/docs/en/about-claude/models/overview`
- Anthropic model IDs and versioning: `https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions`
- Claude Code model configuration: `https://code.claude.com/docs/en/model-config`
- Claude Agent SDK TypeScript reference: `https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript`
