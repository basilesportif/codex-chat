# Claude Agent SDK Subagent Parity Plan

Status: implementation plan for adding an opt-in Claude Agent SDK subagent backend to codex-chat while preserving existing Codex subagent backends and rollback behavior.

## Goals

- Add an additive backend kind, tentatively `claude_agent_sdk`, alongside `codex_exec` and `codex_app_server`.
- Keep `codex_exec` as the safe rollback backend and keep `codex_app_server` behavior unchanged.
- Use Claude subscription OAuth only. Do not use `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, Bedrock, Vertex, Foundry, or gateway bearer-token auth for this backend.
- Prefer the official TypeScript `@anthropic-ai/claude-agent-sdk` and its streaming-input query mode.
- Mark Claude-backed jobs steerable only when a running SDK query can accept additional input/interrupt control in the current process.
- Preserve codex-chat subagent artifacts: `prompt.md`, `events.jsonl`, `stderr.log` when present, and `last-message.md`.

## Current architecture to preserve

- `src/types.ts` defines `SubagentBackendKind`, `SubagentJob`, model/effort/tier fields, transport metadata, and steering counters.
- `src/config.ts` parses `[subagents]` backend/defaults and `CODEX_CHAT_SUBAGENTS_*` env overrides.
- `src/directives.ts` keeps the `dispatch_subagent`, `cancel_job`, and `steer_subagent` action schemas.
- `src/subagents.ts` owns queueing, job persistence, prompt assembly, artifact paths, runtime backend override, cancellation, steering authorization, result routing, and artifact cleanup.
- `src/subagent-backends.ts` owns concrete child backends. `codex_exec` is one-shot/non-steerable; `codex_app_server` is WebSocket/session backed and steerable through `turn/steer`.
- `src/env.ts` strips generic child-process secrets and only allowlists provider API keys for Codex children.
- `src/service.ts` exposes Telegram/admin commands such as `agent backend exec|app-server|config`, `agent status`, `agent kill`, and `agent steer`.

## Backend selection and rollback

1. Extend `SubagentBackendKind` and config schema to accept `claude_agent_sdk`.
2. Instantiate `ClaudeAgentSdkChildAgentBackend` in `SubagentManager` without changing the default backend.
3. Update runtime override parsing so admins can run:
   - `agent backend claude` or `agent backend claude-agent-sdk` to opt new/queued jobs into Claude.
   - `agent backend exec` to force rollback to `codex_exec` exactly as today.
   - `agent backend config` to clear the override.
4. Update backend normalization so unknown or stale state remains safe by falling back to `codex_exec`, while known `claude_agent_sdk` values round-trip.
5. Keep running jobs unchanged by backend switch commands.

## OAuth-only authentication and readiness

- Add Claude-specific config under `[subagents.claude]` rather than overloading Codex provider settings:
  - `enabled = false` as an explicit readiness guard.
  - `pathToClaudeCodeExecutable = ""` optional override for the SDK.
  - `requireOAuth = true` fixed/defaulted behavior.
  - `allowDangerouslySkipPermissions = true` only if we intentionally map codex-chat `approvalPolicy = "never"` to SDK `permissionMode = "bypassPermissions"`.
  - `allowedTools`/`disallowedTools` defaults that match subagent expectations without silently widening later.
- Readiness checks should pass only when:
  - Claude backend is enabled; and
  - either `CLAUDE_CODE_OAUTH_TOKEN` is present or local Claude Code OAuth credentials are likely present in the configured Claude config dir / home credentials path; and
  - no disallowed API-key credential env vars are visible to the Claude subprocess.
- Explicitly reject/strip these for the Claude backend: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, provider API-key variables, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, and `apiKeyHelper`-style auth surface when available through settings.
- Add `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`, and Claude credential filenames to secret redaction/child-env docs. Never print token values; readiness output only says present/missing and path metadata.
- Document setup with `claude auth login` for local subscription credentials or `claude setup-token` for a long-lived subscription OAuth token.

## Model, effort, and tier translation

- `model`: pass through to SDK `options.model` when non-empty. Let the SDK/Claude fail with a useful `model_not_found` event if invalid; do not translate OpenAI model names.
- `effort`:
  - `low`, `medium`, `high`, `xhigh` pass to SDK `options.effort`.
  - `none` and `minimal` intentionally map to `thinking: { type: "disabled" }` and omit `effort`, unless the SDK later exposes a lower valid effort.
  - Unknown values fail before launch rather than silently changing reasoning.
- `serviceTier`: Claude Agent SDK has no Codex-style `fast|standard` service tier. Record `serviceTier`/`serviceTierMode` in the launch event and docs, but do not pretend it controls Claude.
- Fast mode: when Tim requests fast mode for Claude, set a Claude fast-mode setting/env only through documented Claude Code controls if available. If unsupported by the installed SDK/CLI, record a warning event and continue without claiming fast mode.

## Streaming steering design

1. Use SDK streaming input mode: `query({ prompt: AsyncIterable<SDKUserMessage>, options })`.
2. Start each subagent with the assembled prompt as the first yielded user message.
3. Keep a per-job in-memory async input queue. `steer(jobId, text)` enqueues another `SDKUserMessage` while the query is still alive.
4. Use `Query.interrupt()` for graceful interruption/cancellation when a turn is active. If interrupt fails or the SDK process stalls, fall back to `Query.close()` and then process cleanup.
5. Mark a Claude job `steerable=true` only when:
   - the backend is `claude_agent_sdk`;
   - the query object exists;
   - the input queue is open;
   - the job is running; and
   - the query process has not finished/closed.
6. Because SDK streaming input does not expose Codex `turnId`, set `backendThreadId` to the SDK session id from `system:init` and set `activeTurnId` to a local synthetic marker such as `claude-sdk-stream` only while the query is accepting input.
7. Persist `lastSteeredAt` and `steerCount` through the existing `SubagentManager.steerJob()` path.

## Events and artifacts

- Keep `prompt.md` exactly as assembled by `SubagentManager`.
- Write every SDK message to `events.jsonl` with a wrapper that includes `event`, `at`, `backend`, and the raw SDK message where safe.
- Accumulate assistant text from `assistant.message.content[]` text blocks and optionally `stream_event` text deltas when `includePartialMessages` is enabled.
- Write final successful `result.result` or accumulated assistant text to `last-message.md`.
- Write SDK stderr through the SDK `stderr` callback into `stderr.log`.
- Write auth/readiness failures as structured launch/error events without secret values.

## Cancellation, shutdown, and cleanup

- `interrupt(jobId, reason)` calls `Query.interrupt()` first for Claude jobs, then closes if needed.
- `kill(jobId)` calls `Query.close()` and closes the input queue. If a custom spawn wrapper is added later, also kill the spawned process tree.
- `shutdown()` interrupts/closes all active Claude sessions.
- Preserve current timeout behavior in `SubagentManager`; terminal status mapping remains `completed`, `failed`, `cancelled`, or `timed_out` based on `ChildAgentFinish`.

## Config, docs, and commands

- Update `config/codex-chat.example.toml` with a commented Claude backend example and OAuth-only notes.
- Update README subagent backend docs with:
  - backend choices;
  - `agent backend claude` opt-in;
  - OAuth setup;
  - API-key rejection;
  - model/effort/tier caveats;
  - rollback command.
- Keep the existing directive schema unchanged: backend choice remains config/runtime policy, not a per-directive field.

## Tests

- Config tests:
  - schema accepts `claude_agent_sdk` from TOML and env;
  - Claude config defaults are safe and disabled;
  - invalid backend values still fail validation.
- Env tests:
  - generic child env strips Anthropic/Claude secrets;
  - Claude env sanitizer allows only OAuth token envs and strips API-key/provider envs.
- Subagent manager tests:
  - backend normalization/status/rollback includes `claude_agent_sdk`;
  - active snapshot and single status mark Claude jobs steerable only while synthetic active-turn state is present and child is alive;
  - unsupported steering text mentions only non-steerable backends accurately.
- Backend unit tests with mocked `@anthropic-ai/claude-agent-sdk`:
  - start writes init/result/events/last-message;
  - steer enqueues a follow-up SDK user message;
  - interrupt calls SDK `interrupt()` and close fallback;
  - `ANTHROPIC_API_KEY` is not inherited even if present in parent env;
  - missing OAuth readiness fails before query start.
- Build with `pnpm build` and run focused Vitest suites. CI must not require real Claude credentials.

## Rollout and rollback

1. Ship disabled-by-default code and docs.
2. Verify in CI using mocks only.
3. On Tim's host, configure OAuth (`claude auth login` or `CLAUDE_CODE_OAUTH_TOKEN`) and set `[subagents.claude].enabled = true`.
4. Canary with `agent backend claude` for one low-risk job.
5. Roll back instantly with `agent backend exec`; running Claude jobs can be cancelled with `agent kill <ref>`.
6. Keep `codex_exec` and `codex_app_server` operational throughout.

## Risks and open questions

- Official Agent SDK API and auth behavior can change; pin dependency versions through `pnpm-lock.yaml` and keep tests around the mocked API shape.
- Subscription OAuth is intended for Tim/internal use; do not expose it as a multi-user third-party login flow.
- Claude fast mode is model/account dependent and not equivalent to Codex `serviceTier`. The backend must not claim service-tier control unless the SDK exposes a stable setting.
- SDK streaming input supports enqueueing and interruption, but it is not identical to Codex app-server `turn/steer`; steering is implemented as a follow-up user message in the same long-lived SDK session.
- Local Claude credentials live outside this repo; readiness checks must avoid reading or logging secret contents.
