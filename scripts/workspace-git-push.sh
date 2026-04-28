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

rebase_in_progress() {
  [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]
}

stashed=0
if [[ -n "$(git status --porcelain)" ]]; then
  quiet_run git stash push --include-untracked -m "workspace-git-push autostash $(ts)"
  stashed=1
fi

restore_stash_after_failed_pull() {
  if (( stashed == 0 )); then
    return 0
  fi

  if rebase_in_progress; then
    quiet_run git rebase --abort || return 1
  fi

  quiet_run git stash pop
}

if ! quiet_run git pull --rebase; then
  restore_stash_after_failed_pull || true
  exit 1
fi

if (( stashed == 1 )); then
  quiet_run git stash pop
fi

git add -A

if git diff --cached --quiet; then
  exit 0
fi

shortstat="$(git diff --cached --shortstat | sed 's/^[[:space:]]*//')"

quiet_run git commit -m "chore: sync workspace changes $(ts)"
quiet_run git push

printf 'workspace-git-push ran: committed and pushed %s\n' "$shortstat"
