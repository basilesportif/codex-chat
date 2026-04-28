#!/usr/bin/env bash
# Commit and push all changes in the current Git workspace.

set -euo pipefail

ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

quiet_run() {
  local output
  if ! output="$("$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
}

git add -A

if git diff --cached --quiet; then
  exit 0
fi

shortstat="$(git diff --cached --shortstat | sed 's/^[[:space:]]*//')"

quiet_run git commit -m "chore: sync workspace changes $(ts)"
quiet_run git push

printf 'workspace-git-push ran: committed and pushed %s\n' "$shortstat"
