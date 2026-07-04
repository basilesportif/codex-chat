# Per-Dispatch Subagent Backend Routing Plan

Status: implementation plan for adding optional per-job backend selection to `dispatch_subagent`, so a single directive can target `claude_agent_sdk` (or any backend) without flipping the global runtime override. Based on `CODEX_CHAT_SUBAGENT_BACKEND_MAP.md` and the external diagnosis it verified.

## Problem

Backend selection is global-only: `effectiveBackend() = backendOverride ?? config.subagents.backend` (`src/subagents.ts:980`), stamped onto every job in `dispatch()` (`:285`) and `startJob()`/`backendForJob()` (`:665`, `:984`). The `dispatch_subagent` directive schema (`src/directives.ts:39`), `DispatchInput` (`src/subagents.ts:36`), and the directive→dispatch mapping (`:203`) have no `backend` field, so the main loop cannot request Claude for one job. `behavior/AGENTS.md:292` accordingly gates Claude on the global status — the root cause of the false canary (a "use Claude SDK" request ran on Codex because the global default was still `codex_exec`).

## Design decisions

- Per-dispatch `backend` is **optional**. Absent → current behavior (global effective backend). Present → that job only; the global override and queued-job re-stamping semantics of `agent backend ...` are unchanged except that explicitly-routed queued jobs keep their explicit backend.
- Directive accepts canonical kinds plus friendly aliases, normalized at the schema layer: `claude`, `claude_code`, `claude-agent-sdk` → `claude_agent_sdk`; `exec` → `codex_exec`; `app-server`, `app_server` → `codex_app_server`. Canonical value is what lands in `DispatchInput`/`SubagentJob`.
- Invalid backend values fail zod validation loudly (directive error back to the main loop) rather than silently normalizing to `codex_exec`. `normalizeBackend()`'s silent fallback stays only for stale persisted state.
- Validation becomes backend-aware but minimal: Claude jobs skip Codex provider-override machinery; model slugs pass through (SDK errors are already surfaced); `serviceTier` stays record-only for Claude (the session already logs `serviceTierIgnored: true`).

## Implementation phases

- [x] Phase 1 — Directive schema + DispatchInput plumbing.
- [x] Phase 2 — Backend-aware validation/sanitization.
- [x] Phase 3 — Main-loop routing rules in `behavior/AGENTS.md`.
- [x] Phase 4 — Tests for mixed-backend dispatch.
- [x] Phase 5 — Docs (README, `docs/claude-agent-sdk-subagents.md`) + example config.

### Phase 1 — Schema and plumbing

1. `src/directives.ts`: add to `dispatchSubagentAction`:
   ```ts
   backend: z.enum(["codex_exec", "codex_app_server", "claude_agent_sdk",
                    "exec", "app-server", "app_server", "claude", "claude_code", "claude-agent-sdk"])
     .transform(normalizeBackendAlias).optional()
   ```
   with a small exported `normalizeBackendAlias()` (also usable by tests/service).
2. `src/subagents.ts`:
   - `DispatchInput` (`:36`): add `backend?: SubagentBackendKind`.
   - `dispatchFromDirective` (`:203`): forward `backend: action.backend`.
   - `dispatch()` (`:285`): `backend: input.backend ?? this.effectiveBackend()`.
   - `backendForJob(id)` (`:984`): unchanged in shape — it already prefers the queued job's recorded backend, which now carries the explicit choice. Verify `startJob()`'s fallback path (job missing from map) also consults `input.backend`.
   - `setBackendOverride()` (`:372`) re-stamps queued jobs: skip jobs whose backend was explicitly requested. Track this with a new optional `SubagentJob.backendExplicit?: boolean` (`src/types.ts` near `:332`), set when `input.backend` is present. Persisted so it survives restarts alongside the job record.
3. Steering/cancel need no changes: `steerJob()` (`:548`), `isJobCurrentlySteerable()` (`:887`), and `cancelGraceMs()` (`:994`) already key off `job.backend`.

### Phase 2 — Backend-aware validation

1. `src/subagents.ts` `resolveSubagentModelSpec()` (`:952`): accept the resolved backend as a parameter. When `claude_agent_sdk`:
   - Do not apply `defaultCodexProfile`/`defaultModelProvider` fallbacks; reject explicit `codexProfile`/`modelProvider` on a Claude-routed dispatch with a clear error (they are Codex-only concepts).
   - `serviceTierMode`: resolve to `"omit"` so no Codex tier flags leak into observability as if applied. Claude fast-mode mapping (`shouldApplyFastMode`, `subagent-backends.ts:553`) currently requires `serviceTierMode !== "omit"` — adjust it to treat Claude fast mode as driven by `serviceTier === "fast"` + `[subagents.claude].fastMode` only, or keep `"auto"` for Claude and document; pick one and test it.
   - Model/effort pass through; effort mapping already validated in `claudeEffortAndThinking()` (`subagent-backends.ts:558`).
2. `src/service.ts` `sanitizeSubagentProviderOverride` (`:1757` call site): must not strip or veto a directive's `backend` field, and must not treat `backend: "claude_agent_sdk"` as a "provider override" requiring the origin's explicit-provider gate — backend routing is authorized by the directive itself. Add the backend to the dispatch summary line (`formatDispatchSummary`) so Telegram status shows `backend=claude_agent_sdk` when non-default.
3. Keep the readiness failure path as-is: a Claude-routed job with `[subagents.claude].enabled=false` or missing OAuth fails at `checkReadiness()` (`subagent-backends.ts:459`) and the error is delivered via the normal failed-job result — no new pre-dispatch gating needed, but confirm the error text reaches the origin chat.

### Phase 3 — Main-loop routing rules

`behavior/AGENTS.md` (~`:292`):
- Replace "use Claude only when Tim explicitly asks or the backend status already indicates claude_agent_sdk" with: when Tim says "use Claude", "Claude SDK", "Claude Code", "Opus", "Fable", "Sonnet", "Haiku", or names a Claude model, include `backend: "claude_agent_sdk"` in that `dispatch_subagent` directive. Do not flip the runtime backend.
- For Claude-backed dispatches: omit `codexProfile`/`modelProvider`/`serviceTierMode`; set `model` to a full Claude ID (`claude-opus-4-8`, `claude-fable-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`); effort `low|medium|high|xhigh`.
- Note `agent backend claude` remains an admin canary/default-flip, not the routing mechanism.
- Update the directive field list (~`:402`) to mention optional `backend`.

### Phase 4 — Tests

- `src/__tests__/directives.test.ts`: schema accepts canonical + alias backend values and normalizes; rejects garbage.
- `src/__tests__/subagents.test.ts` (fake backends):
  - Directive with `backend: "claude_agent_sdk"` creates a job with that backend while `backendStatus().effective` remains `codex_exec`.
  - Mixed batch: one Codex job + one Claude job run concurrently, each `start()` hitting its own fake backend.
  - `steerJob` routes to the fake Claude backend for the Claude job and returns `unsupported_backend` for the exec job.
  - `setBackendOverride` re-stamps a queued default-backend job but leaves a queued explicitly-routed job untouched.
  - Claude-routed dispatch with `codexProfile`/`modelProvider` set → rejected with clear error.
- `src/__tests__/service.test.ts` (or wherever sanitize is covered): `sanitizeSubagentProviderOverride` passes `backend` through untouched.

### Phase 5 — Docs and config

- `README.md` backend section (~`:190`): document per-dispatch `backend`, global default demoted to "default only".
- `docs/claude-agent-sdk-subagents.md`: add the per-dispatch path as the primary way to run a Claude job; runtime override stays for canary/recovery.
- `config/codex-chat.example.toml`: comment noting `subagents.backend` is the default, overridable per dispatch.

## Coordination note

The working tree currently has uncommitted OAuth-verification fixes in `src/subagent-backends.ts` + tests/docs. This plan does not touch those hunks except `shouldApplyFastMode` (Phase 2.1) — rebase/land the OAuth fixes first or keep edits disjoint.

## Rollout / rollback

- Purely additive: no config migration; absent `backend` keeps today's behavior byte-for-byte.
- Rollback = revert the AGENTS.md routing rule (main loop stops emitting `backend`); runtime behavior then matches current global-only selection. `agent backend exec` remains the hard recovery path.
- Validate post-deploy with one canary: "use Claude SDK to summarize X" → job record shows `backend=claude_agent_sdk`, `events.jsonl` has `claude_launch_config`, and `agent backend` still reports `effective: codex_exec`.
