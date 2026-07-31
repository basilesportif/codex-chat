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

You can instead set `CODEX_CHAT_MAIN_PROVIDER=claude_agent_sdk`. Model, effort, permission mode, tool lists, executable path, session name, and startup timeout live under `[mainAgent.claude]`; the model accepts either an alias or a full model ID. Environment overrides are listed in `.env.example`. Configuration changes take effect after restart unless a persisted runtime provider override is active.

## Runtime behavior

Everything downstream of main-agent final text carries over unchanged: Telegram and Slack channels, directive parsing and execution, codex-chat-managed subagents, loops, monitors, and capability enforcement. Streaming text deltas and status events use the same `MainAgentClient` event contract as Codex, and the SDK result message terminates exactly one main turn.

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
