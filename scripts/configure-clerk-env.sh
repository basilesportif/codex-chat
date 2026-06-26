#!/usr/bin/env bash
# Prompt for Clerk values, update the codex-chat systemd EnvironmentFile,
# and restart the user service.
#
# Run from a local terminal with a TTY:
#   ssh -t codex-chat 'cd ~/pkg/tim/codex-chat && git pull --ff-only origin main && scripts/configure-clerk-env.sh'

set -Eeuo pipefail

ENV_FILE="${CODEX_CHAT_ENV_FILE:-$HOME/.config/codex-chat/env}"
SERVICE_NAME="${CODEX_CHAT_SERVICE_NAME:-codex-chat.service}"
DEFAULT_ADMIN_PUBLIC_BASE_URL="https://brain.decisive-outcomes.com"
DEFAULT_ADMIN_ROUTE_PATH="/admin"
DEFAULT_SIGN_IN_PATH="/admin/auth/sign-in"
ALLOWED_EMAILS="timgalebachukraine@gmail.com,tim.galebach@gmail.com"

DROP_KEYS=(
  CLERK_PUBLISHABLE_KEY
  CLERK_SECRET_KEY
  CLERK_SIGN_IN_URL
  CODEX_CHAT_ADMIN_ENABLED
  CODEX_CHAT_ADMIN_PUBLIC_BASE_URL
  CODEX_CHAT_ADMIN_ROUTE_PATH
  CLERK_ALLOWED_EMAILS
)

fail() {
  echo "error: $*" >&2
  exit 1
}

require_tty() {
  [[ -t 0 ]] || fail "interactive terminal required; run with ssh -t"
}

read_required() {
  local prompt="$1"
  local value=""
  while [[ -z "$value" ]]; do
    read -r -p "$prompt: " value
    value="${value%$'\r'}"
    [[ -n "$value" ]] || echo "Value is required." >&2
  done
  printf '%s' "$value"
}

read_required_secret() {
  local prompt="$1"
  local value=""
  while [[ -z "$value" ]]; do
    read -r -s -p "$prompt (input hidden): " value
    echo >&2
    value="${value%$'\r'}"
    [[ -n "$value" ]] || echo "Value is required." >&2
  done
  printf '%s' "$value"
}

validate_env_value() {
  local name="$1"
  local value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$name may not contain newlines"
  [[ "$value" != *"'"* ]] || fail "$name may not contain a single quote"
}

quote_env_value() {
  local value="$1"
  printf "'%s'" "$value"
}

write_env_line() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$(quote_env_value "$value")"
}

write_env_file() {
  local publishable_key="$1"
  local secret_key="$2"
  local admin_public_base_url="$3"
  local admin_route_path="$4"
  local sign_in_url="$5"
  local env_dir tmp
  env_dir="$(dirname "$ENV_FILE")"
  mkdir -p "$env_dir"
  tmp="$(mktemp "$env_dir/.env.tmp.XXXXXX")"
  chmod 600 "$tmp"

  if [[ -f "$ENV_FILE" ]]; then
    awk -v keys="$(IFS=,; echo "${DROP_KEYS[*]}")" '
      BEGIN {
        n = split(keys, parts, ",")
        for (i = 1; i <= n; i++) drop[parts[i]] = 1
      }
      {
        original = $0
        line = $0
        sub(/^[[:space:]]*export[[:space:]]+/, "", line)
        key = line
        sub(/[[:space:]]*=.*/, "", key)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
        if (!(key in drop)) print original
      }
    ' "$ENV_FILE" > "$tmp"
  fi

  {
    echo
    echo "# Clerk admin auth for codex-chat"
    write_env_line "CODEX_CHAT_ADMIN_ENABLED" "true"
    write_env_line "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL" "$admin_public_base_url"
    write_env_line "CODEX_CHAT_ADMIN_ROUTE_PATH" "$admin_route_path"
    write_env_line "CLERK_PUBLISHABLE_KEY" "$publishable_key"
    write_env_line "CLERK_SECRET_KEY" "$secret_key"
    write_env_line "CLERK_SIGN_IN_URL" "$sign_in_url"
    write_env_line "CLERK_ALLOWED_EMAILS" "$ALLOWED_EMAILS"
  } >> "$tmp"

  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

restart_service() {
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
  fi

  echo "Restarting $SERVICE_NAME..."
  systemctl --user restart "$SERVICE_NAME"
  systemctl --user is-active --quiet "$SERVICE_NAME"
  echo "$SERVICE_NAME is active."
}

main() {
  require_tty
  echo "This updates $ENV_FILE, preserves unrelated lines, and restarts $SERVICE_NAME."

  local publishable_key secret_key admin_public_base_url admin_route_path sign_in_url default_sign_in_path default_sign_in_url
  publishable_key="$(read_required "CLERK_PUBLISHABLE_KEY")"
  secret_key="$(read_required_secret "CLERK_SECRET_KEY")"
  read -r -p "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL [$DEFAULT_ADMIN_PUBLIC_BASE_URL]: " admin_public_base_url
  admin_public_base_url="${admin_public_base_url%$'\r'}"
  admin_public_base_url="${admin_public_base_url:-$DEFAULT_ADMIN_PUBLIC_BASE_URL}"
  read -r -p "CODEX_CHAT_ADMIN_ROUTE_PATH [$DEFAULT_ADMIN_ROUTE_PATH]: " admin_route_path
  admin_route_path="${admin_route_path%$'\r'}"
  admin_route_path="${admin_route_path:-$DEFAULT_ADMIN_ROUTE_PATH}"
  default_sign_in_path="${admin_route_path%/}/auth/sign-in"
  default_sign_in_url="${admin_public_base_url%/}$default_sign_in_path"
  read -r -p "CLERK_SIGN_IN_URL [$default_sign_in_url]: " sign_in_url
  sign_in_url="${sign_in_url%$'\r'}"
  sign_in_url="${sign_in_url:-$default_sign_in_url}"

  validate_env_value "CLERK_PUBLISHABLE_KEY" "$publishable_key"
  validate_env_value "CLERK_SECRET_KEY" "$secret_key"
  validate_env_value "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL" "$admin_public_base_url"
  validate_env_value "CODEX_CHAT_ADMIN_ROUTE_PATH" "$admin_route_path"
  validate_env_value "CLERK_SIGN_IN_URL" "$sign_in_url"
  validate_env_value "CLERK_ALLOWED_EMAILS" "$ALLOWED_EMAILS"

  [[ "$admin_public_base_url" == http://* || "$admin_public_base_url" == https://* ]] || fail "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL must be an absolute URL"
  [[ "$admin_route_path" == /* ]] || fail "CODEX_CHAT_ADMIN_ROUTE_PATH must start with /"
  [[ "$sign_in_url" == http://* || "$sign_in_url" == https://* || "$sign_in_url" == /* ]] || fail "CLERK_SIGN_IN_URL must be absolute or root-relative"

  write_env_file "$publishable_key" "$secret_key" "$admin_public_base_url" "$admin_route_path" "$sign_in_url"
  echo "Updated $ENV_FILE with Clerk admin settings."
  restart_service
}

main "$@"
