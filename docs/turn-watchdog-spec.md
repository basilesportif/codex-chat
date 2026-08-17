# Turn watchdog + context rollover — behavioral invariants

Status: acceptance spec for the 2026-08-17 overhaul. Every invariant here must
hold in code and be pinned by at least one test that would fail if it broke.
When code and this spec disagree, fix one and say which.

## Definitions

- **Attributable traffic**: an SDK event that belongs to the *currently active
  turn* — parent-session messages, tool_use/tool_result, nested-agent messages
  streamed through the parent query, tool_progress (including heartbeats) for
  tool calls started by this turn, and background_tasks_changed for tasks this
  turn launched. Events from tasks launched by *previous* turns are not
  attributable.
- **Silent**: zero attributable traffic for the whole inactivity window.
- **Wedge evidence**: any of (a) rollover already armed, (b) last known
  occupancy ≥ rollover threshold, (c) N consecutive silent aborts of the same
  persisted session (N = turnSilentAbortsBeforeSessionReset), (d) M consecutive
  absolute-ceiling aborts of the same session with no completed turn between.

## Invariants

### Watchdog
- **W1 — progress is immortal (up to the ceiling).** A turn producing
  attributable traffic is never aborted before turnAbsoluteAbortMs.
- **W2 — silence dies on schedule.** A turn with no attributable traffic for
  turnInactivityAbortMs is aborted then, ±one check interval.
- **W3 — long quiet tool calls are ALIVE.** A single tool call (e.g. a 5-minute
  Bash with no stdout) running under the active turn must survive: its
  tool_progress heartbeats ARE attributable traffic. The defense against
  "chatty but wedged" is turn-scoped attribution (a leftover background task
  from a prior turn does not count) plus the absolute ceiling — NOT heartbeat
  exclusion. If the implementation currently excludes heartbeats, that is a
  spec violation; fix it and pin with a test: active turn, one tool call,
  heartbeats only, > inactivity window → no abort.
- **W4 — the ceiling is unconditional.** turnAbsoluteAbortMs fires regardless
  of activity or suspension. (Codex mode has no absolute-ceiling path at all —
  its unchanged 80s wall clock is strictly tighter.)

### Session preservation
- **W5 — slow ≠ dead.** An abort without wedge evidence relaunches the SDK
  child and keeps the persisted session. The user is told context was kept.
- **W6 — wedges actually recover.** An abort with wedge evidence clears the
  persisted session, and the user is told context was reset. Every wedge shape
  we know (2026-08-07 silent wedge; chatty wedge via prior-turn background
  noise; near-full resumed session after restart) must reach clearing in ≤ 2
  abort cycles. No infinite abort→resume loop may exist.
- **W7 — evidence is session-scoped.** Abort counters reset on session change,
  session clear, provider switch, and any normally-completed turn. An absolute
  abort with attributable activity resets the silent counter. A lazily-captured
  session id (undefined → defined on first turn) is not a "session change".

### Suspension (rollover restart)
- **W8 — suspension is bounded and sufficient.** The watchdog suspension around
  rollover stop()/start() self-expires no matter what hangs beneath it, and its
  budget covers the worst LEGITIMATE case: interruptTimeoutSec +
  startupTimeoutSec + margin. It must never expire mid-way through a
  still-progressing legitimate restart (else the watchdog kills the recovery it
  exists to protect).
- **W9 — a timed-out interrupt still yields a usable process.** If interrupt()
  exceeds interruptTimeoutSec, disposal proceeds; the subsequent start() gets a
  clean slate (no leaked child preventing relaunch).

### Occupancy metric
- **W10 — occupancy means one request.** Occupancy = the most recent parent
  (parent_tool_use_id === null) request's input + cache_read + cache_creation.
  Last-write-wins; never a max; never a cross-request sum; nested-agent usage
  never included.
- **W11 — occupancy survives restarts and never silently dies.** Persisted with
  the session id and re-seeded on resume. If a completed turn yields no
  occupancy signal, a rate-limited warning event fires — going dark is loud.
- **W12 — thresholds reference the real window.** contextRolloverInputTokens /
  hard cap are meaningful fractions of the model's actual context window
  (from modelUsage contextWindow), and the config comment says so.

### Rollover debt
- **W13 — debt is indestructible.** Once a rollover is owed, no path loses it:
  restart before the swap, summarizer in flight, summarizer crash, artifact
  older than its summary expiry, orphaned pending record. Expiry may drop the
  SUMMARY (fresh session starts briefless) but never the debt.
- **W14 — the boundary never blocks.** Awaiting the artifact write at a turn
  boundary is bounded by the fs write; no path leaves an unresolved promise a
  turn can wait on.

### Provider parity
- **W15 — Codex mode is byte-identical.** Wall-clock 80s semantics, message
  strings, ops text, log line, session key, unconditional clear, restart
  reason: all unchanged. Pinned by tests that assert the strings, not the
  plumbing. A Claude-mode provider reporting no watchdog state gets the same
  wall-clock fallback.

### Truthfulness
- **W16 — messages match reality.** "Context kept" is only said when the
  session was kept; "context reset" only when cleared. turn_force_abort logs
  carry abortKind, inactiveMs/limit, activityEvents, sessionCleared + reason,
  occupancy + contextWindowTokens — enough to diagnose the next incident from
  journal alone.

## Deploy checklist (operator)

1. Full suite + tsc clean; this spec's invariants each traceable to a test.
2. node_modules consistency vs package.json (MODULE_NOT_FOUND gotcha,
   2026-07-31): verify @anthropic-ai/claude-agent-sdk resolves.
3. Build (`npm run build` or repo equivalent); confirm dist/ mtime advances.
4. Inspect data/state/codex_sessions.json — schema must still parse with the
   new lastInputTokens field absent (old format) and present.
5. Restart codex-chat; confirm journal startup clean, no MODULE_NOT_FOUND, no
   handoff_summary_orphaned unless expected.
6. Live canary (recipe in docs/claude-main-loop.md / memory): one trivial turn
   completes; journal shows no turn_force_abort; watchdog fields present on
   turn logs where emitted.
7. Watch the first real long turn: expect NO abort while tools stream, and
   turn_force_abort only with abortKind + sessionCleared fields if one fires.
