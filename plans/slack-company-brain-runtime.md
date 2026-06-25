# Slack Company Brain Runtime Plan

Date: 2026-06-25
Status: durable architecture plan / implementation roadmap

## Decision

Keep the Slack/company-brain work in the `codex-chat` repo, but stop treating
`codex-chat` as a Telegram-shaped bot. The target architecture is a
capability-aware, multi-surface agent runtime where Telegram, Slack, and later
surfaces are adapters over shared core abstractions.

Telegram remains supported. Slack should not be bolted onto Telegram-specific
message, user, command, or permission types. Instead, both Telegram and Slack
should translate inbound events into the same runtime model and render outbound
runtime events through surface-specific adapters.

## Goals

- Preserve the working Telegram service while making it one adapter among many.
- Add Slack as a first-class company surface without leaking Slack tokens or raw
  Slack ACL assumptions into agent/subagent prompts.
- Make capability checks explicit, auditable, and enforced at every tool call.
- Let authorized Telegram users operate the company brain, including searching
  or acting across Slack chats, when their capabilities allow it.
- Support long-running Codex work with visible progress, cancellation, steering,
  and audit/correlation IDs across surfaces.
- Keep the company brain state and retrieval layer ready for a central server
  with many subagents, persisted summaries, indexes, and context compression.

## Current state to preserve

Based on the current repo/system state:

- [x] Telegram adapter/current `codex-chat` service exists.
- [x] Subagent manager exists with queued/running job state, artifact dirs,
      result routing, and status commands.
- [x] Loop and monitor runtimes exist and can dispatch work back to the main
      loop or to subagents.
- [x] Basic steering/cancel exists for subagents through Telegram/service
      commands, directives, and IPC seams.
- [x] Behavior packs exist under `behavior/`, including subagent profiles and
      main-loop dispatch guidance.
- [x] Fast mode/service tier support is implemented for the main loop,
      subagents, loops, monitors, and directive schemas.
- [x] Existing Brain/company-runtime planning notes exist in the broader local
      system, including Brain monorepo/runtime parity plans that already frame
      Telegram as an adapter over a channel-neutral runtime.
- [ ] Slack adapter exists.
- [x] Capability-aware runtime abstractions are implemented in `codex-chat`.
- [ ] Durable company-mode capability state exists outside long-term JSON files.
- [ ] Admin dashboard exists for users, channel mappings, capabilities, audits,
      and running jobs.

## Core runtime abstractions

### `ActorContext`

`ActorContext` identifies the actor requesting or authorizing work. It is the
runtime's identity object, not a Telegram or Slack user object.

Suggested fields:

- stable actor ID
- surface kind (`telegram`, `slack`, `dashboard`, `system`, etc.)
- surface-specific user IDs as adapter metadata
- display name and handle snapshots
- organization/workspace/team IDs
- admin/personal-owner markers
- authenticated session metadata
- correlation ID for the inbound request

Telegram should use the same `ActorContext` shape as Slack. Tim's current
personal Telegram use should be represented as a privileged personal/admin actor
with explicit grants, not as a bypass around the capability model.

### `OutputTarget`

`OutputTarget` describes where output should go, independently of where the work
originated.

Examples:

- reply to the source Telegram chat/message
- reply to the source Slack thread
- post a progress update to a Slack channel
- DM a user on Slack
- send an admin notification to Telegram
- write an artifact only, with no user-visible send

Fields should include surface kind, workspace/team, channel/chat/thread/message
IDs, routing policy, allowed output types, and any required audit labels. Tool
and subagent requests should use explicit output targets instead of inferring
that replies always go back to the inbound channel.

### `RunContext`

`RunContext` is the per-turn/per-job envelope used by the main loop, subagents,
loops, monitors, and Employees.

It should contain:

- run ID and parent run ID
- conversation session ID
- actor context
- origin target and default output target
- capability grants effective for this run
- surface metadata needed by renderers
- progress sink
- cancellation and steering handles
- artifact directory
- audit/correlation IDs
- context budget and compression policy

Subagents should receive a narrowed `RunContext` view: enough metadata to do
their job and report progress, never raw bot tokens or unrestricted channel
access.

### Conversation-scoped main loops / sessions

The runtime should treat a live Codex main loop as scoped to one conversation,
not to the whole Slack workspace, the whole Telegram service, or a global bot
context. A `ConversationKey` is the stable adapter-derived key for that scope.
A `ConversationSession` is the durable runtime record that owns the active or
hibernated main-loop state, mailbox, current checklist/progress state, active
leases, compressed memory, effective grants, and archive metadata for that key.

Default conversation granularity:

- Slack app mention in a channel creates or resumes a Slack thread session
  keyed by workspace/team ID, channel ID, and `thread_ts` (falling back to the
  message timestamp when starting a thread).
- Slack DM creates or resumes the DM conversation ID.
- Slack MPIM/private group creates or resumes the Slack conversation ID, with
  member and capability context captured as part of the session metadata.
- Telegram creates or resumes by chat ID, plus `message_thread_id`/forum topic
  where available.

Channel-level state is ambient memory, retrieval index, summary state, and
capability scope. It is not a live main loop by default. A channel gets a live
session only for explicit watch, triage, digest, monitor, or similar modes with
bounded leases and clear output policy.

Session lifecycle:

1. Start: derive the `ConversationKey`, create the `ConversationSession`, attach
   initial grants/output targets, and create the first `RunContext`.
2. Run: process mailbox items, dispatch tools/subagents, emit progress events,
   and persist compressed session state.
3. Wait/hibernate: when blocked on user input, approvals, timers, queues, or
   idle time, release expensive model/worker resources while preserving durable
   session state.
4. Resume: reacquire an active lease when a new event, scheduler wakeup,
   approval, or subagent result arrives for the same `ConversationKey`.
5. Expire/archive: after retention/TTL policy, close active leases, retain audit
   records and summaries, and archive or prune heavyweight state.

Hibernation and scheduling are runtime requirements, not optimizations. The
session registry should enforce max active leases, per-workspace and per-surface
rate limits, backoff, wakeup scheduling, and cost controls so many quiet Slack
threads or Telegram chats do not become immortal model contexts.

Subagents are owned by `{conversationSessionId, runId, checklistItemId}`. They
return output, artifacts, and progress to the owning session mailbox/progress
sink, where the session runtime performs capability checks, output routing, and
final composition.

### `CapabilityGrant` and capability checks

Capabilities are the authorization boundary. A `CapabilityGrant` should have:

- unique stable ID
- human-readable name and description
- scope (`user`, `chat`, `channel`, `workspace`, `temporary`, `system`)
- allowed operations and resource selectors
- grant source and grantor
- expiry for temporary capabilities
- audit policy

Every tool call checks capabilities at execution time. Prompt instructions are
not enforcement. Slack ACLs can inform default grants, but the runtime must not
trust Slack ACLs alone because the agent can combine data, route output across
surfaces, and take actions that Slack itself does not understand.

Important capability families:

- read Slack channel/thread history
- search Slack across selected channels
- summarize Slack channel or thread
- post to source Slack thread
- post to an explicitly selected Slack channel
- DM a Slack user
- read/write Telegram chats
- dispatch subagents
- access company brain indexed summaries
- operate admin/dashboard functions
- approve temporary chat capabilities

Future capability planning should likely split these families into individual
abilities for each repo the company brain can access or mutate. For example,
`repo:codex-chat:read`, `repo:codex-chat:write`, `repo:assistant-agent-logic:read`,
and `repo:assistant-agent-logic:write` should be distinct enough that a user can
read plans, inspect diffs, open PRs, or run deploy actions for only the repos
they are trusted to operate.

### `ProgressEvent` and progress sink

Long-running work should emit structured `ProgressEvent`s rather than ad hoc
text. The progress sink can then render appropriately for each surface.

Suggested event types:

- checklist created/updated
- item started/completed/failed/skipped
- subagent dispatched/steered/cancelled/completed
- tool call started/completed/failed
- partial summary
- waiting for approval/input
- final result

Slack can render these as an updating message with checked-off items and thread
updates. Telegram can use a simpler status stream or periodic concise updates.
The same progress events should also feed the audit viewer and running-jobs UI.

### Audit and correlation IDs

Every inbound event, run, subagent, tool call, output send, capability check,
and external API call should carry correlation IDs. Audit records should capture
who asked, what capability was checked, what resource was accessed, where output
was sent, and which run/subagent did it.

IDs to standardize:

- inbound event ID
- run ID
- subagent/job ID
- tool call ID
- output event ID
- capability check ID
- Slack event/channel/thread/message IDs as adapter metadata
- Telegram chat/message IDs as adapter metadata

## Telegram in the capability model

Current Telegram control should migrate into the shared actor/capability model:

- Tim's Telegram actor gets a privileged personal/admin grant set.
- Existing allowed Telegram users become actors with explicit grants.
- Telegram admin commands become capability-checked operations.
- Telegram users can operate the company brain, including reading/searching or
  acting across Slack chats, only when their grants allow the requested resource
  and output routing.
- Telegram-originated work can target Slack output only with explicit target
  routing and matching write capability.

This keeps Telegram powerful while avoiding hidden special cases that Slack and
future surfaces cannot reuse.

## Slack adapter design

### Input

Start with Slack Events API support for:

- app mentions in channels
- DMs to the app
- message actions or shortcuts later
- selected interactive button clicks from progress/admin messages

The Slack HTTP handler must fast-ack within Slack's deadline and enqueue work.
It should not run long Codex turns inline. The queued event becomes a normalized
runtime inbound event with `ActorContext`, `OutputTarget`, Slack metadata, and
correlation IDs.

Required metadata:

- team/workspace ID
- enterprise ID if present
- channel ID and channel type
- thread timestamp and message timestamp
- Slack user ID
- app/bot user ID
- event ID/retry metadata for idempotency
- channel/user names as cached display snapshots, not authorization truth

### Output

Slack renderer responsibilities:

- reply to the source thread by default
- post to an explicitly selected target channel when authorized
- DM a user when authorized
- update a progress/checklist message as `ProgressEvent`s arrive
- render final answers with artifacts/links
- show approval buttons for temporary capabilities or admin operations
- avoid leaking private run metadata unless the target grants allow it

`OutputTarget` must drive posting. The main loop and subagents should not call
Slack APIs directly or decide target channels from raw strings without runtime
validation.

### Slack read tools

Expose Slack reads only as capability-checked tools owned by the runtime:

- fetch source thread/context
- read recent channel history
- search selected channels
- fetch permalink/message metadata
- resolve channel/user metadata
- read channel membership/visibility metadata as advisory input

Tools should return bounded, redacted, source-attributed data with correlation
IDs. They should support summarization/index handoff so subagents do not need
unbounded raw history.

### Slack write tools

Expose Slack writes only as capability-checked runtime tools:

- post reply to source thread
- post/update progress message
- post to explicit target channel
- DM explicit target user
- add reaction/status marker
- upload/link artifact when allowed

No raw Slack bot/user tokens should be available to the main Codex process or
subagents. Subagents request an operation; the runtime checks capability, logs
audit, and executes through the adapter.

## Capability assignment model

Capability state should support:

- actor grants: stable actor-level permissions
- conversation grants: permissions tied to a specific Slack thread, DM, MPIM,
  private group, Telegram chat, or Telegram forum topic
- workspace grants: permissions tied to a Slack workspace/team, Telegram
  administrative scope, or other organization-level resource
- temporary run grants: short-lived grants approved in-context for one run or
  session and automatically expired
- output-target grants: separate routing permissions for where results,
  progress, artifacts, or notifications may be sent
- explicit target routing: separate capability to read a source versus post to a
  target
- unique IDs and descriptions for every grant
- audit records for grant creation, use, denial, expiry, and revocation
- AI-assisted suggestions, but human-confirmed grants for sensitive operations

Temporary capabilities are useful for one-off questions like "summarize this
private Slack thread and send it to this Telegram chat". The runtime should show
exactly what access and output routing is being granted, for how long, and by
whom.

Capability selectors must distinguish narrow and broad resources. Examples:

- reading the source Slack thread is different from reading the whole channel
- reading a Slack channel is different from exporting its summary to Telegram
- posting back to the source thread is different from posting to an arbitrary
  Slack channel
- DMing the requesting actor is different from DMing any workspace member
- source-attributed summaries, embeddings, and compressed memories inherit the
  source capabilities and must be filtered before retrieval or export

Long-term company-mode capability state should not live in JSON files. JSON is
fine for early prototypes, local tests, or import/export, but durable operation
should use a real store with migrations, indexes, revocation history, and audit
query support.

## Admin and dashboard

Build an admin/dashboard surface that can manage and inspect:

- users/actors and identity mappings across Telegram and Slack
- allowed dashboard users and their admin status
- Slack workspace/channel mappings
- Telegram chat mappings
- capability grants, temporary grants, and revocations
- bundled capability assignments for common user roles or trust levels
- audit viewer filtered by actor, channel, run, capability, and correlation ID
- running jobs/subagents/Employees with steering and cancellation
- queue health, loops, monitors, and stuck jobs
- AI-assisted capability assignment proposals
- button-click operations for approvals, grants, reroutes, cancels, and retries

The dashboard must be Clerk-authenticated and fail closed. Tim's current Clerk
pattern, documented in the Tim Continual Learning `clerk` and `admin-site`
skills, is Clerk sign-in plus a server-side email allowlist such as
`CLERK_ALLOWED_EMAILS`: resolve the verified Clerk email, normalize it
case-insensitively, and reject signed-in users outside the allowlist with a
server-side `403`. The dashboard should follow that pattern, keep
`/api/health` public where applicable, protect `/api/auth/me` and remaining
admin APIs, and provide a visible logout/switch-account path on forbidden or
auth-adjacent pages.

For this runtime dashboard, the allowed-user list is required authorization
state: if no allowed dashboard users are configured, no one gets access to the
dashboard, including signed-in Clerk users. This is stricter than any permissive
dev default and matches the admin-site expectation that internal tools require a
server-side allowlist. Store only environment variable names and non-secret
metadata in repo/registry documentation; never record Clerk secret values.

Dashboard admins should be able to assign capabilities to users in bundles,
then inspect and adjust the individual grants created by each bundle. Bundles
should be convenience templates, not opaque roles that bypass runtime
capability checks or audit records.

Telegram can also remain an admin control surface. The same admin operations
should be runtime actions with capability checks whether invoked from Telegram,
Slack buttons, or the dashboard.

## Incremental progress and checklist orchestration

For multi-step work, the main loop should create an initial checklist and emit a
`ProgressEvent` for it. Each checklist item can dispatch a subagent or run a
bounded tool sequence. Subagents emit structured progress updates against their
assigned item.

Recommended flow:

1. Main loop receives normalized event, creates/resumes a `ConversationSession`,
   and creates `RunContext`.
2. Main loop plans checklist items with required capabilities and output target.
3. Runtime posts or updates an initial progress message.
4. Main loop dispatches subagents per item where useful.
5. Subagents emit progress events, artifacts, and final item summaries.
6. Runtime renderer checks off items in Slack and sends simpler Telegram status
   updates where appropriate.
7. Main loop composes final answer from item results and persisted summaries.
8. Audit records link conversation sessions, checklist items, subagents, tool
   calls, outputs, and capability checks by correlation ID.

Slack should get the richest renderer first: an updating checklist message,
threaded details, approval buttons, and final answer. Telegram can initially use
concise messages such as "3/6 done" and final summaries, while still receiving
all underlying progress events in the audit log.

## Remote brain/server architecture

The company brain should run as a central server, not as state scattered across
client adapters.

Core server responsibilities:

- event ingestion from Telegram, Slack, dashboard, loops, and monitors
- shared runtime abstractions and capability checks
- queueing and cancellation/steering
- many subagent workers with bounded context
- progress event fanout to renderers
- persisted run summaries and artifacts
- retrieval/index service over Slack, Telegram, docs, and durable summaries
- context compression for long channels, long runs, and repeated company topics
- audit/correlation log and admin queries

Compression/context management should be explicit:

- source messages remain source-attributed
- long threads/channels get persisted summaries and embeddings/index entries
- subagents receive task-specific compressed context instead of raw company-wide
  history by default
- final answers cite the source surface/channel/thread where policy permits
- indexes and summaries inherit capability labels so retrieval results are
  filtered before being shown to the model

## Phased plan

### Phase 0 — document and protect current behavior

- [x] Current Telegram service exists.
- [x] Subagent manager exists.
- [x] Loops/monitors exist.
- [x] Basic steering/cancel exists.
- [x] Behavior packs exist.
- [x] Fast mode support is present.
- [x] Existing Brain/runtime planning notes exist in the local system.
- [x] Add this architecture plan to `plans/`.
- [x] Inventory Telegram-shaped types that must become adapter-neutral. See `docs/telegram-runtime-baseline.md`.
- [x] Add tests around current Telegram behavior before refactoring. See `src/__tests__/telegram-baseline.test.ts` plus existing Telegram/service/introspection coverage.

### Phase 1 — introduce shared runtime types behind Telegram

- [x] Add `ActorContext`, `OutputTarget`, `RunContext`, `ConversationKey`,
      `ConversationSession`, `CapabilityGrant`, and `ProgressEvent` TypeScript
      types.
- [x] Wrap current Telegram inbound handling into `ActorContext` and
      `OutputTarget` without changing user behavior.
- [x] Create/resume Telegram conversation sessions by chat ID and
      `message_thread_id`/forum topic where available.
- [x] Route current Telegram sends through `OutputTarget`.
- [x] Add correlation IDs to inbound events, runs, subagents, directives, and
      outputs.
- [x] Represent Tim/current allowed Telegram users as explicit capability grants.
- [x] Add capability-check helper APIs with permissive personal/admin grants for
      existing Telegram flows.

### Phase 2 — capability enforcement and audit spine

- [ ] Define canonical capability IDs/descriptions.
- [ ] Enforce checks at every runtime-owned tool call and output send.
- [ ] Add audit records for grants, checks, tool calls, outputs, and denials.
- [ ] Add temporary capability flow for chat/channel-scoped approvals.
- [ ] Replace long-term JSON capability state with a real durable store plan and
      migration path.
- [ ] Ensure subagents receive narrowed run context, not tokens or broad grants.

### Phase 3 — Slack adapter MVP

- [ ] Add Slack app config and secret metadata checks without exposing token
      values.
- [ ] Implement Events API verification, idempotency, fast ack, and queueing.
- [ ] Normalize app mentions and DMs into shared runtime events.
- [ ] Create/resume thread-scoped sessions for channel app mentions and
      conversation-scoped sessions for DMs/MPIM/private groups.
- [ ] Resolve Slack user/channel metadata as adapter metadata.
- [ ] Implement Slack renderer for source-thread replies and final answers.
- [ ] Implement progress message updates from `ProgressEvent`s.
- [ ] Add Slack read tools for source context and selected channel reads.
- [ ] Add Slack write tools for source replies and explicit target posts.
- [ ] Add tests with fixture events and no live network calls by default.

### Phase 4 — cross-surface company brain operations

- [ ] Allow Telegram-originated company-brain reads/searches over Slack when
      capability grants allow it.
- [ ] Allow Telegram-originated Slack posts only with explicit target routing and
      write grants.
- [ ] Add Slack-originated Telegram/admin notifications where appropriate and
      authorized.
- [ ] Add retrieval/index filtering by capability labels before model exposure.
- [ ] Add persisted summaries for Slack threads/channels and repeated topics.
- [ ] Add context compression policies for long company runs.

### Phase 5 — Clerk-authenticated admin dashboard and approval UX

- [ ] Build the admin/dashboard app as a Clerk-authenticated internal surface
      with server-side allowed-user enforcement.
- [ ] Require at least one configured allowed dashboard user; if the allowlist is
      empty or missing, deny all dashboard access.
- [ ] Build users/actors view, including allowed dashboard users and their
      identity mappings.
- [ ] Build Slack channel and Telegram chat mapping view.
- [ ] Build capability bundle UI so admins can set common capability bundles on
      users while preserving auditable individual grants.
- [ ] Build capability grant/revocation UI for inspecting and editing individual
      abilities created directly or by bundles.
- [ ] Build audit viewer.
- [ ] Build running jobs/subagents/Employees view with cancel/steer buttons.
- [ ] Add AI-assisted capability assignment proposals with human confirmation.
- [ ] Add Slack button-click approvals for temporary capabilities.
- [ ] Mirror sensitive admin operations through Telegram admin commands where
      useful.

### Phase 6 — central server and scale-out subagents

- [ ] Centralize event ingestion, queueing, progress fanout, audits, and indexes.
- [ ] Add durable session registry with hibernation, scheduler wakeups, max
      active leases, and per-workspace/per-surface rate and cost limits.
- [ ] Support many subagent workers with per-run narrowed contexts.
- [ ] Persist run summaries, source summaries, and artifacts.
- [ ] Add retrieval/index maintenance jobs for Slack and Telegram history.
- [ ] Add operational dashboards for worker health, queue depth, stuck runs, and
      capability-denial rates.
- [ ] Run live canaries with Slack-only, Telegram-only, and cross-surface tasks.

## Avoid

- Do not bolt Slack onto Telegram-shaped types.
- Do not run one global main context for unrelated conversations.
- Do not create immortal per-channel model contexts when hibernated
  conversation sessions and channel summaries suffice.
- Do not trust Slack ACLs alone; use runtime capabilities and audit checks.
- Do not expose Slack bot/user tokens to the main Codex prompt or subagents.
- Do not run long Codex turns inline in Slack event handlers; fast-ack and queue.
- Do not infer output routing implicitly when crossing surfaces; require explicit
  `OutputTarget`s and write capabilities.
- Do not give subagents broad company-wide access by default.
- Do not keep company-mode capability state in JSON long-term.
- Do not let prompt instructions be the only enforcement layer for capabilities.
- Do not make Telegram a privileged bypass; represent privilege as explicit
  admin/personal grants.
- Do not index or summarize private channels without capability labels that are
  enforced before retrieval results reach the model.

## Open questions

- Which durable store should back capability grants, audit records, and channel
  mappings for the first production version?
- Which Slack installation model is needed first: single workspace, Enterprise
  Grid, or multiple independent workspaces?
- Should Slack channel grants be bootstrapped from Slack membership/admin data or
  only from explicit dashboard approvals?
- What approval threshold is required before Telegram-originated requests can
  post into Slack channels?
- How should company-brain summaries age, expire, and get revalidated against
  changed channel membership or revoked grants?
