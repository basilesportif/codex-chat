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

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [[ -z "$current_branch" ]]; then
  printf 'workspace-git-push failed: HEAD is detached; refusing to auto-commit and push\n' >&2
  exit 1
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
if [[ -z "$upstream" ]]; then
  printf 'workspace-git-push failed: branch %s has no upstream; set one before using this loop\n' "$current_branch" >&2
  exit 1
fi

quiet_run git fetch --quiet

read -r ahead behind < <(git rev-list --left-right --count HEAD..."$upstream")
if (( behind > 0 )); then
  printf 'workspace-git-push failed: branch %s is %s commit(s) ahead and %s commit(s) behind %s; reconcile manually before pushing\n' "$current_branch" "$ahead" "$behind" "$upstream" >&2
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  exit 0
fi

shortstat="$(git diff --cached --shortstat | sed 's/^[[:space:]]*//')"

quiet_run git commit -m "chore: sync workspace changes $(ts)"
quiet_run git push

printf 'workspace-git-push ran: committed and pushed %s\n' "$shortstat"
