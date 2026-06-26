# Codex Chat Slack App

This directory is the installable Slack application surface for the Phase 2
`codex-chat` Slack adapter. It is product configuration, not a throwaway test
fixture: the manifest declares the bot, OAuth scopes, Events API subscriptions,
and request path that deliver Slack workspace/team/app/channel/user/thread/event
metadata into `src/slack.ts`.

Secrets are never stored here. Use placeholders in committed templates and keep
real signing secrets and tokens in the service environment.

## Files

- `manifest.json` — Slack app manifest template for the HTTP Events API adapter.
- `install-metadata.example.json` — non-secret metadata to capture after a real
  workspace install; copy it to a private location and fill in workspace/app/bot
  IDs for operations or future migrations.
- `codex-chat.slack.example.toml` — codex-chat config fragment that enables the
  Slack adapter and names the env vars used for secrets.
- `.env.example` — local/deployment env names for Slack secrets and adapter
  enablement.
- `scripts/validate-manifest.mjs` — dependency-free validation for this app
  surface's manifest and metadata template.

## Adapter mapping

Slack sends signed HTTP Events API requests to the manifest's
`settings.event_subscriptions.request_url`. `ApiGateway` receives those requests
at `config.slack.eventsPath` (default `/api/slack/events`) and calls
`normalizeSlackEventCallback` in `src/slack.ts`.

The Phase 2 adapter currently supports:

| Slack app surface | codex-chat behavior |
| --- | --- |
| `app_mention` in public channels | Starts/resumes a thread-scoped Slack conversation and strips the bot mention. |
| `message.im` | Starts/resumes a DM conversation. |
| `message.mpim` | Starts/resumes a MPIM conversation. |
| `message.groups` | Starts/resumes a private-channel conversation/thread when the bot is a member. |
| `chat:write` | Sends final text back through `SlackGateway.sendText` using the runtime `OutputTarget`. |

The normalized runtime event carries Slack IDs and timestamps in both shared
runtime objects and Slack-specific metadata, including team/workspace ID,
enterprise ID when present, app ID, event ID/time, channel ID/type, user ID, bot
user ID when present in authorizations, message timestamp, and thread timestamp.
These fields feed `ActorContext`, `OutputTarget`, `ConversationKey`, temporary
source-conversation grants, and audit/correlation IDs.

## Install/update the Slack app

Use this runbook for both first install and manifest updates. It keeps secrets
out of git and leaves a rendered, workspace-specific manifest in `/tmp`.

### 0. Set deployment variables

If you already know the public HTTPS origin for codex-chat, set it directly:

```bash
export CODEX_CHAT_BASE_URL="https://REPLACE-WITH-CODEX-CHAT-HOST"
export SLACK_EVENTS_PATH="/api/slack/events"
export SLACK_EVENTS_URL="${CODEX_CHAT_BASE_URL%/}${SLACK_EVENTS_PATH}"
```

If you do **not** know the host, discover the authoritative source/deploy
checkout first. The repo registry is metadata only; it does not store Slack
secrets. As of this writing it records the development checkout as
`tim@89.167.72.52:/home/tim/pkg/tim/codex-chat` and the legacy production
service as `tim@178.104.208.141:~/pkg/tim/codex-chat`, but verify before use:

```bash
grep -nA65 '^  codex-chat:' \
  /home/tim/.assistant-claude/workspace/.claude/repo-registry/index.yaml

export DEV_HOST="tim@89.167.72.52"
export DEV_PATH="/home/tim/pkg/tim/codex-chat"
export DEPLOY_HOST="tim@178.104.208.141"      # replace if registry changed
export DEPLOY_PATH="~/pkg/tim/codex-chat"     # replace if registry changed
export SERVICE_NAME="codex-chat.service"
export CODEX_CHAT_ENV_FILE="~/.config/codex-chat/env"
```

Then inspect the deployment for the reverse-proxy/domain without printing secret
values:

```bash
ssh "$DEPLOY_HOST" 'set -euo pipefail
printf "service: "; (systemctl --user is-active codex-chat.service || systemctl is-active codex-chat.service || true)
printf "listening ports:\n"; ss -ltn | grep -E ":(80|443|49346)\b" || true
printf "candidate proxy hostnames:\n"
sudo sh -c '\''grep -RhsE "server_name|reverse_proxy|codex-chat|49346" /etc/nginx /etc/caddy 2>/dev/null || true'\''
'
```

Set `CODEX_CHAT_BASE_URL` to the HTTPS URL that reaches the codex-chat API
through that proxy or tunnel. Slack requires HTTPS; the full Events API URL must
match the service path (`/api/slack/events` by default).

### 1. Render and validate the Slack manifest

Run from the repo root:

```bash
cd /home/tim/pkg/tim/codex-chat
: "${SLACK_EVENTS_URL:?set CODEX_CHAT_BASE_URL and SLACK_EVENTS_URL first}"

python3 - <<'PY_MANIFEST'
import json
import os
from pathlib import Path

src = Path("slack-app/manifest.json")
out = Path("/tmp/codex-chat.slack.manifest.json")
manifest = json.loads(src.read_text())
manifest["settings"]["event_subscriptions"]["request_url"] = os.environ["SLACK_EVENTS_URL"]
out.write_text(json.dumps(manifest, indent=2) + "\n")
print(out)
print(manifest["settings"]["event_subscriptions"]["request_url"])
PY_MANIFEST

node slack-app/scripts/validate-manifest.mjs /tmp/codex-chat.slack.manifest.json
```

Keep `slack-app/manifest.json` committed with the placeholder URL. Use the
rendered `/tmp/codex-chat.slack.manifest.json` in Slack.

### 2. Create or update the Slack app

In Slack's app admin UI:

1. Go to <https://api.slack.com/apps>.
2. For a new install, choose **Create New App** -> **From an app manifest**.
3. For an existing app, open the app -> **App Manifest**.
4. Paste the contents of `/tmp/codex-chat.slack.manifest.json`.
5. Save the manifest. For a first install, Slack URL verification can fail
   until the app signing secret is on the deployment server; collect secrets,
   restart codex-chat, then retry/save the Event Subscriptions page after
   Step 5.

If Slack still cannot verify the URL after restart, check that codex-chat is
deployed, the API listener is reachable through HTTPS, and the manifest URL
exactly matches the configured path.

### 3. Install to the workspace and collect secrets

Install or reinstall the app to the target workspace after saving the manifest.
Collect these values from Slack app admin pages, but do not paste them into git,
logs, or chat transcripts:

- **Basic Information** -> **Signing Secret** -> `SLACK_SIGNING_SECRET`
- **OAuth & Permissions** -> **Bot User OAuth Token** -> `SLACK_BOT_TOKEN`
  (`xoxb-...`)

Also capture non-secret IDs for operations by copying
`slack-app/install-metadata.example.json` to a private ops location and filling
in the workspace/team/app/bot IDs, installer, rollout channels, scopes, and
Events API URL.

### 4. Write codex-chat env/config on the deployment server

The Slack adapter can be enabled entirely from the deployment environment. This
command prompts for secrets interactively on the target server, preserves other
env-file lines, and writes only placeholders/config values into shell history:

```bash
ssh "$DEPLOY_HOST" 'set -euo pipefail
ENV_FILE="${CODEX_CHAT_ENV_FILE:-$HOME/.config/codex-chat/env}"
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

read -rsp "Slack signing secret: " SLACK_SIGNING_SECRET; echo >&2
read -rsp "Slack bot token (xoxb-...): " SLACK_BOT_TOKEN; echo >&2
export SLACK_SIGNING_SECRET SLACK_BOT_TOKEN

python3 - "$ENV_FILE" <<'\''PY_ENV'\''
import os
import shlex
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
updates = {
    "SLACK_SIGNING_SECRET": os.environ["SLACK_SIGNING_SECRET"],
    "SLACK_BOT_TOKEN": os.environ["SLACK_BOT_TOKEN"],
    "CODEX_CHAT_SLACK_ENABLED": "true",
    "CODEX_CHAT_SLACK_EVENTS_PATH": "/api/slack/events",
}
existing = path.read_text().splitlines() if path.exists() else []
seen = set()
lines = []
for line in existing:
    key = line.split("=", 1)[0].strip() if "=" in line and not line.lstrip().startswith("#") else None
    if key in updates:
        lines.append(f"{key}={shlex.quote(updates[key])}")
        seen.add(key)
    else:
        lines.append(line)
for key, value in updates.items():
    if key not in seen:
        lines.append(f"{key}={shlex.quote(value)}")
path.write_text("\n".join(lines).rstrip() + "\n")
PY_ENV

printf "wrote Slack env keys to %s\n" "$ENV_FILE"
grep -E "^(SLACK_|CODEX_CHAT_SLACK_)" "$ENV_FILE" | sed -E "s/=(.*)$/=[REDACTED]/"
'
```

If your service uses TOML instead of env overrides, merge the non-secret
fragment from `slack-app/codex-chat.slack.example.toml` into the deployed
`config/codex-chat.toml`. Keep `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` in
the environment file, not TOML.

### 5. Restart and verify health/logs

Pull the current code if needed, restart codex-chat, inspect health/logs, then
return to Slack **Event Subscriptions** and retry/save until the request URL is
verified:

```bash
ssh "$DEPLOY_HOST" 'set -euo pipefail
cd ~/pkg/tim/codex-chat
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run build
(systemctl --user restart codex-chat.service || sudo systemctl restart codex-chat.service)
sleep 3
(codex-chat health --json || bun dist/main.js health || true)
(systemctl --user status codex-chat.service --no-pager || systemctl status codex-chat.service --no-pager || true)
(journalctl --user -u codex-chat.service -n 120 --no-pager || journalctl -u codex-chat.service -n 120 --no-pager || true) \
  | sed -E "s/(SLACK_(SIGNING_SECRET|BOT_TOKEN|APP_TOKEN)=)[^[:space:]]+/\1[REDACTED]/g"
'
```

### 6. Live Slack canary checks

Run these from Slack after the restart:

1. Public channel: mention the bot, e.g. `@Codex Chat canary: reply with the
   current UTC time and the word slack-canary`.
2. DM: send the bot a direct message with the same canary text.
3. Private channel, if used: invite the bot with `/invite @Codex Chat`, then
   send a canary message. `message.groups` delivery only works while the bot is
   a member.
4. MPIM/group DM, if used: include the bot in a group DM and send a canary
   message.

After each check, confirm a Slack reply and inspect logs for accepted events,
normalization, dispatch, and `chat.postMessage` success. If delivery fails,
check Slack app **Event Subscriptions** retry/error details, the codex-chat
health command, and the journal lines around `component=slack`.

### Ask the agent later

Ask codex-chat something like:

> Install or update the Slack app using `slack-app/README.md`. Discover the
> deployed HTTPS base URL, render the manifest, help me enter Slack secrets on
> the deployment server, restart codex-chat, and run the live canaries.

## Scopes and events

Required bot scopes for the current adapter:

- `app_mentions:read` — receive channel mentions.
- `chat:write` — post replies through the normalized `OutputTarget`.
- `im:history`, `mpim:history`, `groups:history` — receive message events for
  DMs, MPIMs, and private channels.
- `im:read`, `mpim:read`, `groups:read` — resolve/read conversation membership
  metadata associated with those surfaces when Slack provides it or future
  bounded metadata calls are enabled.

Subscribed bot events:

- `app_mention`
- `message.im`
- `message.mpim`
- `message.groups`

Slash commands and interactive components are intentionally not enabled for the
Phase 2 HTTP Events API adapter. Future phases can add command routes, Socket
Mode, buttons, progress-message interactivity, or richer Slack read/write tools
without exposing raw tokens to the main Codex prompt or subagents.
