# Codex Chat Slack App Runbook

This document is the canonical install, setup, and operator runbook for the
`codex-chat` Slack app. It lives inside `slack-app/` so the Slack app surface can
be extracted to another repository later without losing setup history.

The Slack app surface is product configuration, not a throwaway test fixture:
the manifest declares the bot, OAuth scopes, Events API subscriptions, and
request path that deliver Slack workspace/team/app/channel/user/thread/event
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
- `scripts/render-manifest.mjs` — dependency-free renderer for producing a
  deploy-ready manifest from `manifest.json` without Slack secrets.
- `scripts/render-remote-manifest.sh` — remote-host wrapper that pulls, renders,
  validates, and prints only manifest JSON to stdout unless a server-side output
  path is requested.
- `scripts/validate-manifest.mjs` — dependency-free validation for this app
  surface's manifest and metadata template.
- `src/slack-manifest.ts` — codex-chat-owned manifest rendering/validation logic used by the checked-in helper scripts and tests. Brain should call these no-secret helpers from a selected checkout instead of using a codex-chat-hosted admin route.

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
out of git and renders a workspace-specific manifest to a local file or optional
server-side temp path.

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
match the service path (`/api/slack/events` by default). The current expected
Slack Events URL for the deployed app is:

```text
https://brain.decisive-outcomes.com/api/slack/events
```

### 1. Render and validate the Slack manifest

From your local machine, this short command asks the remote `codex-chat` host
to pull the latest checkout, render the manifest with the default Events API URL
`https://brain.decisive-outcomes.com/api/slack/events`, validate it, and print only JSON to
stdout. Redirect it wherever you want the local copy to land:

```bash
ssh codex-chat 'cd ~/pkg/tim/codex-chat && slack-app/scripts/render-remote-manifest.sh' > ./codex-chat.slack.manifest.json
```

If you want to choose the local destination directory interactively, paste this
small wrapper. Press Enter for the current directory, or type `~/Downloads`,
`../ops`, or another local path; `~` and relative paths are handled locally:

```bash
read -erp "Destination directory [$(pwd)]: " dest || dest=.
dest=${dest:-.}
case "$dest" in "~") dest="$HOME" ;; "~/"*) dest="$HOME/${dest#~/}" ;; esac
mkdir -p "$dest"
ssh codex-chat 'cd ~/pkg/tim/codex-chat && slack-app/scripts/render-remote-manifest.sh' > "$dest/codex-chat.slack.manifest.json"
printf "Wrote Slack manifest to %s\n" "$dest/codex-chat.slack.manifest.json"
```

The remote helper also supports server-side temp/output files when needed:

```bash
ssh codex-chat 'cd ~/pkg/tim/codex-chat && slack-app/scripts/render-remote-manifest.sh --output /tmp/codex-chat.slack.manifest.json'
```

To render from an already-local checkout, run the script directly. It writes to
stdout by default, or to a path/directory that can use `~` or be relative to the
current working directory:

```bash
node slack-app/scripts/render-manifest.mjs --output-dir ~/Downloads
node slack-app/scripts/render-manifest.mjs --base-url https://brain.decisive-outcomes.com --events-path /api/slack/events > ./codex-chat.slack.manifest.json
node slack-app/scripts/validate-manifest.mjs ./codex-chat.slack.manifest.json
```

Keep `slack-app/manifest.json` committed with the placeholder URL. Use the
rendered `codex-chat.slack.manifest.json` in Slack.

### 2. Create/review/install the Slack app

In Slack's app admin UI:

1. Go to <https://api.slack.com/apps> (**Your Apps**).
2. Click **Create an App**.
3. Choose **From an app manifest**.
4. Pick the **Decisive Outcomes** workspace.
5. Choose **JSON** if Slack asks for the manifest format.
6. Paste or import the rendered `codex-chat.slack.manifest.json` from Step 1.
7. Click through **Create** / **Review** and fix any manifest errors.
8. Click **Install to Workspace** (or reinstall/review scopes for an existing
   app) and approve the requested bot scopes.
9. Copy these values for Step 4, but do not paste them into git, logs, or chat
   transcripts:
   - **Basic Information** -> **Signing Secret** -> `SLACK_SIGNING_SECRET`
   - **OAuth & Permissions** -> **Bot User OAuth Token** -> `SLACK_BOT_TOKEN`
     (`xoxb-...`)

For an existing app, open the app from **Your Apps**, choose **App Manifest**,
paste/import the newly rendered manifest JSON, save it, then reinstall if Slack
reports new scopes.

If Slack still cannot verify the URL after restart, check that codex-chat is
deployed, the API listener is reachable through HTTPS, and the manifest URL
exactly matches the configured path.

### 3. Capture non-secret install metadata

After install, capture non-secret IDs for operations by copying
`slack-app/install-metadata.example.json` to a private ops location and filling
in the workspace/team/app/bot IDs, installer, rollout channels, scopes, and
Events API URL.

### 4. Configure Slack env through Brain or the private service env

Brain owns the admin/control-plane surface at:

```text
https://brain.decisive-outcomes.com/admin
```

Use Brain to write codex-chat env values, or merge the same keys directly into
the private codex-chat service env file with hidden prompts. Do not configure
`CODEX_CHAT_ADMIN_*` or Clerk keys in codex-chat; the codex-chat-hosted admin
surface and `/api/admin/codex-chat/*` compatibility routes are removed.

Required Slack env names for the current HTTP Events API adapter:

- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `CODEX_CHAT_SLACK_ENABLED=true`
- `CODEX_CHAT_SLACK_EVENTS_PATH=/api/slack/events`
- `CODEX_CHAT_API_ENABLED=true`
- `CODEX_CHAT_BASE_URL=https://brain.decisive-outcomes.com`

If your service uses TOML instead of env overrides, merge the non-secret
fragment from `slack-app/codex-chat.slack.example.toml` into the deployed
`config/codex-chat.toml`. Keep `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` in the codex-chat environment file, not TOML. Brain Clerk secrets live only in the Brain admin environment.

### 5. Caddy route/proxy assumptions

The Events API URL must terminate HTTPS and reverse-proxy to the codex-chat API
listener. The default app/runtime assumption is:

- Slack public URL: `https://brain.decisive-outcomes.com/api/slack/events`
- Brain admin URL: `https://brain.decisive-outcomes.com/admin` (served by `brain-admin.service`, not codex-chat)
- codex-chat API path: `/api/slack/events` for Slack runtime delivery
- local service listener: `127.0.0.1:49346` when using the example TOML
- Caddy/nginx/proxy preserves the path and forwards Slack's signed HTTP request
  body and headers unchanged

If Slack cannot verify the request URL, inspect the active Caddy/nginx config and
service listener without printing secrets:

```bash
ssh codex-chat 'set -euo pipefail
printf "listening ports:\n"; ss -ltn | grep -E ":(80|443|49346)\b" || true
printf "candidate proxy routes:\n"
sudo sh -c '\''grep -RhsE "reverse_proxy|codex-chat|49346|49347|api/slack/events|api/admin/brain|me\.galebach\.com|brain\.decisive-outcomes\.com" /etc/caddy /etc/nginx 2>/dev/null || true'\''
'
```

### 6. Restart/deploy steps

After changing code, config, env, or the Slack manifest, deploy the current repo
state to the host, restart the service, then re-check health and logs. The
remote manifest helper already does `git pull --ff-only origin main` by default;
for code/config changes use the repo's normal deploy path, then restart:

```bash
ssh codex-chat 'set -euo pipefail
cd ~/pkg/tim/codex-chat
git pull --ff-only origin main
systemctl --user restart codex-chat.service
systemctl --user is-active codex-chat.service
'
```

If a system service is used instead of the user service, replace the last two
commands with the equivalent `sudo systemctl restart/status` commands for that
deployment.

### 7. Verify health/logs

After the secret-injection or deploy command restarts `codex-chat`, inspect
health/logs, then return to Slack **Event Subscriptions** and retry/save until
the request URL is verified:

```bash
ssh codex-chat 'set -euo pipefail
sleep 3
(codex-chat health --json || (cd ~/pkg/tim/codex-chat && bun dist/main.js health) || true)
systemctl --user status codex-chat.service --no-pager || true
journalctl --user -u codex-chat.service -n 120 --no-pager \
  | sed -E "s/(SLACK_(SIGNING_SECRET|BOT_TOKEN|APP_TOKEN)=)[^[:space:]]+/\1[REDACTED]/g"
'
```

### 8. Live Slack canary checks

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

> Install or update the Slack app using `slack-app/SLACK.md`. Discover the
> deployed HTTPS base URL, render the manifest, help me enter Slack secrets on
> the deployment server, restart codex-chat, and run the live canaries.

## Troubleshooting notes

- **URL verification fails:** confirm the manifest's request URL is exactly
  `https://brain.decisive-outcomes.com/api/slack/events` for the current Slack deployment, the
  proxy forwards that path to the codex-chat API listener, and
  `CODEX_CHAT_SLACK_EVENTS_PATH` is `/api/slack/events` unless the manifest was
  rendered with the same custom path.
- **Slack returns signing errors or codex-chat rejects requests:** rotate/copy
  the **Basic Information** signing secret again into `SLACK_SIGNING_SECRET` on
  the deployment host. Do not use the bot token as the signing secret.
- **The bot receives events but cannot reply:** verify **OAuth & Permissions**
  has the `chat:write` bot scope, the app was reinstalled after scope changes,
  and `SLACK_BOT_TOKEN` is the bot token beginning with `xoxb-`.
- **Private channel messages do not arrive:** invite the bot into the private
  channel and verify the `message.groups`, `groups:history`, and `groups:read`
  subscriptions/scopes are installed.
- **DM or MPIM messages do not arrive:** verify `message.im`, `message.mpim`,
  `im:history`, `im:read`, `mpim:history`, and `mpim:read` are present and the
  app was reinstalled after updates.
- **Manifest render prints logs into the JSON file:** use
  `slack-app/scripts/render-remote-manifest.sh`, which writes status to stderr
  and JSON to stdout. Validate the resulting file with
  `node slack-app/scripts/validate-manifest.mjs ./codex-chat.slack.manifest.json`.
- **Secrets appear in logs:** stop sharing the log output, rotate exposed Slack
  credentials in the Slack admin UI, update the deployment env file, and restart
  codex-chat.

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
