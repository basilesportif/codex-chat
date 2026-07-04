# codex-chat — Repo Map & Subagent Backend Selection (guiding notes)

Written for a high-powered model that will diagnose/fix "dynamically call the Claude SDK as a sub-agent."
Repo: `/home/tim/pkg/tim/codex-chat`. Runtime: TypeScript ESM, Node ≥24 / Bun, built with `tsc` to `dist/`, tests via `vitest`.

The independently-supplied diagnosis is **correct**: backend selection is currently **global/runtime-wide**, with **no per-dispatch backend field** anywhere in the chain (directive schema → dispatch input → job creation). The evidence and exact anchor points are below.

---

## 1. What this service is

An internal multi-surface Codex/agent runtime. A single long-lived "main loop" (Codex) receives messages from Telegram/Slack and responds by emitting **directives** (JSON actions). One directive type, `dispatch_subagent`, spins up a child agent to do routed work (research, code, review, etc.). Loops, monitors, and "employees" can also dispatch subagents.

Key runtime pieces:
- `src/main.ts` — CLI entry (commander): `start`, `health`, etc.
- `src/service.ts` — the spine. Ingests user events, runs the main loop, parses/executes directives, exposes the `agent ...` control commands. ~2600+ lines.
- `src/directives.ts` — **zod schemas** for every directive action the main loop may emit. This is the contract the model must satisfy.
- `src/subagents.ts` — `SubagentManager`: queue, concurrency drain, job lifecycle, cancel/steer, **and backend selection**.
- `src/subagent-backends.ts` — the three concrete backends implementing a common `ChildAgentBackend` interface.
- `src/config.ts` — zod-validated `AppConfig`, env overrides, defaults.
- `src/state.ts` — persistence (jobs, runtime backend override, telegram users…).
- `src/types.ts` — shared types incl. `SubagentBackendKind` and `SubagentJob`.
- `behavior/AGENTS.md` — the **prompt/policy doc** that teaches the main-loop model when/how to emit directives (including the current Claude-routing rules).
- `docs/claude-agent-sdk-subagents.md` — operator doc for the Claude backend.

## 2. The three backends (`src/subagent-backends.ts`)

All implement `ChildAgentBackend` (start / steer / interrupt / kill / shutdown). `SubagentBackendKind = "codex_exec" | "codex_app_server" | "claude_agent_sdk"` (`src/types.ts:142`).

- **`CodexExecChildAgentBackend`** (`:152`) — spawns `codex exec --json ...`. One-shot, **not steerable** (`steer()` throws, `:214`). Default/safe backend.
- **`CodexAppServerChildAgentBackend`** (`:259`) — spawns `codex app-server`, talks JSON-RPC over a local WebSocket. Steerable via `turn/steer`. Session class `ChildAppServerSession` (`:777`).
- **`ClaudeAgentSdkChildAgentBackend`** (`:304`) — uses `@anthropic-ai/claude-agent-sdk` `query()` in-process. Session class `ClaudeAgentSdkSession` (`:358`). OAuth-only (rejects non-first-party / non-oauth in `verifyOAuthInitialization` `:564` and on `system:init` `:637`). Steerable by pushing to an async user-message queue (`AsyncUserMessageQueue`, `:91`). Honors `[subagents.claude]` config (enabled, permissionMode, allowedTools, maxTurns, fastMode…). Requires `[subagents.claude].enabled=true` or it throws in `checkReadiness` (`:480`).

All three are **instantiated up front** in the `SubagentManager` constructor and held in a `Record<SubagentBackendKind, ChildAgentBackend>` (`src/subagents.ts:196`). So all backends already exist at runtime simultaneously — the only thing missing is a way to *pick* one per job.

## 3. How a backend gets selected today (the actual bug surface)

Selection is entirely **global**, resolved from config + a single runtime override:

- `configuredBackend()` → `config.subagents.backend` (default `"codex_exec"`, `config.ts:220/400`).
- `backendOverride` — one nullable field on the manager (`subagents.ts:179`), persisted in state (`state.ts:292/299`), set/cleared by the admin Telegram command `agent backend {exec|app-server|claude|config}` (`service.ts:202` parse, `:2619` apply).
- `effectiveBackend() = backendOverride ?? configuredBackend()` (`subagents.ts:980`).

Every job's backend is stamped from that global value, in **two** places, with **no input override**:
- `dispatch()` sets `backend: this.effectiveBackend()` on the queued job (`subagents.ts:285`).
- `startJob()` computes `backendKind = this.backendForJob(id)` = `existing ?? effectiveBackend()` (`subagents.ts:665`, `:984`).

**Where the per-dispatch routing is missing (fix these):**
1. **`src/directives.ts:39` `dispatchSubagentAction`** — has `profile, prompt, route, model, effort, serviceTier, codexProfile, modelProvider, serviceTierMode, images…` but **no `backend` field**. The model literally cannot express "use Claude for this one job."
2. **`src/subagents.ts:36` `DispatchInput`** — no `backend` field.
3. **`src/subagents.ts:203` `dispatchFromDirective`** — maps directive→DispatchInput; would need to forward `action.backend`.
4. **`dispatch()` (`:285`) and `startJob()`/`backendForJob()` (`:665/:984`)** — must prefer a per-input backend over `effectiveBackend()` when present (fall back to global default when absent).
5. **`behavior/AGENTS.md:292`** — currently tells the model that Claude may be used only "when Tim explicitly asks … **or the service/backend status already indicates `claude_agent_sdk`**." I.e. today the only path to Claude is flipping the **global** override first. This is exactly the "false canary" from the diagnosis: the job ran on Codex because the global backend was still Codex. New routing rules go here.

## 4. Job lifecycle (context for steering/validation changes)

`dispatch()` → queue → `drain()` (concurrency-capped, serialized by `draining` flag, `:608`) → `startJob()` (`:634`): assembles prompt (profile + safety rules + task + context), resolves model spec, picks backend, calls `backend.start(input)`, tracks a `RunningJob` (job + child + backend + timeout).

- `SubagentJob.backend` is **already persisted per job** (`types.ts:332`) and read back for steering: `steerJob()` uses `this.backends[job.backend ?? effectiveBackend()]` (`subagents.ts:548`). So **steering already routes to the job's recorded backend** — once dispatch records the right per-job backend, steering follows automatically (diagnosis item 5 is largely satisfied by existing code; just needs the correct value written at dispatch).
- Steerability gate: `isJobCurrentlySteerable()` requires backend ∈ {app_server, claude} + active turn + live child (`:887`). Claude sets `activeTurnId = CLAUDE_SYNTHETIC_ACTIVE_TURN_ID` while its stream is live (`:408/:645`), cleared on settle — so "steer Claude only when SDK stream is live" is already enforced.
- Result delivery: `finishJob()` → `formatTerminalResult()` → `deliverTerminalResult()` routes to main/user/employee/admins by `resultTarget`.

## 5. Model/provider validation is backend-blind today (diagnosis item 4)

`resolveSubagentModelSpec()` (`:952`) + `assertProviderOverrideAllowed()` (`:971`) validate `codexProfile`/`modelProvider` against Codex/OpenRouter allowlists and compute `serviceTierMode`. There is **no branch on backend**. For a Claude-routed job:
- `serviceTier` is Codex-only; Claude ignores it (the SDK session already logs `serviceTierIgnored: true`, `:393`) — but validation still runs Codex-shaped.
- Claude model slugs (`claude-opus-4-8`, `claude-fable-5`, aliases `opus`/`fable`…) should be accepted without Codex provider-override machinery. `service.ts` also has `sanitizeSubagentProviderOverride` (`:1757`) which strips provider fields unless the origin explicitly requested them — check this doesn't clobber a Claude directive.

Make validation **backend-aware**: when `backend === "claude_agent_sdk"`, accept Claude model slugs, skip/relax Codex provider validation, and treat `serviceTier` as record-only.

## 6. The `agent backend` control surface (keep as default-only)

`parseSubagentBackendCommand` (`service.ts:202`) + `handleSubagentBackendCommandEvent` (`:2602`), admin-gated. This sets the **global** override and re-stamps queued (not running) jobs (`setBackendOverride`, `subagents.ts:372`). Per the diagnosis, keep this for canary/recovery, but it should no longer be *required* for a targeted Claude job once per-dispatch routing exists.

## 7. Tests to extend (diagnosis item 6)

- `src/__tests__/subagents.test.ts` — manager-level dispatch/queue/cancel/steer with fake backends. Best home for "one Codex job + one Claude job coexist," "a Claude-requested directive yields `backend=claude_agent_sdk` without flipping the global default," and "steer routes to the job's backend."
- `src/__tests__/subagent-backends.test.ts` — backend-level (spawns/fakes app-server WS; has a `config.subagents.backend = "claude_agent_sdk"` path at `:120`).
- `src/__tests__/directives.test.ts` — add coverage that the schema accepts/round-trips an optional `backend` field.

## 8. Suggested change surface (minimal, matches diagnosis)

1. `directives.ts`: add optional `backend: z.enum([...]).optional()` (consider friendly aliases like `claude`/`exec`/`app-server` normalized internally) to `dispatchSubagentAction`.
2. `subagents.ts`: add `backend?` to `DispatchInput`; forward it in `dispatchFromDirective`; in `dispatch()` and `startJob()`/`backendForJob()`, use `input.backend ?? effectiveBackend()` (global stays the default).
3. `subagents.ts`: make `resolveSubagentModelSpec`/validation branch on the resolved backend (Claude accepts Claude slugs; serviceTier record-only for Claude).
4. `behavior/AGENTS.md`: change the routing rules so "use Claude / Claude SDK / Claude Code / Opus / Fable" emits `dispatch_subagent` **with `backend: "claude_agent_sdk"`** for that one job, no global flip. Default remains Codex.
5. Tests per §7.

### Fast pointer table

| Concern | File:line |
|---|---|
| Backend kinds | `src/types.ts:142` |
| Directive schema (no `backend`) | `src/directives.ts:39` |
| DispatchInput (no `backend`) | `src/subagents.ts:36` |
| directive→dispatch mapping | `src/subagents.ts:203` |
| global backend resolution | `src/subagents.ts:976`–`987` |
| backend stamped on job (dispatch) | `src/subagents.ts:285` |
| backend stamped on job (start) | `src/subagents.ts:665` |
| steer routes to job.backend | `src/subagents.ts:548` |
| model/provider validation (backend-blind) | `src/subagents.ts:952`,`:971` |
| provider-override sanitize | `src/service.ts:1757` |
| `agent backend` command | `src/service.ts:202`,`:2602` |
| main-loop Claude routing policy | `behavior/AGENTS.md:292` |
| Claude backend impl | `src/subagent-backends.ts:304`,`:358` |
