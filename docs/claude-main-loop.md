# Claude Agent SDK main loop

The Claude main-loop adapter runs one persistent, streaming-input Claude Agent SDK query for the lifetime of the service. It is an opt-in alternative to the default Codex app-server main loop.

## Prerequisites

Authenticate a Claude subscription as the same operating-system user that runs `codex-chat`:

```bash
claude auth login
```

The adapter accepts only first-party subscription OAuth and fails closed if the SDK reports another provider or API-key authentication. A working `claude_agent_sdk` child backend is a useful verification that the service user, credential file, executable, and network path are ready. Tokens and account identity are not written to logs; only the same redacted account summary used by the child backend is recorded.

## Enable

Set the provider in TOML and restart the service:

```toml
[mainAgent]
provider = "claude_agent_sdk"
```

You can instead set `CODEX_CHAT_MAIN_PROVIDER=claude_agent_sdk`. Model, effort, permission mode, tool lists, executable path, session name, startup timeout, the nested-agent hold windows (`nestedAgentSettleGraceMs`, `nestedAgentHoldMaxMs`), and the context-rollover threshold (`contextRolloverInputTokens`) live under `[mainAgent.claude]`; the model accepts either an alias or a full model ID. Environment overrides are listed in `.env.example`. Configuration changes take effect after restart unless a persisted runtime provider override is active.

## Runtime behavior

Everything downstream of main-agent final text carries over unchanged: Telegram and Slack channels, directive parsing and execution, codex-chat-managed subagents, loops, monitors, and capability enforcement. Streaming text deltas and status events use the same `MainAgentClient` event contract as Codex, and the SDK result message terminates exactly one main turn.

### Nested agents never end a turn early

`[mainAgent.claude].allowedTools` includes the SDK-native `Agent` tool, and Agent SDK 0.3.220 defaults its `run_in_background` to `true`: a nested agent returns a "running in the background" tool result immediately, so the session can finish its turn — and codex-chat would reply on Telegram — describing work that has not happened yet. Unlike a child job the main session is long-lived, so nothing is killed and the nested result still lands eventually; the damage is the premature reply. Three layers prevent it, mirroring the child backend (`docs/claude-agent-sdk-subagents.md`), with the shared predicate, nudge text, and hook builder living in `src/claude-nested-agents.ts`.

1. **Tool-input rewrite (structural).** The main query installs a `PreToolUse` hook matched to the `Agent` tool that rewrites the call with `run_in_background: false`. Rewrites are recorded in the redacted ring buffer and logged as `claude_nested_agent_forced_foreground`. The main loop declares no programmatic agent definitions, so unlike the child backend there is nothing to annotate with `background: false`: whatever agent types the tool exposes come from the SDK and from any filesystem agent files `settingSources` loads. The hook is the only structural lever here.
2. **Turn gating (structural).** The session tracks `system` / `background_tasks_changed` (REPLACE semantics: each payload carries the whole live set) and filters it with the same nested-agent predicate the child backend uses — `local_agent`, `remote_agent`, `in_process_teammate`, and anything ending in `_agent`. Backgrounded `Bash` (`local_bash`), `local_workflow`, and `mcp_task` are ignored, so a dev server or watcher left running never delays a reply.

   A successful `result` that arrives while a nested agent is live is **held** (`claude_result_held_for_nested_agents`): no `final` event is emitted, the turn stays open, and a `status` event reports `waiting on N nested agents before replying`. The turn ends on the next successful result once no nested agent is live. An error result is never held — it ends the turn immediately.
3. **Prompt guidance.** The Claude-only suffix appended to the behavior-pack bootstrap forbids backgrounded nested agents and remote isolation, and forbids ending a turn while nested work is running.

Two bounds keep a held turn from wedging the service, both under `[mainAgent.claude]`:

- `nestedAgentSettleGraceMs` (default 10000) — once the nested set drains, how long the session may stay silent before codex-chat pushes one follow-up user turn (`claude_nested_agents_drained_nudge`) asking for the post-nested report. The timer is cancelled and re-armed on every SDK message, so a session that is actually working is never nudged. If the nudge has already been sent (or cannot be pushed), the held text is released as the turn's `final`.
- `nestedAgentHoldMaxMs` (default 55000) — an absolute cap on one turn's hold, armed when the hold starts and never reset. On expiry the held text is released with a note naming how many nested agents were still running. The cap exists because the service watchdog force-aborts any main turn older than 80s (`TURN_ABORT_MS`) and tells the user their request timed out; the hold must always release first.

Interaction with the turn queue and provider switching:

- The service keeps `turnRunning` set while it consumes `sendTurn`, so user messages that arrive during a hold are queued by `shouldQueueTurn` and drained when the held turn ends. Because every hold terminates (post-nested result, nudge, drain grace, or the hard cap), the drain cannot deadlock.
- `main provider <other>` allows in-flight turns only `MAIN_AGENT_SWITCH_GRACE_MS` (15s) before calling `stop()` on the old client. `stop()` now flushes a held result as the turn's `final` before closing the event queue, so a switch during a hold costs the user a stale-but-real reply rather than silence. The same flush runs when the SDK query dies mid-hold, ahead of the error event.

Claude sessions are stored under the separate `mainAgent.claude.mainSessionName` key. Restarting with the same provider resumes that session. Switching providers does not transfer conversation continuity: the Claude and Codex histories remain separate. Durable Employees are currently unsupported with the Claude main loop and configuration startup fails if both are enabled.

### Session lifecycle and context rollover

One SDK session is resumed forever, so without a bound its context grows monotonically. On 2026-08-01 the main session reached ~934k effective input tokens against sonnet-5's 1M window and the next turn stalled with no SDK error and no stderr — the CLI child simply blocked until the 80s watchdog (`TURN_ABORT_MS`) killed the turn, and every later turn resumed the same oversized session and hung identically. Two mechanisms now prevent that hang loop:

- **Proactive rollover.** Every `result` message carries `usage` (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`; `modelUsage` is the fallback). The client records that total as the session's effective context size and exposes it via `contextStats()`. When a completed turn is at or above `[mainAgent.claude].contextRolloverInputTokens` (default 800000), a rollover is armed and executed at a **turn boundary** — never mid-turn: the query is stopped, the persisted session key is cleared, and a fresh session starts. That is the next boundary, unless the handoff summary below is still generating, in which case the swap is deferred to a later boundary (bounded by `contextRolloverHardCapTokens`). The new session's first user message is prefixed with a handoff note (see **Summary handoff** below; without a summary it is the one-line "prior history is unavailable" note). The client logs `context_rollover_scheduled` then `context_rollover`, and emits a `status` event whose `raw.event` is `claude_context_rollover`; the service turns that into a user-facing "history was reset" reply plus an ops notification. The default leaves ~200k of headroom for the next turn's prompt, tool output, and an effort=high response. Agent SDK 0.3.220 exposes no imperative compaction control on `Query` (only the `autoCompactEnabled` / `autoCompactWindow` settings and the `PreCompact` / `PostCompact` hooks), which is why rollover, not compaction, is the mechanism.
- **Provider-aware watchdog recovery.** Every watchdog force-abort clears the persisted main session so the restart that follows starts clean. It now clears the **active** provider's key through `MainAgentSwitcher.clearPersistedSession()` rather than the hardcoded Codex key; the old behavior deleted `codex-chat-main`, which does not exist in Claude mode, so the wedged Claude session survived every abort and restart. The `turn_force_abort` log line also carries `provider`, `lastTurnInputTokens`, and `contextRolloverThresholdTokens`, so a context-exhaustion stall is distinguishable from any other stall.

`resetSession()` (used by the terminal-stream-disconnect recovery path) performs the same clear-and-restart on demand.

### Summary handoff

A rollover would otherwise cost the whole conversation, so the moment one is *scheduled* (threshold crossed at a turn's completion) the client starts an out-of-band summarization. Nothing in the turn path ever waits on it.

- **Source.** The doomed session's own JSONL transcript, at `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<sessionId>.jsonl`. Only `user`/`assistant` text blocks are kept (tool calls, tool results, thinking blocks and `isSidechain` subagent entries are dropped); messages are taken newest-first up to ~120k characters, then re-ordered chronologically. Reads are capped at 32 MB and every parse failure is skipped — these files reach several MB and thousands of rows.
- **Summarizer.** A throwaway one-shot SDK query (`[mainAgent.claude].handoffSummaryModel`, default `claude-sonnet-5`, `effort: "low"`, `maxTurns: 1`, no tools, no `settingSources`, no `resume`, session id never persisted), reusing the main loop's OAuth-sanitized env. It is timed out after 4 minutes and every failure is non-fatal. It never touches `codex_sessions.json` or the switcher, so it cannot disturb main-agent state.
- **Artifact.** `data/state/main_session_handoff.json`: `{ forSessionId, createdAt, inputTokensAtSchedule, status: "pending" | "ready" | "failed", summary?, abandoned?, abandonedAt? }`. It is written at schedule time and updated in place only while it still names the same session, so a newer schedule supersedes an older brief.
- **Deferred swap.** During an active conversation the next turn boundary arrives seconds after the threshold crossing — long before a ~30-60s summarization finishes — so swapping immediately would throw the brief away in exactly the case where continuity matters most. While the artifact for the current session is still `pending`, the armed rollover is therefore **skipped** at the boundary and the existing session is resumed as normal (skipping, not waiting: the turn is never blocked). The swap happens on the first boundary where the artifact has resolved (`ready`, `failed` or `skipped`), where there is no artifact at all (nothing to wait for — today's behavior), or where the last turn's effective input tokens reach `[mainAgent.claude].contextRolloverHardCapTokens` (default 900000, below the ~934k wedge point), which rolls over with the plain note regardless. Deferrals log `context_rollover_deferred` with the token count, hard cap and artifact status. A rollover is armed at most once per session, so waiting never re-schedules or supersedes its own brief. The watchdog path is unaffected: a wedged session is cleared immediately, because recovery beats continuity.
- **Consumption.** At the first turn of any fresh session that follows an abandoned one (rollover, watchdog clear, or manual reset), a `ready` artifact whose `forSessionId` matches the abandoned session is prepended to the user's message, clearly framed as background rather than user instructions, and the artifact is invalidated. A summary that is still generating, failed, or belongs to another session is skipped and the plain one-line note is used instead. The rollover `status` event carries `handoffSummary: true|false`, and the service's user notice and ops ping say which one happened.
- **Restart safety.** The same artifact is the *persisted* pending-rollover flag. If the process restarts between the threshold crossing and the next turn, `start()` sees an artifact naming the still-persisted session and not yet marked `abandoned`, refuses to resume it (logging `context_rollover_restart_fresh`), clears the session key and starts fresh — the fresh session then consumes the brief on its first turn. An artifact older than 6 hours is ignored entirely.
- **Config.** `[mainAgent.claude].handoffSummaryEnabled` (default `true`) turns summarization off (the artifact is still written, with `status: "skipped"`, so restart safety is unaffected) and restores the plain one-line note. Log events: `handoff_summary_started`, `handoff_summary_ready`, `handoff_summary_failed`, `handoff_consumed`, `handoff_skipped_stale`, `handoff_skipped_unready`.

## Dynamic switching and recovery

Admins can switch the active main loop without restarting the service. These commands are parsed and executed by the service before the main-turn queue, so they remain available when the current provider is broken or a turn is wedged:

- `main provider` — show the effective provider, whether it came from config or a runtime override, and health including the active session ID.
- `main provider codex` — switch to Codex.
- `main provider claude` — switch to Claude Agent SDK.
- `main provider config` — clear the runtime override and immediately switch to the configured provider if needed.

A switch allows an in-flight turn up to 15 seconds to finish. After that grace period, the old client's stop path interrupts it. The old provider is stopped, the new provider starts, and the runtime override is persisted. If the new provider cannot start, the service automatically attempts to restart the previous provider and reports both the switch failure and any rollback failure.

The override survives service restarts and wins over `[mainAgent].provider` until `main provider config` clears it. Provider sessions remain separate, so switching back resumes that provider's own stored history rather than carrying conversational context across. Switching to Claude is refused while durable Employees are enabled.

Recovery example: if the Claude main loop is misbehaving, send `main provider codex`. The service handles the command without waiting for Claude to parse it.

## Rollback

For an immediate recovery, send `main provider codex`. To return control to configuration, send `main provider config`; if config selects Codex, the switch happens immediately. Alternatively, set `[mainAgent].provider = "codex"` (or `CODEX_CHAT_MAIN_PROVIDER=codex`), clear any runtime override, and restart. The Codex session uses its own stored name and resumes where it left off before the provider switch.

## Observability

Service health reports `provider = "claude_agent_sdk"`, `transport = "claude-agent-sdk"`, and the current Claude `sessionId`. Recent-log introspection includes a small redacted ring buffer of SDK lifecycle/status lines and stderr; persistent redacted SDK stderr is written below the configured state directory.
