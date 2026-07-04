# Brain Capability Enforcement Plan

Date: 2026-07-04
Status: plan only; no runtime code is implemented by this commit.

## Compatibility and rollback contract

- **No backwards compatibility will be preserved.** The implementation intentionally replaces Telegram allowlist compatibility grants, Slack source compatibility grants, synthetic wildcard grants, Employee-local capability aliases, admin fallbacks, and command/directive bypasses with Brain-authored capability decisions.
- **Rollback is reverting to the previous commit.** There will be no downgrade migration, compatibility mode, or dual authorization path. If enforcement breaks production behavior, revert the enforcement commit(s) to the previous commit and restore the prior state files from backup if needed.

## Current-state findings

### Representation

- Runtime grants are `CapabilityGrant` objects with `operations`, `resourceSelectors`, optional `expiresAt`, `actorId`, and `conversationSessionId`; check results only include `allowed`, `operation`, `grantIds`, optional `reason`, and `checkedAt` (`src/types.ts:46-68`). `RunContext` carries grants (`src/types.ts:100-108`), `UserEvent` can carry grants (`src/types.ts:226-243`), but `SubagentJob` persists owner/output fields without grant snapshots or decision history (`src/types.ts:293-322`).
- `OutputTarget` carries `routingPolicy` and `allowedOutputTypes` (`src/types.ts:37-44`), and runtime builders populate them for Telegram and Slack (`src/runtime.ts:533-568`), but send helpers do not authorize by those fields (`src/service.ts:2588-2625`).
- Brain capability code is Slack-specific: it reads `/home/tim/.brain/control-plane/capabilities.json` or `BRAIN_CAPABILITY_STORE_PATH`, resolves Slack identities, and chooses `assistant.run` if present or fallback `slack.source.read` (`src/brain-capabilities.ts:5-8`, `src/brain-capabilities.ts:397-407`).

### Checks and bypasses

- Compatibility grants are generated at runtime: Telegram admins receive `runtime:*` and `*`, normal Telegram users receive source write/read/dispatch operations, and Slack users receive source conversation operations (`src/runtime.ts:16-43`, `src/runtime.ts:586-644`). Synthetic/runtime events receive `operations: ["*"]` (`src/runtime.ts:646-660`).
- The generic `checkCapability()` ignores expiry and resource selectors; it only checks exact operations, `*`, or suffix wildcards (`src/runtime.ts:349-368`).
- Slack Brain enforcement is fail-closed at enqueue/run/context stages, but only for `event.source === "slack"` (`src/service.ts:493-495`, `src/service.ts:1361-1364`, `src/service.ts:2025-2071`, `src/service.ts:2437-2453`). Telegram, loop, monitor, audio ingest, subagent, and system sources are outside Brain enforcement today.
- Slack immediate "eyes" reactions happen before `enqueueUserEvent()` and before Brain denial (`src/service.ts:298-303`, `src/service.ts:465-491`). Telegram immediate reactions and typing indicators happen at the adapter layer before a generic Brain check exists (`src/telegram.ts:516-526`), and runtime context/grants are only built later (`src/telegram.ts:610-643`).
- Telegram service commands are intercepted before Codex and most are unauthorised by capabilities: logs/introspect, employee management, agent status/steer/kill/list, loops status, and help are routed directly to service helpers (`src/service.ts:497-553`). Deploy and backend mutation partially check compatibility/admin state (`src/service.ts:2677-2700`, `src/service.ts:2734-2744`), not Brain.
- Directive execution stores actions as pending/running before permission checks, then executes sends, subagent dispatch/control, notify owner, reactions, and synthetic enqueue without a generic capability check (`src/service.ts:1734-1854`). `directives.ts` has action schemas but no required capabilities (`src/directives.ts:1-120`, `src/directives.ts:140-170`).
- Subagent dispatch inputs do not carry actor grants, dispatch has queue/profile/provider checks but no capability check, result delivery trusts stored output targets, and job control broadly allows missing/main/admin actors (`src/subagents.ts:213-310`, `src/subagents.ts:428-578`, `src/subagents.ts:860-875`, `src/subagents.ts:1127-1150`).
- Loops and monitors can enqueue main turns, notify admins, dispatch subagents, and run trusted-config commands without Brain grants (`src/loops.ts:64-68`, `src/loops.ts:184-200`, `src/loops.ts:269-290`, `src/monitors.ts:73-77`, `src/monitors.ts:204-270`).
- Local IPC accepts mutating loop/subagent/employee messages with no token or Brain subject (`src/ipc.ts:6-13`, `src/ipc.ts:26-63`; service dispatch at `src/service.ts:387-416`). CLI inject writes a synthetic Telegram event as a fixed Tim identity (`src/main.ts:88-112`).
- Employee service actions have local string allow/deny aliases only, not Brain grants (`src/config.ts:61-77`, `src/employees.ts:762-813`), and Employee prompts describe those aliases (`src/employees.ts:917-924`).
- Child subagents inherit broad Codex sandbox/approval settings, and Claude subagents default to `bypassPermissions` with broad write/bash tools when enabled (`src/subagent-backends.ts:176-186`, `src/subagent-backends.ts:246-270`, `src/subagent-backends.ts:573-607`, `config/codex-chat.example.toml:129-150`).
- Codex-chat no longer owns the admin UI/API; docs and example config say Brain owns `/admin` and `/api/admin/brain` while codex-chat only owns runtime endpoints (`docs/brain-admin-auth.md:1-54`, `config/codex-chat.example.toml:81-86`). Stale generated `dist/admin-*` artifacts still reference Clerk and removed `/api/admin/codex-chat/*` routes, even though there are no matching `src/admin-*` sources.

### Existing test coverage and gaps

- Slack tests cover linked identity allow, unknown identity deny before Codex/context/subagent, and missing/invalid store fail-closed (`src/__tests__/slack.test.ts:486-609`). The test seed uses `enforcementEnabled: false` and grant `enforcement: "non_enforcing"`, but current code still enforces, so the enforcement field is ignored (`src/__tests__/slack.test.ts:98-177`).
- Telegram baseline tests assert compatibility grants and service command behavior (`src/__tests__/telegram-baseline.test.ts:9-180`). Existing subagent and service tests cover queue/backend/provider behavior, not Brain authorization of dispatch/control/result delivery.
- There are no tests for resource selector enforcement in `checkCapability`, output target policies, generic directive authorization, subagent grant propagation, IPC authorization, Brain-backed Telegram identity resolution, stale queued events/jobs, or removal of synthetic wildcard grants.

## Target model

### Canonical components

1. Add a central authorizer module, likely `src/capabilities.ts`, that is the only place service/runtime code can answer authorization questions.
2. Generalize `src/brain-capabilities.ts` from Slack-only resolver to a Brain store client/mapper used by all actors: Slack identities, Telegram identities, API keys, loop/monitor/system subjects, Employee subjects, and subagent child actors.
3. Treat each operation as a typed `CapabilityRequirement` with:
   - `operation`: canonical operation string.
   - `action`: Brain action if different from operation suffix.
   - `resource`: exact resource map (`surfaceKind`, `teamId`, `channelId`, `threadTs`, `chatId`, `messageId`, `jobId`, `employeeId`, `loopId`, `monitorId`, `apiKeyIdentity`, `artifactId`, `targetPolicy`, `outputType`).
   - `reason`: audit reason and caller.
   - `denialTarget`: optional safe source target for a denial reply.
4. Make `authorize()` fail closed unless a non-expired active Brain grant matches operation, action, actor subject, and resource selectors. Wildcards must only match individual selector values where Brain explicitly granted `*`; no runtime-created `*` operation grants.
5. Make `authorizeOrThrow()` and `authorizeOutput()` the mandatory gates before all side effects: model run, history hydration, reactions, sends, files, dispatch, cancel/steer, deploy, service commands, IPC mutations, loop/monitor callbacks, Employee service actions, audio ingestion delivery, and synthetic enqueue.
6. Record every decision in state/audit with actor, operation, resource hash/summary, grant IDs, outcome, reason, checkedAt, and caller. Do not store secret values.

### Operation matrix

Use one canonical string namespace; exact names can be adjusted during implementation, but every side effect must map to one operation.

| Area | Operations | Resource selectors |
| --- | --- | --- |
| Model execution | `assistant.run`, `assistant.context.read` | source, actor, workspace/team/chat/channel/thread/session |
| Slack | `slack.event.receive`, `slack.source.read`, `slack.source.reply`, `slack.source.react`, `slack.history.read`, `slack.channel.post` | team, channel, thread, message, source vs explicit target |
| Telegram | `telegram.event.receive`, `telegram.source.read`, `telegram.source.reply`, `telegram.source.react`, `telegram.chat.post`, `telegram.file.send` | chat, thread, message, source vs explicit target |
| Output | `output.text.send`, `output.image.send`, `output.document.send`, `output.progress.send`, `output.artifact.publish` | target id, surface, output type, route policy |
| Directives | `directive.<type>.execute` plus underlying side-effect operation | action id/idempotency key, run/session, target resource |
| Subagents | `subagents.dispatch`, `subagents.control.cancel`, `subagents.control.steer`, `subagents.result.deliver`, `subagents.backend.set`, `subagents.provider.override` | job id, owner, profile, route, backend, model/provider/profile |
| Service/admin | `service.command.logs`, `service.command.help`, `service.deploy`, `runtime.admin`, `runtime.health.read`, `runtime.status.read` | command, transport, requested target |
| Employees | `employees.manage.start`, `employees.manage.stop`, `employees.manage.steer`, `employees.status.read`, `employees.service_action.request_subagent`, `employees.service_action.cancel_subagent`, `employees.service_action.steer_subagent` | employee id, owner/request id, job id |
| Automation | `loops.run`, `loops.dispatch`, `loops.notify`, `monitors.trigger`, `monitors.pre_action.run`, `monitors.dispatch`, `monitors.restart` | loop/monitor id, pattern id, route |
| API/local | `audio_ingest.run`, `api.slack.events.receive`, `ipc.loop.run`, `ipc.subagent.steer`, `ipc.employee.manage`, `cli.inject` | API key identity, socket peer/token subject, command |
| System | narrowly-scoped `system.callback.enqueue`, `system.denial.reply`, `system.progress.record`, `system.audit.record` | generated by service only; no `*` |

## Implementation phases

### Phase 0 - Freeze assumptions and prepare Brain data

Files likely touched:
- `plans/2026-07-04-brain-capability-enforcement-plan.md` for tracking updates only.
- Brain-side seed/config outside this repo to pre-create subjects/grants for Tim, service accounts, loops, monitors, employees, API keys, and IPC/CLI users.

Steps:
1. Export current Brain capability store metadata only: schema version, counts, active subjects/grants, and grant IDs. Do not print secrets.
2. Create required grants before code rollout, including Tim's Telegram and Slack identities, service deployment/admin grants, loop/monitor service-account grants, and denial-reply grants.
3. Decide final operation names and publish them as Brain capabilities.
4. Back up `data/state`, Brain capability store, and config files.

Exit criteria:
- Brain has explicit grants for every production path that should continue after enforcement.
- No implementation code is changed yet.

### Phase 1 - Central authorizer and data model

Files likely touched:
- `src/types.ts`
- `src/capabilities.ts` (new)
- `src/brain-capabilities.ts`
- `src/runtime.ts`
- `src/state.ts`
- `src/config.ts`
- `config/codex-chat.example.toml`
- `.env.example`
- `src/__tests__/capabilities.test.ts` (new)
- `src/__tests__/brain-capabilities.test.ts` (new or expanded)
- `src/__tests__/config.test.ts`

Steps:
1. Add `CapabilityRequirement`, `CapabilityDecision`, `CapabilityActor`, `CapabilityResource`, and `CapabilityDecisionRecord` types.
2. Replace the current `checkCapability()` behavior with strict evaluation:
   - reject missing grants;
   - reject expired grants;
   - reject inactive/non-enforcing-denied grants according to Brain's canonical enforcement semantics;
   - match operation/action;
   - match every resource selector;
   - record exact denial reason.
3. Remove runtime-created compatibility operation arrays from authorizer inputs. Until later phases wire all call sites, tests should assert they are no longer accepted.
4. Make Brain store config explicit under a `[brain]` section and fail startup if required Brain capability source is absent or unreadable in enforcing mode.
5. Create state writer for capability decisions under `data/state/capability_decisions/` or a similar auditable path.
6. Add a linter-like unit test that scans source for forbidden `hasCapability(` use outside `src/capabilities.ts` after migration.

Exit criteria:
- Authorizer unit tests prove selectors, expiry, wildcard selector values, denial reasons, and audit records.
- No call site can accidentally use the old operation-only checker after the phase is complete.

### Phase 2 - Inbound identity and model-run gates

Files likely touched:
- `src/runtime.ts`
- `src/brain-capabilities.ts`
- `src/service.ts`
- `src/telegram.ts`
- `src/slack.ts`
- `src/api.ts`
- `src/audio-ingest.ts` if present/needed by API hooks
- `src/main.ts`
- `src/__tests__/slack.test.ts`
- `src/__tests__/telegram.test.ts`
- `src/__tests__/telegram-baseline.test.ts`
- `src/__tests__/api.test.ts` or `src/__tests__/audio-ingest.test.ts`

Steps:
1. Resolve a Brain actor for every inbound event source before any reaction, session creation, queueing, context read, or model turn.
2. Remove Telegram allowlist/admin compatibility grants from `buildTelegramRuntimeContext()` and Slack source compatibility grants from `buildSlackRuntimeContext()`.
3. Remove synthetic `operations: ["*"]`; replace with narrow service-issued grants for callbacks that have no human actor and only after `authorize()` approves the originating trigger.
4. Move Slack immediate reaction after authorization for `slack.source.react`; remove or gate Telegram immediate reaction similarly.
5. Gate `enqueueUserEvent()` with source receive/run requirements and `processEvent()` with `assistant.run` at execution time, not only queue time.
6. Make queued events re-check live Brain grants when processed so revoked grants stop stale work.
7. Convert audio ingestion API-key auth into a Brain actor and require `audio_ingest.run` before enqueueing/delivering the transcript.
8. Convert CLI inject to a Brain-authenticated request or remove it; no fixed Tim synthetic identity.

Exit criteria:
- Unknown or ungranted Slack and Telegram users get only a safe denial reply, no reaction, no context hydration, no Codex turn, and no subagent dispatch.
- Missing/unreadable Brain capability store fails closed for every external/human source.

### Phase 3 - Service commands and directives

Files likely touched:
- `src/service.ts`
- `src/directives.ts`
- `src/runtime.ts`
- `src/types.ts`
- `src/__tests__/service.test.ts`
- `src/__tests__/introspect.test.ts`
- `src/__tests__/telegram-baseline.test.ts`
- `src/__tests__/directives.test.ts` (new)

Steps:
1. Build a command-to-requirement table for logs/introspect, deploy, backend status/set/clear, employee commands, agent status/steer/kill/list, loops status/run, help, health, and any future service command.
2. Check command authorization before executing or before reading sensitive data. Public/help-like commands still require explicit `service.command.help` or `runtime.status.read`; there is no implicit allow.
3. Build a directive-to-requirement table in `directives.ts` or `src/capabilities.ts`.
4. Authorize directives before saving `pending`/`running` side-effect actions. Save denied directives as `skipped` or `failed` with `capabilityDecisionId`, but do not perform the side effect.
5. For each directive, authorize both the directive action and the underlying operation:
   - `send_text`: `directive.send_text.execute` and `output.text.send`/surface send.
   - `send_image`: `directive.send_image.execute`, `output.image.send`, `telegram.file.send`.
   - `send_document`: `directive.send_document.execute`, `output.document.send`, `telegram.file.send`.
   - `dispatch_subagent`: `directive.dispatch_subagent.execute`, `subagents.dispatch`, and provider/model/backend override operations.
   - `cancel_job`/`steer_subagent`: directive op and `subagents.control.*` scoped to the job owner/session.
   - `notify_owner`: `runtime.admin` or `output.text.send` to the admin target.
   - `react`: `output.reaction.add` plus surface-specific reaction.
   - `enqueue_main`: `system.callback.enqueue` with original run/session provenance.
6. Denial replies must go through a narrow `system.denial.reply` path that can only reply to the source target and never to explicit third-party targets.

Exit criteria:
- Every service-command and directive branch has an authorization call before any side effect.
- Tests prove each action is denied before sends/subagent calls/notifyOps when the grant is missing.

### Phase 4 - Output enforcement

Files likely touched:
- `src/service.ts`
- `src/runtime.ts`
- `src/telegram.ts`
- `src/slack.ts`
- `src/files.ts`
- `src/types.ts`
- `src/__tests__/service.test.ts`
- `src/__tests__/slack.test.ts`
- `src/__tests__/telegram.test.ts`

Steps:
1. Replace `canSendTextToOutputTarget()` with `canSendOutputToTarget(actor, target, outputType, reason)` backed by `authorizeOutput()`.
2. Require `allowedOutputTypes` to contain the attempted type and require Brain grants for both generic output and surface-specific output.
3. Enforce `routingPolicy`:
   - `source_reply`: only original source thread/message target.
   - `explicit_target`: requires explicit target grant.
   - `silent`/`artifact`: no chat/network output except artifact publication.
4. Put all Telegram/Slack send helpers behind service-level authorizers; keep adapter methods low-level but add comments/tests that they are not authorization boundaries.
5. Gate progress events, artifacts, FileStore reads/sends, image/document sends, and Slack telemetry payloads for sensitive content.
6. Make subagent callback and heartbeat notifications use explicit service-account grants.

Exit criteria:
- No send helper can be called from service without an actor/provenance and decision.
- Output tests cover wrong type, wrong channel/chat, explicit target without grant, source reply with grant, and denial-reply special case.

### Phase 5 - Subagents and child runtime containment

Files likely touched:
- `src/types.ts`
- `src/subagents.ts`
- `src/subagent-backends.ts`
- `src/service.ts`
- `src/env.ts`
- `behavior/AGENTS.md`
- `behavior/subagents/*.md`
- `src/__tests__/subagents.test.ts`
- `src/__tests__/service.test.ts`
- `src/__tests__/env.test.ts`

Steps:
1. Add grant/provenance fields to `DispatchInput` and `SubagentJob`: origin actor, requirement/decision IDs, allowed result target, allowed control actors, and a sanitized capability summary for the child prompt.
2. Require `subagents.dispatch` before queueing a job, and re-check before starting queued jobs.
3. Enforce model/profile/provider/backend overrides via dedicated operations. Provider overrides remain denied unless Brain grants explicitly allow the requested provider/profile/model.
4. Require `subagents.control.cancel` and `subagents.control.steer` at the service boundary; remove broad allow for missing actor in `authorizeJobControl()`.
5. Require `subagents.result.deliver` before returning to main, user, employee, or admins. If denied, store the result as artifact only and record an audit denial; do not leak content to fallback admin paths unless explicitly granted.
6. Pass only the sanitized allowed capability summary to child instructions; never pass raw Brain store or secret selectors.
7. Constrain child backends based on grant metadata where possible: sandbox, approval policy, Claude permission mode/tools, and provider env access. Any `bypassPermissions` backend requires a specific `subagents.backend.claude.bypass_permissions` grant.
8. Update subagent status displays to show capability decision IDs/grant IDs and denial state without exposing secret selector values.

Exit criteria:
- A model cannot dispatch, steer, cancel, or exfiltrate via subagent result target without Brain grants.
- Jobs created before the enforcement commit fail closed or are abandoned because no backwards compatibility is preserved.

### Phase 6 - Automation, Employees, IPC, and CLI

Files likely touched:
- `src/loops.ts`
- `src/monitors.ts`
- `src/employees.ts`
- `src/service.ts`
- `src/ipc.ts`
- `src/main.ts`
- `src/config.ts`
- `config/codex-chat.example.toml`
- `src/__tests__/loops.test.ts`
- `src/__tests__/monitors.test.ts`
- `src/__tests__/employees.test.ts`
- `src/__tests__/ipc.test.ts` (new)

Steps:
1. Assign every loop and monitor a Brain subject/service account in config; reject enabled loop/monitor definitions without a Brain subject.
2. Authorize loop run, command execution, main enqueue, admin notification, and subagent dispatch by loop subject and route.
3. Authorize monitor trigger, preAction command execution, restart, main enqueue, and subagent dispatch by monitor subject and pattern.
4. Replace Employee-local `capabilities.allowed/denied` with Brain grants. Existing local aliases are removed; no compatibility translation.
5. Require Brain grants for Telegram/CLI/IPC Employee start/stop/steer/status and for Employee service actions.
6. Add IPC authentication: either a local token mapped to a Brain subject or removal of mutating IPC commands. The socket path alone is not authorization.
7. Require `cli.inject`/`ipc.*` grants for CLI-driven mutations; otherwise fail with a clear denied message.

Exit criteria:
- Local automation can run only with explicit Brain grants.
- Tests demonstrate a filesystem/socket-capable local process cannot mutate runtime without IPC/CLI capability credentials.

### Phase 7 - State, migrations, and stale data policy

Files likely touched:
- `src/state.ts`
- `src/types.ts`
- `scripts/*` for one-way state cleanup if needed
- `data/state` fixtures in tests
- `src/__tests__/state.test.ts`

Steps:
1. Add state schema version metadata for capability enforcement.
2. Because no backwards compatibility is preserved, invalidate or abandon old queued turns, actions, and jobs that lack capability decision IDs/grant snapshots.
3. Persist capability decisions for sessions, turns, actions, jobs, loop runs, monitor events, employee actions, and IPC/API requests.
4. Add startup validation that refuses to run in enforcing mode with old active jobs/queued turns unless an explicit one-way cleanup script has marked them abandoned.
5. Ensure persisted state never includes secret values from env files, API keys, or raw Brain credential material.

Exit criteria:
- Restarting the service cannot resurrect pre-enforcement work with missing grants.
- State audit can explain every allowed or denied side effect.

### Phase 8 - Admin/Brain boundary and generated artifacts

Files likely touched:
- `docs/brain-admin-auth.md`
- `plans/slack-company-brain-runtime.md`
- `config/codex-chat.example.toml`
- `dist/` generated output after build
- `package.json` if packaging filters need adjustment

Steps:
1. Keep codex-chat read-only with respect to capability grants; Brain remains the admin/write surface.
2. Document that codex-chat requires Brain capability source availability and does not expose grant write APIs.
3. Remove stale generated `dist/admin-auth.*` and `dist/admin-page.*` artifacts, or ensure build output no longer ships them. They reference removed Clerk/admin routes and can confuse rollback/packaging.
4. Ensure docs continue to say Brain owns `/admin`, `/api/admin/brain`, identity linking, and grant writes.

Exit criteria:
- No codex-chat source or generated artifact advertises removed `/api/admin/codex-chat/*` APIs.
- Admin capability changes are verified in Brain, then observed in codex-chat decisions.

### Phase 9 - Prompt/display updates

Files likely touched:
- `src/service.ts`
- `src/subagents.ts`
- `src/employees.ts`
- `behavior/AGENTS.md`
- `behavior/subagents/*.md`
- `docs/telegram-runtime-baseline.md`
- `src/__tests__/service.test.ts`
- `src/__tests__/subagents.test.ts`

Steps:
1. Add a bounded capability summary to main and child prompts: allowed high-level actions, explicit target limitations, and denial behavior. Do not expose raw selectors, secrets, full grant JSON, or Brain store paths.
2. Update status displays for active jobs, sessions, Employee runtimes, and service commands to show enforcement status and decision IDs.
3. Update behavior docs so the model knows directives may be denied and should not attempt bypasses.
4. Remove instructions that imply Employee local capability aliases are authoritative.

Exit criteria:
- Operators can see why an action was denied without leaking secret authorization material.
- Model prompts are clear enough to reduce denied/bypass attempts but enforcement does not rely on prompt compliance.

## Invariants

1. No external or human-origin event reaches Codex without an `assistant.run` decision allowed by Brain.
2. No pre-authorization reactions, progress messages, reads, context hydration, service commands, directives, sends, subagent operations, or automation callbacks.
3. No runtime-created wildcard operation grant. System grants are narrow, single-purpose, and tied to prior authorized provenance.
4. Authorization is checked at side-effect time, not only at enqueue time.
5. Revoked or expired grants stop queued and long-running follow-up work at the next side-effect boundary.
6. Resource selectors are enforced for every operation; operation-only checks are forbidden.
7. Denial replies can only go to the source target and must use a special narrow denial path.
8. Adapters (`telegram.ts`, `slack.ts`) remain transport primitives, not authorization boundaries.
9. Subagent jobs, Employee actions, loop runs, monitor events, and directives carry auditable capability decision IDs.
10. No secrets or full grant store contents are shown in prompts, logs, status, or test snapshots.

## Failure modes to handle

- Brain store missing, unreadable, invalid, or stale: fail closed for all non-internal operations; emit health degradation and audit denial.
- Brain grant revoked while work is queued/running: next side effect is denied, job/action is marked denied/abandoned, no output fallback leaks content.
- Old queued events/jobs/actions without decision IDs: abandon/fail closed because no backwards compatibility is preserved.
- Denial reply itself is denied or target invalid: log/audit only; do not retry to a broader/admin target unless separately granted.
- Slack/Telegram source target no longer exists: record output denial/failure; do not send elsewhere.
- Loop/monitor service subject missing: disable that loop/monitor at startup or mark runs denied.
- IPC token missing/invalid: reject mutating command; do not fall back to socket filesystem permissions.
- Child backend configured with broad Claude/Codex permissions but caller lacks backend grant: dispatch denied before spawning child.
- Brain selector wildcard accidentally broad: audit should show exact matched grant IDs and selectors so Brain admin can revoke quickly.
- Audit writer fails: side effect fails closed unless the operation is `system.audit.record` recovery itself.
- Store read latency or lock contention: bounded timeout; fail closed rather than using stale allow decisions.

## Test plan

Run at least `pnpm test` and `pnpm run build` after implementation. Add focused tests before rollout:

1. `capabilities.test.ts`: operation/resource matching, expiry, selector wildcard semantics, denied reasons, no operation-only wildcard, audit redaction.
2. `brain-capabilities.test.ts`: Slack, Telegram, API key, service account, Employee, loop, and monitor actor resolution; missing/invalid store fail-closed; ignored/non-enforcing grants denied according to final Brain semantics.
3. `slack.test.ts`: no immediate reaction before allow; allow path requires `assistant.run` and source output grants; deny path sends only safe denial; history hydration requires `assistant.context.read`/`slack.history.read`.
4. `telegram.test.ts` and `telegram-baseline.test.ts`: remove compatibility grant expectations; unknown/ungranted Telegram denied; deploy/backend/logs/agent/loop/help commands require explicit grants.
5. `directives.test.ts`/`service.test.ts`: every directive denied before side effects without grants; explicit target send requires explicit target grants; idempotency does not skip authorization for new side effects.
6. `subagents.test.ts`: dispatch/control/result delivery require grants; stale jobs without decisions fail closed; provider/backend overrides require grants; child prompt contains only sanitized capability summary.
7. `loops.test.ts` and `monitors.test.ts`: route-specific automation grants; command/preAction grants; missing service subjects deny.
8. `employees.test.ts`: local alias capabilities removed; Brain grants control start/stop/steer/status and Employee service actions.
9. `ipc.test.ts`/CLI tests: socket mutations require token/Brain subject; CLI inject requires `cli.inject` or is removed.
10. `state.test.ts`: capability decision records persisted and redacted; startup refuses stale active work without one-way cleanup.
11. Static tests: scan for forbidden `hasCapability(` or direct `telegram.notifyOps`/`sendTextToOutputTarget` paths outside authorized wrappers.

## Rollout and verification

1. Pre-rollout: back up repo, `data/state`, Brain capability store, and runtime config. Capture current `git rev-parse HEAD` and active jobs/queued turns.
2. Seed Brain grants for expected users/service accounts. Verify with a read-only script that prints counts and grant IDs only.
3. Deploy enforcement commit in a maintenance window because old active work will be abandoned and no backwards compatibility is preserved.
4. Start service and verify health shows Brain capability source reachable and enforcement enabled.
5. Canary denied paths first: ungranted Slack/Telegram/API/IPC attempts must not react, run Codex, hydrate context, dispatch subagents, or leak output.
6. Canary allowed paths: Tim Slack source reply, Tim Telegram source reply, explicit deploy by admin grant, one allowed subagent dispatch/result, one loop/monitor service account, and one Employee service action.
7. Inspect capability decision audit records for each canary; verify operation, resource summary, grant IDs, outcome, and redaction.
8. Watch logs for direct adapter sends or notifyOps calls without decision IDs.
9. Leave Brain revoke canary in place: revoke one grant and confirm queued/follow-up side effect denies without restart.

## Rollback

- Rollback is reverting to the previous commit. There is no compatibility switch or downgrade migration.
- If enforcement fails after implementation:
  1. Stop new input at the reverse proxy/transport if needed.
  2. Revert the enforcement commit(s) to the previous commit.
  3. Restore the backed-up pre-enforcement state/config if the implementation performed one-way state cleanup.
  4. Rebuild and restart outside any child subagent session.
  5. Re-run the old smoke tests to confirm pre-enforcement behavior is restored.
- Do not attempt partial rollback by re-adding wildcard grants or admin fallbacks; that would violate the enforcement invariant and hide failures.
