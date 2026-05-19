# Measuring isolated `codex app-server` memory

Use `scripts/measure-app-server-memory.js` for local, one-off memory probes of
isolated `codex app-server` processes. The script does **not** start or modify
the `codex-chat` service or runtime backend.

## Examples

Baseline idle process:

```bash
node scripts/measure-app-server-memory.js \
  --parallel 1 \
  --duration-sec 30 \
  --samples 10 \
  --turn-type idle
```

Two isolated servers with one simple controlled turn each:

```bash
node scripts/measure-app-server-memory.js \
  --parallel 2 \
  --duration-sec 90 \
  --samples 12 \
  --turn-type simple
```

Sleep workload, intended to keep a turn active during sampling:

```bash
node scripts/measure-app-server-memory.js \
  --parallel 1 \
  --duration-sec 60 \
  --samples 8 \
  --turn-type sleep \
  --sleep-sec 45
```

If a previous run was interrupted and left processes behind, clean them up from
its JSON report:

```bash
node scripts/measure-app-server-memory.js \
  --cleanup-only data/reports/app-server-memory/<run>.json
```

## Output

Each run writes two files under `data/reports/app-server-memory/`:

- `<timestamp>-<runId>.json` — full options, PID/process tree, per-sample PSS/RSS,
  process logs tail, turn status, and cleanup/orphan check result.
- `<timestamp>-<runId>.summary.txt` — concise human-readable peak/final memory
  summary and cleanup status.

PSS is read from `/proc/<pid>/smaps_rollup` when available. RSS uses the same
file when possible and falls back to `/proc/<pid>/status` or `/proc/<pid>/statm`.
Memory is summed across the spawned app-server process tree.

## Cleanup behavior

By default, the script spawns each app-server in its own process group and kills
those process groups on normal exit, error, `SIGINT`, or `SIGTERM`. It then scans
`/proc` for the run marker, known PIDs, and listen URLs to verify no matching test
processes remain. Use `--no-cleanup` only for debugging, and prefer
`--cleanup-only <report.json>` afterward.

Run `node scripts/measure-app-server-memory.js --help` for the complete option
list.
