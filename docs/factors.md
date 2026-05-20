# Durable Factor Runtime Scaffold

Date: 2026-05-20

Factors are durable, directory-backed Codex app-server workers for named
responsibilities. This repo implements a minimal runtime scaffold: Factors can
own non-ephemeral Codex app-server threads, while rich tools and account/project
mutations remain intentionally out of scope.

## What exists now

- Config model under `[factors]` and `[factors.<id>]`.
- Per-Factor configurable directory, enabled flag, description,
  profile/model/effort,
  startup mode, warmup prompt/file, Git fields, memory and compaction policy
  placeholders, and capability/ACL placeholders.
- State/proposal/thread metadata persistence under
  `data/state/factors/<id>.json`.
- Runtime start/resume uses Codex `thread/start` / `thread/resume` with
  `ephemeral: false` on start and `persistExtendedHistory: true`.
- On service restart, Factors that were `running` (and Factors configured with
  `startup = "always"`) attempt to resume their saved `backendThreadId`. If
  resume fails, the service starts a fresh thread and records `lastResumeError`
  / `lastError` in the Factor state.
- Telegram commands: `factors`, `factor status <id>`, `factor start <id>`,
  `factor stop <id>`, `factor steer <id> <text>`.
- CLI commands: `codex-chat factors list`, `codex-chat factors status <id>`,
  `codex-chat factors start|stop|steer`, and
  `codex-chat factors propose <id> <action> [text]`.
- Every main Codex turn receives a compact `Available factors` snapshot with
  id/name, status, running/resumable state, profile/model/effort, purpose, and
  command guidance.

When Factors are disabled, or when a management surface has no runtime client
attached, start/stop/steer fall back to proposal recording.

## Safety boundaries

- `factors.enabled = false` by default.
- Only minimal thread runtime exists. No rich tools are exposed.
- No external email/calendar/account calls are implemented.
- No project, todo, CRM, calendar, or canonical assistant workspace mutation is
  performed by Factor code.
- Factor-owned files must live in the configured Factor directory. The service
  stores only runtime/proposal metadata under `data/state/factors/`.
- Raw logs and personal data persistence are disabled/conservative by default;
  the current fields are placeholders for a reviewed policy.
- Regular subagents are unchanged: app-server subagents use `ephemeral: true`,
  do not request `persistExtendedHistory`, and are marked abandoned rather than
  resumed after restart.

## Directory contract

A future Factor directory should follow this shape:

```text
<factor-dir>/
  AGENTS.md
  README.md
  factor.json
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
configured Factor root directory as the Codex thread `cwd`, but it does not
create or overwrite the directory contract contents automatically.

## Before a real email/calendar pilot

1. Add reviewed account connectors and explicit no-mutation/default-proposal
   behavior.
2. Define redaction, retention, delete/forget, and Git persistence policies.
3. Add runtime tests with fake app-server/account backends before any real
   external account calls.
4. Keep rollback simple: turn `factors.enabled = false` and restart the service.
