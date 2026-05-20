# Steerable Subagents and Durable Employees Plan

Date: 2026-05-19

## Scope

This plan covers Tim's proposed codex-chat architecture upgrade:

1. Replace one-shot child `codex exec` subagents with steerable child `codex app-server` workers.
2. Keep current `job_*` IDs and the existing Telegram/job UI.
3. Add steering first, from Telegram initially and then from directives plus IPC/API.
4. Fully outline durable Employees, but defer Employee runtime implementation until steerable child workers are proven.

The previous architecture review summary remains the ordering rule: steerable child `codex app-server` workers first; durable Employees second.

This document is intentionally implementation-oriented. It names the current repo surfaces that should be changed later, but it does not implement any code.

## 2026-05-19 Implementation Note

The steerable-subagents foundation is implemented behind a safe backend flag:

- `subagents.backend = "codex_exec"` remains the production-safe default and preserves existing `codex exec` behavior.
- `subagents.backend = "codex_app_server"` opts new jobs into the minimal app-server child backend.
- A persisted runtime override can be flipped from Telegram by an admin:
  - `agent backend exec` forces new and queued jobs back to `codex_exec`.
  - `agent backend` shows configured, override, and effective backend.
  - `agent backend config` clears the runtime override.
- Steering surfaces are available through:
  - Telegram: `agent steer <ref> <text>` / `subagent steer <ref> <text>`.
  - Directive: `steer_subagent`.
  - IPC: `{ "type": "subagent_steer", "jobId": "job_...", "text": "..." }`.
- Main-loop Codex turns now receive a compact `Active subagent jobs` snapshot
  when queued/running/cancelling jobs exist. It includes short refs, full ids,
  status, profile, backend, steerability, summary, timing, model/effort, and
  Telegram origin ids when available. This enables natural-language steering:
  emit `steer_subagent` only for one matching `steerable=true` job; otherwise
  ask for clarification or point the user to `agent steer <ref> <text>`.

The app-server backend is intentionally opt-in and minimal: one child app-server process per active job over a loopback WebSocket. Employee runtime now exists as a guarded scaffold with central service-owned child-subagent orchestration.

## 2026-05-20 Employee Orchestration Implementation Note

Employee terminology is canonical across code, docs, config, commands, and
user-facing output. Legacy `[factors]` config and `factor ...` command aliases
remain accepted only for backward compatibility.

Implemented architecture:

- `EmployeeManager` owns durable Employee runtime state and Employee turns.
- `SubagentManager` remains the only owner of actual subagent execution.
- Employee runtimes may request child work only by emitting a
  `codex-chat-employee-service` JSON envelope with `request_subagent`,
  `cancel_subagent`, or `steer_subagent`.
- The service validates Employee capabilities, dispatches child jobs through
  `SubagentManager`, and records owner metadata: `ownerType=employee`,
  `ownerId=<employee-id>`, `ownerRequestId`, `parentTurnId`, and
  `resultTarget=employee`.
- Employees can cancel/steer only child jobs they own unless an admin/main
  service path explicitly intervenes.
- Terminal child results route back to the owning Employee as a new Employee
  turn. If the Employee runtime is stopped, not resumable, or busy, the result
  is stored under state and surfaced in `employee status`.
- Stopping an Employee cascades cancellation to active child jobs it owns with
  reason `employee_stopped`.
- Active subagent snapshots and `agents detail` are owner-aware. Main-loop
  steering guidance says to steer the owning Employee rather than arbitrary
  Employee child jobs unless Tim explicitly asks for that nested child.

## 2026-05-19 Employee Scaffold Implementation Note

The first safe Employee scaffold was implemented without starting durable Employee
runtimes. It has since been extended with the guarded app-server runtime and
centralized child-subagent orchestration described above:

- `[employees]` and `[employees.<id>]` config parse per-Employee directories,
  enabled flags, profile/model/effort, startup mode, warmup prompt/file,
  Git fields, memory/compaction policy placeholders, and capabilities/ACL
  placeholders.
- Runtime/proposal state is stored under `data/state/employees/<id>.json`; Employee
  content remains in each configured Employee directory (`data/employees/<id>` by
  default, or an absolute path).
- Service, Telegram, and CLI management surfaces can list/status and now
  start/resume/stop/steer when enabled; they fall back to proposal recording
  when no runtime client is attached. They still do not call external accounts.
- The email/calendar example stays disabled and scaffold-only. No email,
  calendar, project, todo, CRM, Git push, or canonical assistant workspace
  mutation is implemented by this pass.

This preserves rollback: leave `employees.enabled = false` (the default) or set it
back to false before restart. The existing `codex_exec`/`codex_app_server`
subagent backend flag is unchanged.

## Current Architecture Mapping

The current system already has the public product shape needed for this migration:

- `dispatch_subagent` directive: defined in `src/directives.ts`, executed in `ServiceSupervisor.executeDirective()` in `src/service.ts`, and routed through `SubagentManager.dispatchFromDirective()`.
- Telegram service commands: parsed in `src/service.ts` before a message reaches Codex. Existing commands include `agents`, `subagents`, `agent kill <ref>`, `logs`, `help`, and deploy commands.
- Existing subagent manager: `src/subagents.ts` owns queueing, `job_*` ID creation, `SubagentJob` persistence, `codex exec` process spawning, cancellation, artifact cleanup, and terminal result routing.
- Current child backend: `SubagentManager.startJob()` assembles a profile prompt, writes `prompt.md`, starts `codex exec --json --output-last-message`, records stdout to `events.jsonl`, stderr to `stderr.log`, and reads `last-message.md` on exit.
- Main app-server client: `src/codex.ts` starts the top-level `codex app-server` over WebSocket, sends `initialize`, manages `thread/start` and `turn/start`, streams deltas, tracks the top-level thread in `data/state/codex_sessions.json`, and has crash/restart handling.
- Config/TOML: `src/config.ts` and `config/codex-chat.example.toml` expose `[subagents]` controls such as `enabled`, `maxConcurrent`, `defaultModel`, `defaultEffort`, timeouts, `artifactDir`, profile allowlist, and artifact cleanup.
- IPC: `src/ipc.ts` currently supports `loop_run` and `ping` over a local Unix socket. The loop runner uses `sendIpcMessage()` from `src/loops.ts`.
- Job records: `src/types.ts` defines `SubagentJob`; `src/state.ts` persists jobs as `data/state/jobs/<jobId>.json`.
- Restart behavior: `SubagentManager.loadJobs()` marks active persisted jobs as `abandoned` on service startup because current `codex exec` children are not safely recoverable. `ServiceSupervisor.restartCodex()` and the watchdog in `src/service.ts` restart only the main Codex app-server.

The migration should preserve these product-level contracts. The main change is to stop letting `SubagentManager` know only about `codex exec` and introduce a child-agent backend boundary.

## Target Shape

Keep `job_*` as the stable user-visible ID. Treat `childId` in lower-level design as the same value as `SubagentJob.id` unless a future backend has a strong reason to add a separate backend ID.

Add a backend interface under `src/subagents/` or a nearby module:

```ts
export type ChildAgentBackendKind = "codex_exec" | "codex_app_server";

export interface ChildAgentBackend {
  readonly kind: ChildAgentBackendKind;
  start(job: SubagentJob, input: StartChildAgentInput): Promise<StartedChildAgent>;
  steer(jobId: string, text: string): Promise<void>;
  interrupt(jobId: string, reason?: string): Promise<void>;
  kill(jobId: string, signal?: NodeJS.Signals): Promise<void>;
  shutdown(): Promise<void>;
}
```

The exact TypeScript shape can change during implementation, but these boundaries should hold:

- `SubagentManager` keeps queueing, `job_*` allocation, `resolveJobRef()`, user-facing summaries, persistence, and route delivery.
- `CodexExecChildAgentBackend` preserves existing behavior and returns a clear unsupported-capability error for `steer()`.
- `CodexAppServerChildAgentBackend` owns child process launch, transport connection, JSON-RPC request/notification handling, `threadId`, active `turnId`, `turn/steer`, and `turn/interrupt`.
- Higher-level surfaces call product methods such as `dispatch`, `steer`, `interrupt`, and `cancel`; they should not know socket paths, JSON-RPC IDs, or app-server notification shapes.

Recommended optional additions to `SubagentJob`:

```ts
backend?: "codex_exec" | "codex_app_server";
backendThreadId?: string;
activeTurnId?: string;
socketPath?: string;
transport?: "stdio" | "ws" | "unix";
interruptRequestedAt?: string;
lastSteeredAt?: string;
steerCount?: number;
```

All additions should be optional for backward compatibility with existing persisted jobs.

## Phase 1: Protocol Spike for Child App-Server

Goal: prove the child `codex app-server` control loop outside the production subagent path.

Work:

1. Build a disposable spike or focused test harness that starts one child process with `codex app-server --listen unix://<absolute-socket-path>`.
2. Confirm the Unix socket transport framing. The proposal expects newline-delimited JSON, but the implementation must verify this against the installed Codex version.
3. Perform the app-server handshake:
   - `initialize` with client info like `codex-chat-subagent`.
   - `initialized` if required by the active protocol.
4. Start a thread with the same core constraints as current subagents:
   - `cwd = config.service.workspace`
   - `sandbox = config.codex.sandbox`
   - `approvalPolicy = config.codex.approvalPolicy`
   - model and effort resolved from the current subagent fields
   - profile instructions from `behavior/subagents/<profile>.md`
5. Start a turn with `turn/start` and capture the returned or notified turn ID.
6. While the turn is active, send `turn/steer` with `expectedTurnId`.
7. Confirm that `turn/steer` does not start a second turn and does not change turn-level overrides.
8. Send `turn/interrupt` and confirm terminal notifications and process state.
9. Record the observed request/response and notification shapes in a short note or inline test fixture before implementing the backend.

Acceptance criteria:

- A child app-server can be started on a unique local Unix socket path.
- The client can start a thread, start a turn, receive streamed output, steer the active turn, and interrupt it.
- The spike identifies the source of truth for `activeTurnId`.
- Failure shapes are known for stale `expectedTurnId`, no active turn, interrupted turn, missing thread, and dead socket.

## Phase 2: Introduce ChildAgentBackend While Preserving Exec

Goal: put an abstraction under `SubagentManager` without changing runtime behavior.

Work:

1. Extract the current `codex exec` launch and process bookkeeping from `SubagentManager.startJob()` into `CodexExecChildAgentBackend`.
2. Keep `SubagentManager` responsible for:
   - `job_*` ID creation with `makeId("job")`
   - queue depth and `maxConcurrent`
   - allowed profile validation
   - prompt byte limits
   - artifact directory and `prompt.md` creation
   - status transitions
   - `resolveJobRef()` and short refs
   - terminal result delivery to main, user, admins, or store-only routes
3. Keep current artifact names stable:
   - `prompt.md`
   - `events.jsonl`
   - `stderr.log`
   - `last-message.md`
4. Add manager-level methods:
   - `steerJob(ref, text)`
   - `interruptJob(ref, reason)`
   - `requestCancel(ref, options)` continues to exist and delegates through the backend.
5. Keep `CodexExecChildAgentBackend.steer()` explicit and non-silent:
   - "Subagent <jobId> was launched with backend=codex_exec and is not steerable."
6. Update unit tests around `SubagentManager` and service commands so the default behavior is still current `codex exec`.

Acceptance criteria:

- Existing subagent tests pass with the exec backend.
- Persisted job JSON remains readable.
- `agent kill <ref>` behavior is unchanged for exec jobs.
- No app-server child process is used until the config flag in Phase 3 is enabled.

## Phase 3: Add App-Server Child Backend Behind Config Flag

Goal: ship the child app-server backend as an opt-in path.

Config proposal:

```toml
[subagents]
backend = "codex_exec" # "codex_exec" or "codex_app_server"; flip default in Phase 6
childSocketDir = "data/run/subagents"
childStartupTimeoutSec = 60
childInterruptGraceMs = 5000
```

Work:

1. Extend `src/config.ts` and `config/codex-chat.example.toml` with opt-in child backend settings.
2. Implement `CodexAppServerChildAgentBackend` using the Phase 1 protocol results.
3. Use one app-server process per active ephemeral subagent job for the first implementation. Do not pool child processes until steering semantics are stable.
4. Put child sockets under a predictable local directory, preferably `data/run/subagents/<jobId>.sock`, and remove them on terminal cleanup.
5. Assemble child instructions with the same content currently sent to `codex exec`:
   - profile contents
   - remote repo authority rules
   - task text
   - workspace
   - artifact directory
   - output contract
6. Prefer the following app-server split unless the protocol spike shows a better shape:
   - thread-level instructions: profile, repo authority rules, output contract, and stable subagent behavior
   - turn input: the concrete task, workspace, artifact directory, images/attachments, and any origin metadata
7. Stream child notifications into existing artifact files:
   - model output deltas and terminal text to `events.jsonl`
   - process stderr/stdout to `stderr.log` or separate `app-server.log`
   - final text to `last-message.md`
8. Update `SubagentJob` with backend metadata while the job is running:
   - `backend = "codex_app_server"`
   - `pid`, `pgid`
   - `socketPath`
   - `backendThreadId`
   - `activeTurnId`
9. Preserve route delivery by making the backend return the same final result string that `SubagentManager.finishJob()` currently formats and delivers.
10. Keep image inputs working if the current exec path uses `--image`; map them to app-server local image input blocks.

Acceptance criteria:

- With `subagents.backend = "codex_app_server"`, a normal `dispatch_subagent` produces a `job_*`, runs to completion, writes artifacts, and returns through the existing route path.
- With `subagents.backend = "codex_exec"`, behavior remains unchanged.
- Failed child app-server startup marks the job failed with a useful error and does not wedge the queue.
- The `agents`/`subagents` UI continues to show the same ID and status style.

## Phase 4: Add Steering Surfaces

Goal: expose top-level steering without changing the `job_*` UI.

Steering is top-level only for this phase. If an Employee or child later spawns its own sub-agent, the top-level user steers the top-level child or Employee. That child or Employee can then decide whether to steer its own nested work.

Telegram first:

1. Add a service-level parser in `src/service.ts`, parallel to `parseAgentKillCommand()`:
   - `agent steer <ref> <text>`
   - `subagent steer <ref> <text>`
   - optional later alias: `agent tell <ref> <text>`
2. Keep parsing before the message reaches Codex.
3. Resolve `<ref>` through existing `SubagentManager.resolveJobRef()`.
4. Call `SubagentManager.steerJob(ref, text)`.
5. Reply with a concise status:
   - success: `Steered subagent job_<id> (<profile>).`
   - not found or ambiguous: reuse the current cancel-ref style.
   - unsupported backend: tell the user the job was launched with `codex_exec`.
   - no active turn: tell the user the job is not currently steerable.

Directive surface:

1. Add a new directive action rather than overloading `dispatch_subagent`:

```json
{
  "type": "steer_subagent",
  "idempotencyKey": "steer-<msgId>-1",
  "jobId": "job_...",
  "text": "New steering text"
}
```

2. Consider `interrupt_subagent` only if `cancel_job` cannot express the desired graceful interrupt semantics. Prefer reusing `cancel_job` after it delegates to `turn/interrupt` for app-server jobs.
3. Document steering in `behavior/directives.md` after implementation so the main Codex loop can steer child jobs when appropriate.

IPC/API path:

1. Extend `IpcMessage` in `src/ipc.ts` with a steering message:

```ts
{ type: "subagent_steer"; jobId: string; text: string }
```

2. Current IPC only returns `{"ok":true}` even when the handler logs an error. For steering, add request/response error reporting or introduce a separate API path before relying on it for automation.
3. Expose a CLI/API caller only after the IPC response semantics can report not found, ambiguous, unsupported backend, and no active turn.

Acceptance criteria:

- A running app-server child can be steered from Telegram.
- The command uses existing job refs and does not create a new job.
- Steering attempts are logged and persisted enough to debug later.
- Directives and IPC/API have clear schemas even if they are implemented after Telegram.

## Phase 5: Reliability and Operations

Goal: make the app-server backend operationally safe enough to become the default.

Active turn tracking:

- Treat `activeTurnId` as valid only between successful `turn/start` and terminal turn notification.
- Send `turn/steer` only with the current `expectedTurnId`.
- Reject steering if the job is queued, terminal, cancelling, or running without an active turn.
- Persist `activeTurnId` updates to the job record, but do not assume persisted active turns can be recovered after a service restart.

Interrupt and kill semantics:

- For app-server jobs, `requestCancel()` should call `turn/interrupt` first.
- If `turn/interrupt` fails or the child does not exit after `childInterruptGraceMs`, send SIGTERM to the child process group.
- If SIGTERM does not exit after the existing SIGKILL grace period, send SIGKILL.
- For exec jobs, keep current SIGTERM then SIGKILL behavior.
- Keep user-facing `agent kill <ref>` text, but internally prefer graceful interrupt for app-server jobs.

Orphan cleanup:

- On service startup, scan `data/run/subagents` for stale sockets and pid files from previous runs.
- Mark persisted active jobs `abandoned` as today unless a future recovery design proves safe.
- Attempt best-effort child process cleanup for known child pids/pgids whose parent service died.
- Do not kill unknown processes based only on a stale socket path.

Restart handling:

- Main app-server restart should not silently lose child job state. Active child app-server jobs should be marked `abandoned` or `failed` with a clear reason if the supervisor restarts.
- Child app-server crash should affect only that job, not the main Codex session.
- Queue drain must continue after a child startup failure, protocol failure, interrupt, or crash.
- `SubagentManager.shutdown()` should interrupt/kill all running app-server children and close sockets.

Logs and artifacts:

- Keep current artifact directory layout so Tim can inspect `data/subagents/job_*`.
- Add app-server protocol events to `events.jsonl` with enough metadata to debug steering:
  - request method
  - notification method
  - thread ID
  - turn ID
  - steering timestamp
  - interrupted timestamp
- Scrub secrets using the same policy as main app-server logs.
- Avoid writing full credential-bearing environment or raw OAuth material.

Testing:

- Unit test backend selection and unsupported steering on exec jobs.
- Unit test Telegram parser for `agent steer`.
- Unit test `SubagentManager.steerJob()` for not found, ambiguous, terminal, unsupported backend, and success.
- Integration test app-server backend with a fake JSON-RPC server before requiring real Codex in CI.
- Add a manual smoke test checklist for real `codex app-server` because protocol churn is a known risk.

Acceptance criteria:

- A child app-server crash or failed steer does not wedge `turnRunning`, the subagent queue, or service shutdown.
- Active app-server child jobs are never left untracked in memory.
- Restart behavior is explicit: abandoned jobs are reported as abandoned, and orphan cleanup is best-effort.
- Logs and artifacts are enough to reconstruct a steering session without reading private secrets.

## Phase 6: Default Migration After Proof

Goal: make steerable app-server children the normal subagent path after canary use.

Migration steps:

1. Run the app-server backend on Tim's server with `subagents.backend = "codex_app_server"` for a defined proof window.
2. Prove at least:
   - normal completion
   - steering during a long-running job
   - graceful interrupt
   - timeout path
   - child crash handling
   - service restart with active child jobs
3. Flip the default config to `codex_app_server`.
4. Keep `codex_exec` available as an explicit compatibility/fire-and-forget backend.
5. Update behavior docs and README references that currently say subagents launch `codex exec`.
6. Keep the existing `job_*` UI, artifact paths, and `agents` output stable.
7. Add a rollback note:
   - set `subagents.backend = "codex_exec"`
   - restart service
   - accept that in-flight app-server child jobs become abandoned

Acceptance criteria:

- New subagents default to steerable child app-server workers.
- Existing service users do not need to learn a new job ID model.
- Exec fallback is explicit, tested, and documented as non-steerable.

## Phase 7: Employee RFC and Scaffold After Steering Works

Goal: define durable Employees fully, but defer runtime implementation until child steering works reliably.

Employee definition:

```text
Employee = named domain responsibility
       + configurable dedicated directory
       + restartable Codex app-server runtime
       + warmup routine
       + compacted/refreshed durable knowledge
       + Git-backed persistence policy
       + steerable active turns
```

Important constraint from Tim: Employee directories are configurable per Employee and can be changed in config at any time. They live on the main assistant server where the Employee runs. Memory can be increased if needed.

Config sketch:

```toml
[employees]
enabled = false
rootDir = "data/employees"
socketDir = "data/run/employees"
defaultModel = "gpt-5.5"
defaultEffort = "medium"
maxActive = 2

[employees.email-calendar]
enabled = true
name = "Email/calendar"
directory = "/home/tim/.assistant-claude/workspace/employees/email-calendar"
profile = "email-calendar"
model = "gpt-5.5"
effort = "high"
startup = "on_demand" # "on_demand" or "always"
gitRemote = ""
gitBranch = "main"
persistRawLogs = false
compactAfterTask = true
```

Directory contract:

```text
<employee-dir>/
  AGENTS.md
  README.md
  employee.json
  state/
    current_state.md
    open_loops.md
    decisions.md
    runtime_briefing.md
  memory/
    people/
    organizations/
    projects/
  procedures/
    inbox_triage.md
    calendar_review.md
    contact_update.md
  logs/
    turns/
    events/
  compacted/
    durable_facts.md
    weekly_summary.md
  scratch/
```

Resource assumptions:

- Employees run on the same main assistant server as codex-chat unless explicitly changed later.
- Each active Employee may own a child `codex app-server` process, a local socket, logs, and a working directory.
- The local server must have enough memory for the configured active Employee count plus the main app-server and ephemeral subagents.
- Employee runtime should use local Unix sockets only; no remote WebSocket exposure is part of the initial design.
- Config changes to an Employee directory should be picked up on restart or explicit reload. If a directory changes while an Employee is active, stop the old runtime cleanly before starting against the new directory.

Persistence and Git:

- An Employee's continuity comes from files in its directory, not from assuming a permanent model context.
- Git persistence should be private by default.
- Support either one repo per Employee or one monorepo with one directory per Employee.
- Commit after successful compaction or explicit save points, not after every scratch edit.
- Never commit credentials, OAuth tokens, raw secrets, socket paths, or local pid files.
- Sensitive Employees such as email/calendar should prefer summaries and source pointers over raw email bodies.
- Provide a delete/forget workflow before enabling broad personal-data persistence.
- The supervisor should own safe Git operations rather than letting arbitrary Employee shell commands hide persistence behavior.

Compaction:

- Warmup reads `employee.json`, `AGENTS.md`, compacted durable context, `state/current_state.md`, and `state/open_loops.md`.
- Warmup writes or refreshes `state/runtime_briefing.md`.
- Compaction should run after task completion, before Git persistence, and on a configured maintenance interval.
- Compaction should promote durable facts out of raw logs, remove duplication, mark stale facts instead of deleting blindly, and keep operational state short.
- Raw logs should have retention policy and should be excluded from Git unless explicitly allowed.

Steering model:

- Employee turns use the same top-level steering path as subagents.
- Employee child subagents are centrally owned by `SubagentManager` and tagged
  with Employee owner metadata.
- If an Employee needs nested work, it emits service actions; it does not spawn
  subagents directly.
- The top-level user should generally steer the Employee, not arbitrary
  Employee-owned child jobs. Direct nested-child steering is available only when
  explicitly requested and authorized by owner/admin rules.

First pilot: email/calendar Employee

- Domain: checking email/calendar state, summarizing open loops, preparing suggested replies, and tracking recurring scheduling context.
- Directory: configurable, likely under assistant-agent-data or another Tim-controlled private path.
- Persistence: conservative by default; summaries and pointers first, raw message bodies only by explicit policy.
- Warmup: current inbox/calendar state, open scheduling loops, recent decisions, and response preferences.
- Safety: define what can be persisted, what must be redacted, and what can be pushed before enabling Git persistence.

Deferred full runtime implementation:

- The guarded app-server Employee runtime and child-subagent orchestration now
  exist, but `EmployeeSupervisor`, `EmployeeGitService`,
  `EmployeeMaintenanceService`, account integrations, autonomous scheduling,
  and Git push automation remain deferred until persistence/privacy policy is
  reviewed.
- Future Employee work should add:
  - reviewed directory creation/migration tooling
  - an example private `email-calendar` Employee directory
  - fake account connector tests before any real account access
  - no Git push automation until persistence policy is reviewed

Acceptance criteria for the RFC/scaffold:

- Employee directories are configurable per Employee.
- The email/calendar pilot has a concrete directory layout and policy file.
- Runtime work remains disabled by default.
- The plan explains how Employees reuse centralized child-subagent orchestration
  rather than inventing a separate execution ownership path.

## Open Technical Decisions

- Exact app-server Unix socket framing and whether `initialized` is required after `initialize`.
- Exact `turn/steer` and `turn/interrupt` parameter shape for the installed Codex version.
- Whether ephemeral child app-server threads should be `ephemeral: true`, `persistExtendedHistory: false`, or persisted for debugging.
- Whether profile instructions belong entirely in `thread/start` instructions, entirely in the first `turn/start` input, or split as proposed in Phase 3.
- Whether `agent steer <ref> <text>` should allow any allowed Telegram user or require the original chat/admin for a job.
- Whether steering text should support multi-line Telegram replies in addition to inline command text.
- Whether current IPC should be upgraded to request/response errors before adding `subagent_steer`, or whether a separate HTTP/API surface should be introduced later.
- How much child app-server protocol logging is safe by default for sensitive prompts.
- Whether completed app-server child artifacts with steering transcripts should respect existing `cleanupArtifacts` or be retained longer for early canary debugging.
- Where Employee directories should live by default for Tim's deployment: under `data/employees`, assistant-agent-data, or a separate private repo checkout.
- Employee Git topology: one repo per Employee versus one private monorepo.

## Overall Acceptance Criteria

The steering migration is complete when:

- Existing `dispatch_subagent` users still receive `job_*` IDs and use the same `agents`/`subagents` status UI.
- Default child subagents run through `codex_app_server` after proof, with `codex_exec` kept as explicit non-steerable fallback.
- A running subagent can be steered from Telegram with `agent steer <ref> <text>`.
- The same steering capability has directive and IPC/API schemas ready, with implementation following Telegram.
- `agent kill <ref>` gracefully interrupts app-server jobs with `turn/interrupt` before process kill fallback.
- Active turn tracking, restart handling, orphan cleanup, and artifacts make failures diagnosable.
- Employee runtime stays guarded and disabled by default, with child subagent
  execution centrally owned by `SubagentManager`.
- The email/calendar Employee pilot has an RFC/scaffold plan that covers configurable directories, local resource assumptions, Git/persistence, compaction, privacy, and owner-aware steering.
