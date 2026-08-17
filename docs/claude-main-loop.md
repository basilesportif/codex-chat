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
- `nestedAgentHoldMaxMs` (default 55000) — an absolute cap on one turn's hold, armed when the hold starts and never reset. On expiry the held text is released with a note naming how many nested agents were still running. The cap is sized against the service watchdog, which aborts a turn after `[service].turnInactivityAbortMs` (default 80s) of **silence**. A hold is not silent while the nested agents work — their tool traffic streams through the parent query and resets the budget — so the only quiet stretch a hold can produce is the post-drain settle/nudge window. 55s of hold against an 80s silence budget leaves 25s of margin, so the hold always releases itself rather than being killed.

Interaction with the turn queue and provider switching:

- The service keeps `turnRunning` set while it consumes `sendTurn`, so user messages that arrive during a hold are queued by `shouldQueueTurn` and drained when the held turn ends. Because every hold terminates (post-nested result, nudge, drain grace, or the hard cap), the drain cannot deadlock.
- `main provider <other>` allows in-flight turns only `MAIN_AGENT_SWITCH_GRACE_MS` (15s) before calling `stop()` on the old client. `stop()` now flushes a held result as the turn's `final` before closing the event queue, so a switch during a hold costs the user a stale-but-real reply rather than silence. The same flush runs when the SDK query dies mid-hold, ahead of the error event.

Claude sessions are stored under the separate `mainAgent.claude.mainSessionName` key. Restarting with the same provider resumes that session. Switching providers does not transfer conversation continuity: the Claude and Codex histories remain separate. Durable Employees are currently unsupported with the Claude main loop and configuration startup fails if both are enabled.

### Session lifecycle and context rollover

One SDK session is resumed forever, so without a bound its context grows monotonically. On 2026-08-07 the main session filled up and the next turn stalled with no SDK error and no stderr — the CLI child simply blocked until the watchdog killed the turn, and every later turn resumed the same oversized session and hung identically. Two mechanisms now prevent that hang loop:

- **Proactive rollover.** Context occupancy is read off the parent session's own `assistant` messages, each of which carries the usage of exactly **one** API request (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`); the most recent such figure is its occupancy (last-write-wins), exposed via `contextStats()`. Two things must NOT be used for this, and both were, until 2026-08-17:
  - A `result` message's `usage` is **summed over every API request the turn made**, not the last one. Verified against SDK 0.3.220: a four-request turn whose real occupancy peaked at 1,866 tokens reported `usage` totalling 6,996 — the sum of all four. `modelUsage` is the same sum keyed by model. Read as occupancy this overstates it by roughly the number of tool round-trips, which is how a 1M-token window produced armed values of 1,121,960 / 1,329,142 / 2,050,378 and rolled over sessions that were nowhere near full.
  - Subagent messages stream through the same query with `parent_tool_use_id` set. They describe a different conversation and are excluded.

  Occupancy is **last-write-wins, not a high-water mark**: SDK-side auto-compaction can shrink a session's context in place, and a ratcheted maximum would leave a compacted session reading as near-full forever — arming pointless rollovers and, worse, making every watchdog abort look like wedge evidence and destroy a healthy conversation.

  `usage.iterations` (the last entry that actually carries request token counts) is the fallback when no parent assistant message carried usage; it is typed (`BetaUsage.iterations: BetaIterationsUsage | null`) but undocumented and usually null, and is read defensively because only the `BetaMessageIterationUsage` member of its four-member union carries prompt counters. If both signals disappear, rollover and the watchdog's wedge evidence go blind together, so a completed turn with no occupancy signal logs a rate-limited `context_occupancy_unavailable` warning rather than failing quietly.

  Occupancy is persisted alongside the session id (`codex_sessions.json`, `lastInputTokens`) and re-seeded on resume. Without that a restarted service has no occupancy until a turn *completes* — and a session wedged because it is full never completes one, so the wedge evidence would be missing in exactly the case it exists for. `modelUsage[model].contextWindow` is a static model property, not a sum, and is surfaced as `contextWindowTokens` so an occupancy figure can be read as a fraction of the window (800000 / 900000 are 80% / 90% of sonnet-5's 1M). When a completed turn is at or above `[mainAgent.claude].contextRolloverInputTokens` (default 800000), a rollover is armed and executed at a **turn boundary** — never mid-turn: the query is stopped, the persisted session key is cleared, and a fresh session starts. That is the next boundary, unless the handoff summary below is still generating, in which case the swap is deferred to a later boundary (bounded by `contextRolloverHardCapTokens`). The new session's first user message is prefixed with a handoff note (see **Summary handoff** below; without a summary it is the one-line "prior history is unavailable" note). The client logs `context_rollover_scheduled` then `context_rollover`, and emits a `status` event whose `raw.event` is `claude_context_rollover`; the service turns that into a user-facing "history was reset" reply plus an ops notification. The default leaves ~200k of headroom for the next turn's prompt, tool output, and an effort=high response. Agent SDK 0.3.220 exposes no imperative compaction control on `Query` (only the `autoCompactEnabled` / `autoCompactWindow` settings and the `PreCompact` / `PostCompact` hooks), which is why rollover, not compaction, is the mechanism.
- **Evidence-gated watchdog recovery.** A watchdog force-abort **keeps** the persisted main session by default; see [Turn watchdog](#turn-watchdog). When it does clear, it clears the **active** provider's key through `MainAgentSwitcher.clearPersistedSession()` rather than the hardcoded Codex key; the old behavior deleted `codex-chat-main`, which does not exist in Claude mode, so the wedged Claude session survived every abort and restart.

`resetSession()` (used by the terminal-stream-disconnect recovery path) performs the same clear-and-restart on demand.

### Summary handoff

A rollover would otherwise cost the whole conversation, so the moment one is *scheduled* (threshold crossed at a turn's completion) the client starts an out-of-band summarization. Nothing in the turn path ever waits on it.

- **Source.** The doomed session's own JSONL transcript, at `~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<sessionId>.jsonl`. Only `user`/`assistant` text blocks are kept (tool calls, tool results, thinking blocks and `isSidechain` subagent entries are dropped); messages are taken newest-first up to ~120k characters, then re-ordered chronologically. Reads are capped at 32 MB and every parse failure is skipped — these files reach several MB and thousands of rows.
- **Summarizer.** A throwaway one-shot SDK query (`[mainAgent.claude].handoffSummaryModel`, default `claude-sonnet-5`, `effort: "low"`, `maxTurns: 1`, no tools, no `settingSources`, no `resume`, session id never persisted), reusing the main loop's OAuth-sanitized env. It is timed out after 4 minutes and every failure is non-fatal. It never touches `codex_sessions.json` or the switcher, so it cannot disturb main-agent state.
- **Artifact.** `data/state/main_session_handoff.json`: `{ forSessionId, createdAt, inputTokensAtSchedule, status: "pending" | "ready" | "failed", summary?, abandoned?, abandonedAt? }`. It is written at schedule time and updated in place only while it still names the same session, so a newer schedule supersedes an older brief.
- **Deferred swap.** During an active conversation the next turn boundary arrives seconds after the threshold crossing — long before a ~30-60s summarization finishes — so swapping immediately would throw the brief away in exactly the case where continuity matters most. While the artifact for the current session is still `pending`, the armed rollover is therefore **skipped** at the boundary and the existing session is resumed as normal (skipping, not waiting: the turn is never blocked). The swap happens on the first boundary where the artifact has resolved (`ready`, `failed` or `skipped`), where there is no artifact at all (nothing to wait for), or where occupancy reaches `[mainAgent.claude].contextRolloverHardCapTokens` (default 900000, 90% of the window), which rolls over with the plain note regardless. Deferrals log `context_rollover_deferred` with the token count, hard cap and artifact status. A rollover is armed at most once per session, so waiting never re-schedules or supersedes its own brief. The marker write is kicked off synchronously and awaited at the boundary rather than raced: before that, the boundary always read the file ahead of the write and the defer path — and with it the hard cap — was unreachable dead code.
- **Consumption.** At the first turn of any fresh session that follows an abandoned one (rollover, watchdog clear, or manual reset), a `ready` artifact whose `forSessionId` matches the abandoned session is prepended to the user's message, clearly framed as background rather than user instructions, and the artifact is invalidated. A summary that **failed** or belongs to another session is skipped and the plain one-line note is used instead. A summary that is still **generating** is left alone and stays owed to a later turn (`handoff_deferred_unready`) — clearing the artifact before checking its status used to discard briefs that finished seconds afterwards. The 6-hour age bound is what retires an orphan; a `pending` record found at startup with no job behind it is marked `failed` (`handoff_summary_orphaned`). The rollover `status` event carries `handoffSummary: true|false`, and the service's user notice and ops ping say which one happened.
- **Restart safety.** The same artifact is the *persisted* pending-rollover flag. If the process restarts between the threshold crossing and the next turn, `start()` sees an artifact naming the still-persisted session and not yet marked `abandoned`, refuses to resume it (logging `context_rollover_restart_fresh`), clears the session key and starts fresh — the fresh session then consumes the brief on its first turn. The 6-hour age bound applies to the **brief only, never to the rollover debt**: a session that was owed a rollover is still too full to resume however long the process was down, so an expired-but-owed record still forces the fresh start (`handoff_expired_rollover_forced`) and simply drops the stale summary.
- **Config.** `[mainAgent.claude].handoffSummaryEnabled` (default `true`) turns summarization off (the artifact is still written, with `status: "skipped"`, so restart safety is unaffected) and restores the plain one-line note. Log events: `handoff_summary_started`, `handoff_summary_ready`, `handoff_summary_failed`, `handoff_summary_skipped`, `handoff_summary_orphaned`, `handoff_expired_rollover_forced`, `handoff_consumed`, `handoff_skipped_stale`, `handoff_skipped_unready`, `handoff_deferred_unready`.

### Turn watchdog

The supervisor watchdog (`checkTurnTimeout`, every 5s) exists so a turn that never terminates cannot pin the service forever. How it decides depends on whether the active provider reports per-turn liveness via `turnWatchdogState()`.

**Claude (reports liveness) — inactivity, not age.** Activity is any SDK message that arrives **while a turn is open**: streamed deltas, `tool_use`/`tool_result` traffic, `system`/`status`, real `tool_progress` updates, `system`/`background_tasks_changed`, and the nested agents' own messages relayed through the parent query with `parent_tool_use_id` set. Every main-agent event that reaches `consumeCodexStream` counts too. Two exclusions matter:

- **Turn scope.** The SDK's stream is session-scoped, not turn-scoped, so a dev server some earlier turn backgrounded goes on emitting regardless of what the conversation is doing. Counting unattributable traffic would let a chatty leftover hold the budget open while the conversation is wedged, leaving only the 30-minute ceiling — which by design does not clear a session — i.e. an unbreakable half-hour abort loop.
- **Attribution, not exclusion.** The two session-scoped message types are attributed rather than dropped. Each turn records the `tool_use` ids it issues **at every depth** — its own calls and the nested agents' calls, which arrive on the same query with `parent_tool_use_id` set — and a `tool_progress` counts iff its `parent_tool_use_id` is in that set. `background_tasks_changed` counts only when the change involves a task this turn launched.

  This is deliberately *not* an exclusion of heartbeats, and the distinction is load-bearing. In production `tool_progress` is only ever a heartbeat: all 15 such messages captured in this repo's `data/subagents/` streams carry `heartbeat: true`, and none has a null `parent_tool_use_id`. Dropping heartbeats would therefore not drop noise — it would make every tool call longer than the inactivity budget unfinishable. `job_46baa638`'s single Bash ran 119.8s emitting nothing but 30s heartbeats and would have been aborted roughly 40s from the finish line; every build, test suite or clone over 80s would become unrunnable.

Two bounds remain, both under `[service]`:

- `turnInactivityAbortMs` (default 80000) — how long the turn may produce **nothing at all**. A turn that is working is never aborted, however long the work takes. The wall clock this replaces destroyed ten healthy multi-step turns in the fortnight to 2026-08-17 and no real hang: a clock cannot tell a four-minute agentic task from a wedged session.
- `turnAbsoluteAbortMs` (default 1800000) — runaway backstop for a turn that keeps emitting events forever. `turn_force_abort` logs `abortKind` (`inactivity` / `absolute` / `wall_clock`) so which bound fired is never ambiguous.

The deadline is **suspended** while the provider reports `suspended: true` — today, the inline `stop()`/`start()` a context rollover performs inside `sendTurn`, which emits no SDK messages and may take the full `startupTimeoutSec` (90s), i.e. longer than the inactivity budget it would otherwise be judged against. The absolute ceiling still applies.

The suspension carries **its own expiry** rather than trusting the code that set it to clear it. Everything it covers is a teardown/startup path that can itself hang: `stop()` interrupts the CLI child, and the one case that most needs interrupting — a child wedged on a near-full session — is the one least likely to answer, so a `finally` is not a guarantee. A leaked suspension would disable the inactivity deadline permanently and leave the service with only a ceiling that never clears a session, so nothing would ever recover. For the same reason the interrupt itself is bounded by `[mainAgent.claude].interruptTimeoutSec` (default 10) before the query is closed anyway; disposal then proceeds normally, so the following `start()` gets a clean slate. The suspension budget is `(interruptTimeoutSec + startupTimeoutSec) x 2` — twice the worst legitimate restart — so it can never expire part-way through a restart that is still making progress.

**The session survives the abort by default.** Clearing the persisted session throws away the entire conversation and tells the user to resend into the same ceiling. It now happens only against evidence that the *session*, not the turn, is the problem:

- context occupancy at or above `contextRolloverInputTokens`, or a rollover already armed — the 2026-08-07 signature, where a session near the end of its window stops responding with no error at all; or
- `[service].turnSilentAbortsBeforeSessionReset` (default 2) consecutive aborts of turns that produced **zero** events. One silent abort can be a slow tool; a run of them means nothing is reaching the session any more; or
- `[service].turnRunawayAbortsBeforeSessionReset` (default 2) consecutive `absolute` (runaway) aborts. One runaway turn is a turn that went too long, but a runaway abort does not clear a session on its own, so without escalation a looping session is an unbreakable abort cycle. It is a separate key from the silent one because it is different evidence about a different failure; or
- `turnSilentAbortsBeforeSessionReset + turnRunawayAbortsBeforeSessionReset` (default 4) consecutive aborts of **any** kind with no completed turn between them. The two counters above reset each other, so an alternating silent/runaway sequence would otherwise ping-pong forever with neither reaching its bound. This backstop is what makes recovery terminate for every mixed sequence.

All three counters reset when any turn completes normally, and are **scoped to the provider + session id** they were gathered against (`contextStats().sessionId`; an id that was merely not known yet — fresh sessions are captured lazily on their first turn — is adopted rather than treated as a session change): evidence is about one conversation and must never carry over to the session that replaces it, whether that came from a rollover, a clear, a provider switch or a restart. A runaway abort of a turn that was demonstrably active also resets the silent counter — otherwise silent → runaway → silent added up to a reset on the strength of two non-consecutive silences.

A single `absolute` abort never clears the session: the turn was busy, so the session is fine. `turn_force_abort` carries `sessionCleared` and `sessionClearReason` alongside the evidence (`activityEvents`, `inactiveMs`, `consecutiveSilentAborts`, `lastTurnInputTokens`, `contextWindowTokens`), and a preserved session additionally logs `watchdog_kept_main_session`. The user notice says which happened — context kept, or context reset.

**Codex (reports no liveness) — unchanged.** The Codex provider implements no `turnWatchdogState()`, so it keeps the historical wall-clock abort at `TURN_ABORT_MS` (80s), the original "timed out after 80 seconds" notice, and the unconditional session clear. Its transport already fails in-flight `sendTurn` iterators when the WebSocket dies, so it does not have the silent-hang failure mode this replaces.

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
