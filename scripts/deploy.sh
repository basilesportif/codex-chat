#!/usr/bin/env bash
# codex-chat self-update script.
#
# Invoked (detached) by the running service when the user types "update",
# "deploy", "redeploy", or similar in Telegram. Pulls latest, rebuilds,
# writes a deploy marker, and asks systemd to restart codex-chat. The
# restarted service consumes the marker and tells the user "Redeployed
# successfully. Running commit <hash>." in their chat.
#
# The script communicates with Telegram directly via curl using the bot
# token in the systemd EnvironmentFile so progress + failure messages are
# delivered even if the service is mid-restart or failed to start.
#
# Usage: deploy.sh <repo_dir> <state_dir> <chat_id> [reply_message_id]
#
# The script never restarts on build failure — it sends the error to
# Telegram and exits non-zero, leaving the existing service running.

set -u
set -o pipefail

REPO_DIR="${1:-}"
STATE_DIR="${2:-}"
CHAT_ID="${3:-}"
REPLY_TO="${4:-}"

if [[ -z "$REPO_DIR" || -z "$STATE_DIR" || -z "$CHAT_ID" ]]; then
  echo "usage: deploy.sh <repo_dir> <state_dir> <chat_id> [reply_message_id]" >&2
  exit 2
fi

mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/deploy.log"
MARKER_FILE="$STATE_DIR/deploy-marker.json"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

ENV_FILE="${CODEX_CHAT_ENV_FILE:-$HOME/.config/codex-chat/env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

tg_send() {
  local text="$1"
  if [[ -z "$BOT_TOKEN" ]]; then
    log "tg_send skipped (no TELEGRAM_BOT_TOKEN): $text"
    return 0
  fi
  curl -sS --max-time 15 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    >> "$LOG_FILE" 2>&1 || log "tg_send curl failed for: $text"
  echo >> "$LOG_FILE"
}

write_marker() {
  local status="$1"
  local commit_before="$2"
  local commit_after="$3"
  local message="$4"
  local started_at="$5"
  local tmp
  tmp="$(mktemp "${MARKER_FILE}.XXXXXX")"
  cat > "$tmp" <<JSON
{
  "status": "$status",
  "chatId": $CHAT_ID,
  "replyToMessageId": ${REPLY_TO:-null},
  "commitBefore": "$commit_before",
  "commitAfter": "$commit_after",
  "message": $(printf '%s' "$message" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$message"),
  "startedAt": "$started_at",
  "finishedAt": "$(ts)"
}
JSON
  mv "$tmp" "$MARKER_FILE"
}

cd "$REPO_DIR" || { log "cd $REPO_DIR failed"; tg_send "Deploy failed: cannot cd to $REPO_DIR."; exit 1; }

START_TS="$(ts)"
log "deploy starting in $REPO_DIR (chat=$CHAT_ID, reply_to=$REPLY_TO)"

COMMIT_BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "commit_before=$COMMIT_BEFORE"

# git pull
if ! GIT_PULL_OUT=$(git pull --ff-only 2>&1); then
  log "git pull failed: $GIT_PULL_OUT"
  write_marker "failed" "$COMMIT_BEFORE" "$COMMIT_BEFORE" "git pull failed: ${GIT_PULL_OUT}" "$START_TS"
  tg_send "Deploy failed during git pull:\n$GIT_PULL_OUT"
  exit 1
fi
log "git pull: $GIT_PULL_OUT"

COMMIT_AFTER="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
log "commit_after=$COMMIT_AFTER"

if [[ "$COMMIT_BEFORE" == "$COMMIT_AFTER" ]]; then
  log "no changes pulled; rebuilding anyway in case of dist drift"
fi

# Optional dependency install if package manifests changed
if git diff --name-only "$COMMIT_BEFORE" "$COMMIT_AFTER" 2>/dev/null | grep -qE '^(package\.json|pnpm-lock\.yaml|bun\.lock|bun\.lockb)$'; then
  log "dependency manifests changed; running install"
  if command -v pnpm >/dev/null 2>&1; then
    if ! INSTALL_OUT=$(pnpm install --frozen-lockfile 2>&1); then
      log "pnpm install failed: $INSTALL_OUT"
      write_marker "failed" "$COMMIT_BEFORE" "$COMMIT_AFTER" "pnpm install failed: ${INSTALL_OUT}" "$START_TS"
      tg_send "Deploy failed during pnpm install:\n$(echo "$INSTALL_OUT" | tail -c 1500)"
      exit 1
    fi
  elif command -v bun >/dev/null 2>&1; then
    if ! INSTALL_OUT=$(bun install --frozen-lockfile 2>&1); then
      log "bun install failed: $INSTALL_OUT"
      write_marker "failed" "$COMMIT_BEFORE" "$COMMIT_AFTER" "bun install failed: ${INSTALL_OUT}" "$START_TS"
      tg_send "Deploy failed during bun install:\n$(echo "$INSTALL_OUT" | tail -c 1500)"
      exit 1
    fi
  fi
  log "install: $INSTALL_OUT"
fi

# Build
BUILD_CMD=""
if command -v bun >/dev/null 2>&1; then
  BUILD_CMD="bun run build"
elif command -v pnpm >/dev/null 2>&1; then
  BUILD_CMD="pnpm run build"
else
  BUILD_CMD="npm run build"
fi
log "building with: $BUILD_CMD"
if ! BUILD_OUT=$($BUILD_CMD 2>&1); then
  log "build failed: $BUILD_OUT"
  write_marker "failed" "$COMMIT_BEFORE" "$COMMIT_AFTER" "build failed: ${BUILD_OUT}" "$START_TS"
  tg_send "Deploy failed during build (commit $COMMIT_AFTER):\n$(echo "$BUILD_OUT" | tail -c 1500)"
  exit 1
fi
log "build ok"

# Mark as successful BEFORE restarting; the restarted service will read it.
write_marker "success" "$COMMIT_BEFORE" "$COMMIT_AFTER" "deploy succeeded" "$START_TS"

# Restart via systemd. systemctl --user requires DBUS to talk to the user
# manager — preserve any existing XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS
# from the calling environment, otherwise fall back to /run/user/<uid>.
if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/run/user/$(id -u)"
fi
log "restarting codex-chat.service"
if ! RESTART_OUT=$(systemctl --user restart codex-chat.service 2>&1); then
  log "systemctl restart failed: $RESTART_OUT"
  # Update marker so the (possibly still-running) old service can see the
  # failure on its next startup if the operator manually restarts.
  write_marker "restart_failed" "$COMMIT_BEFORE" "$COMMIT_AFTER" "systemctl restart failed: ${RESTART_OUT}" "$START_TS"
  tg_send "Deploy built OK (commit $COMMIT_AFTER) but systemctl restart failed:\n$RESTART_OUT"
  exit 1
fi
log "restart requested; deploy.sh exiting"
