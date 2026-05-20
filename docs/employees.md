# Durable Employee Runtime Scaffold

Date: 2026-05-20

Employees are durable, directory-backed Codex app-server workers for named
responsibilities. This repo implements a minimal runtime scaffold: Employees can
own non-ephemeral Codex app-server threads, while rich tools and account/project
mutations remain intentionally out of scope.

## What exists now

- Config model under `[employees]` and `[employees.<id>]`.
- Per-Employee configurable directory, enabled flag, description,
  profile/model/effort,
  startup mode, warmup prompt/file, Git fields, memory and compaction policy
  placeholders, and capability/ACL placeholders.
- State/proposal/thread metadata persistence under
  `data/state/employees/<id>.json`.
- Runtime start/resume uses Codex `thread/start` / `thread/resume` with
  `ephemeral: false` on start and `persistExtendedHistory: true`.
- On service restart, Employees that were `running` (and Employees configured with
  `startup = "always"`) attempt to resume their saved `backendThreadId`. If
  resume fails, the service starts a fresh thread and records `lastResumeError`
  / `lastError` in the Employee state.
- Telegram commands: `employees`, `employee status <id>`, `employee start <id>`,
  `employee stop <id>`, `employee steer <id> <text>`.
- CLI commands: `codex-chat employees list`, `codex-chat employees status <id>`,
  `codex-chat employees start|stop|steer`, and
  `codex-chat employees propose <id> <action> [text]`.
- Every main Codex turn receives a compact `Available employees` snapshot with
  id/name, status, running/resumable state, profile/model/effort, purpose, and
  command guidance.
- Employee service-action envelopes let a running Employee request
  `request_subagent`, `cancel_subagent`, and `steer_subagent` actions. These are
  validated against the Employee's capabilities and executed only by the central
  SubagentManager.
- Employee-owned child subagents carry owner/result metadata
  (`owner=employee:<id>`, `ownerRequestId`, `parentTurnId`,
  `resultTarget=employee`). Terminal child results are delivered as a new
  Employee turn; if the Employee runtime is not running/resumable or is busy,
  the result is stored and shown in Employee status.
- Stopping an Employee cascades cancellation to active child subagents owned by
  that Employee with reason `employee_stopped`.

When Employees are disabled, or when a management surface has no runtime client
attached, start/stop/steer fall back to proposal recording.

Legacy `[factors]` config and `factor ...` command aliases are accepted for
backward compatibility, but Employee terminology is canonical.

## Safety boundaries

- `employees.enabled = false` by default.
- Only minimal thread runtime exists. No rich tools are exposed.
- No external email/calendar/account calls are implemented.
- No project, todo, CRM, calendar, or canonical assistant workspace mutation is
  performed by Employee code.
- Employee-owned files must live in the configured Employee directory. The service
  stores only runtime/proposal metadata under `data/state/employees/`.
- Employees must not spawn or own subagents directly. They can only request
  centrally-managed child jobs through service actions, and they can cancel or
  steer only their own child jobs unless an admin/main service path intervenes.
- Raw logs and personal data persistence are disabled/conservative by default;
  the current fields are placeholders for a reviewed policy.
- Regular subagents are unchanged: app-server subagents use `ephemeral: true`,
  do not request `persistExtendedHistory`, and are marked abandoned rather than
  resumed after restart.

## Directory contract

A future Employee directory should follow this shape:

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

Status validation reports missing paths. Starting a runtime may create the
configured Employee root directory as the Codex thread `cwd`, but it does not
create or overwrite the directory contract contents automatically.

## Before a real email/calendar pilot

1. Add reviewed account connectors and explicit no-mutation/default-proposal
   behavior.
2. Define redaction, retention, delete/forget, and Git persistence policies.
3. Add runtime tests with fake app-server/account backends before any real
   external account calls.
4. Keep rollback simple: turn `employees.enabled = false` and restart the service.
