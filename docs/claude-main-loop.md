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

You can instead set `CODEX_CHAT_MAIN_PROVIDER=claude_agent_sdk`. Model, effort, permission mode, tool lists, executable path, session name, startup timeout, and the nested-agent hold windows (`nestedAgentSettleGraceMs`, `nestedAgentHoldMaxMs`) live under `[mainAgent.claude]`; the model accepts either an alias or a full model ID. Environment overrides are listed in `.env.example`. Configuration changes take effect after restart unless a persisted runtime provider override is active.

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
