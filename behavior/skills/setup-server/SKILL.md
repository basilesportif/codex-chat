# Setup Server Skill

Use this skill when the user asks to bootstrap, secure, or deploy `codex-chat` on a new remote Ubuntu/Debian server.

This skill is based on the `assistant-agent-logic` setup-server workflow, adapted for `codex-chat`. It should produce a working remote host with:

- a non-root deploy user
- passwordless sudo for that user
- SSH access using public keys only
- an `ed25519` SSH key for outbound GitHub access
- base packages, Bun, Node.js, Codex CLI, and `codex-chat`
- a systemd user service running `codex-chat`
- firewall and basic intrusion protection

## Required inputs

Collect these before running commands:

| Parameter | Description | Example |
| --- | --- | --- |
| `SERVER_IP` | Public IP or hostname of the new server | `203.0.113.42` |
| `USERNAME` | Non-root deploy user to create | `tim` |
| `SERVER_NAME` | Label for SSH config and GitHub key title | `codex-chat-prod` |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather | `123456:...` |
| `TELEGRAM_ALLOWED_USER_ID` | Telegram numeric user ID allowed to pair/use the bot | `253768951` |
| `TELEGRAM_ALLOWED_CHAT_ID` | Telegram numeric chat ID for replies/admin notifications | `253768951` |
| `OPENAI_API_KEY` | OpenAI API key for Codex/OpenAI calls | `sk-...` |
| `REPO_URL` | `codex-chat` Git remote | `git@github.com:basilesportif/codex-chat.git` |

Default local variables:

```bash
SERVER_IP="<server-ip>"
USERNAME="<username>"
SERVER_NAME="<server-name>"
REPO_URL="git@github.com:basilesportif/codex-chat.git"
REMOTE_REPO_DIR="/home/$USERNAME/pkg/tim/codex-chat"
```

## Security rules

- Never paste or commit real tokens into repo files.
- Put secrets only in the remote service environment file or user-owned shell environment.
- Do not disable root SSH until non-root sudo access is verified.
- Prefer key-only SSH; do not enable password auth.
- Use `ufw` to allow only OpenSSH by default. `codex-chat` does not require inbound HTTP.
- Install `fail2ban` for SSH protection.
- Keep `PermitRootLogin prohibit-password` unless the user explicitly wants root SSH fully disabled after verification.

## Phase 0: Get or create the Telegram bot token

Tell the user to create or retrieve the bot token in Telegram:

1. Open Telegram and message `@BotFather`.
2. Use `/newbot` to create a bot, or `/mybots` to manage an existing one.
3. Copy the bot token.
4. Get the user's numeric Telegram ID from `@userinfobot`.

If the user does not yet know the chat ID, deploy with only the allowed user ID and use the `codex-chat` pairing flow after startup.

## Phase 1: Verify root access

```bash
ssh -o StrictHostKeyChecking=accept-new root@$SERVER_IP "echo root access OK"
```

Stop if this fails.

## Phase 2: Create the deploy user

```bash
ssh root@$SERVER_IP bash <<REMOTE
set -euo pipefail
USERNAME='$USERNAME'

id "\$USERNAME" >/dev/null 2>&1 || useradd -m -s /bin/bash "\$USERNAME"
usermod -aG sudo "\$USERNAME"
echo "\$USERNAME ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/\$USERNAME"
chmod 0440 "/etc/sudoers.d/\$USERNAME"

USER_HOME=\$(eval echo "~\$USERNAME")
mkdir -p "\$USER_HOME/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "\$USER_HOME/.ssh/authorized_keys"
fi
chown -R "\$USERNAME:\$USERNAME" "\$USER_HOME/.ssh"
chmod 700 "\$USER_HOME/.ssh"
[ -f "\$USER_HOME/.ssh/authorized_keys" ] && chmod 600 "\$USER_HOME/.ssh/authorized_keys"
REMOTE
```

Verify:

```bash
ssh -o StrictHostKeyChecking=accept-new $USERNAME@$SERVER_IP "whoami && sudo whoami"
```

Expected: first line is the deploy username, second line is `root`.

## Phase 3: Harden SSH and install base security packages

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl git unzip build-essential tmux ca-certificates gnupg ufw fail2ban libatomic1

sudo install -d -m 0755 /etc/ssh/sshd_config.d
sudo tee /etc/ssh/sshd_config.d/99-codex-chat-hardening.conf >/dev/null <<'SSHCONF'
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
X11Forwarding no
AllowTcpForwarding yes
SSHCONF

sudo sshd -t
sudo systemctl reload ssh || sudo systemctl reload sshd

sudo ufw allow OpenSSH
sudo ufw --force enable
sudo systemctl enable --now fail2ban
REMOTE
```

Verify a second SSH session still works before closing the first:

```bash
ssh $USERNAME@$SERVER_IP "echo ssh ok && sudo ufw status verbose && sudo fail2ban-client status sshd || true"
```

## Phase 4: Install Bun, Node.js, and Codex CLI

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

if [ ! -d "$HOME/.nvm" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install --lts
nvm alias default lts/*
nvm use default

npm install -g @openai/codex
bun --version
node --version
npm --version
codex --version
REMOTE
```

## Phase 5: Generate outbound GitHub SSH key

Generate an `ed25519` key on the server:

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
KEY_FILE="$HOME/.ssh/id_ed25519"
if [ ! -f "$KEY_FILE" ]; then
  ssh-keygen -t ed25519 -N "" -C "$USER@$(hostname)-codex-chat" -f "$KEY_FILE"
fi
chmod 600 "$KEY_FILE"
chmod 644 "$KEY_FILE.pub"
cat "$KEY_FILE.pub"
REMOTE
```

Add the printed public key to GitHub. Prefer the GitHub CLI locally:

```bash
PUB_KEY=$(ssh $USERNAME@$SERVER_IP cat ~/.ssh/id_ed25519.pub)
gh ssh-key add - --title "$SERVER_NAME codex-chat" <<< "$PUB_KEY"
```

If `gh` is unavailable, add it manually at `https://github.com/settings/ssh/new`.

Verify from the server:

```bash
ssh $USERNAME@$SERVER_IP "ssh -o StrictHostKeyChecking=accept-new -T git@github.com || true"
```

A GitHub authentication success message with shell denial is acceptable.

## Phase 6: Clone and build `codex-chat`

```bash
ssh $USERNAME@$SERVER_IP bash <<REMOTE
set -euo pipefail
export BUN_INSTALL="\$HOME/.bun"
export PATH="\$BUN_INSTALL/bin:\$PATH"

mkdir -p "\$HOME/pkg/tim"
if [ ! -d "$REMOTE_REPO_DIR/.git" ]; then
  git clone "$REPO_URL" "$REMOTE_REPO_DIR"
fi
cd "$REMOTE_REPO_DIR"
git fetch origin
CURRENT_BRANCH=\$(git branch --show-current || echo main)
git reset --hard "origin/\$CURRENT_BRANCH"
bun install
bun run build
REMOTE
```

## Phase 7: Configure secrets and allowlist

Create a systemd environment file with secrets. Do not commit this file.

```bash
ssh $USERNAME@$SERVER_IP bash <<REMOTE
set -euo pipefail
cd "$REMOTE_REPO_DIR"
mkdir -p config data/state
cat > config/codex-chat.env <<'ENV'
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY
ENV
chmod 600 config/codex-chat.env
REMOTE
```

Then configure `config/codex-chat.toml` for the deployment. Runtime config files are intentionally untracked; run `bun dist/main.js setup` or copy `config/codex-chat.example.toml`, `config/loops.example.json`, and `config/monitors.example.json` to their non-example runtime names. If the host already has a deployment config, preserve it and only update the allowlist/admin IDs. If not, set:

- Telegram token is read from the environment, not TOML.
- allowed Telegram user/chat IDs include the owner.
- behavior dir points to the repo-local `behavior/` directory.
- data dir points to the repo-local `data/` directory.
- optional voice transcription prompt/dictionary path is set with `transcription.promptPath`.

Recommended transcription dictionary file:

```toml
[transcription]
enabled = true
provider = "openai"
model = "gpt-4o-transcribe"
apiKeyEnv = "OPENAI_API_KEY"
language = ""
promptPath = "/home/$USERNAME/.assistant-claude/workspace/instructions/prompts/voice-transcription.md"
```

Create the prompt file on the server if the deployment uses voice messages:

```bash
ssh $USERNAME@$SERVER_IP bash <<'REMOTE'
set -euo pipefail
mkdir -p "$HOME/.assistant-claude/workspace/instructions/prompts"
cat > "$HOME/.assistant-claude/workspace/instructions/prompts/voice-transcription.md" <<'PROMPT'
Use this as transcription vocabulary and correction guidance. Preserve the speaker's meaning. Prefer the spellings and replacements below when audio is ambiguous. Remove filler words.

USER DICTIONARY:
- GPT-5.5
- Codex
- xhigh
PROMPT
REMOTE
```

`codex-chat` reads this file fresh for every voice/audio transcription. Editing the dictionary contents does not require a service restart. Changing `promptPath` itself does require restarting the service because the configured path is loaded at startup. Do not put secrets in the prompt file; it is sent to OpenAI with each transcription request.

If no allowlist is configured yet, start the service and use its one-time `/pair <code>` flow from Telegram.

## Phase 8: Install and start the user service

```bash
ssh $USERNAME@$SERVER_IP bash <<REMOTE
set -euo pipefail
export BUN_INSTALL="\$HOME/.bun"
export PATH="\$BUN_INSTALL/bin:\$PATH"
cd "$REMOTE_REPO_DIR"

mkdir -p "\$HOME/.config/systemd/user"
cat > "\$HOME/.config/systemd/user/codex-chat.service" <<SERVICE
[Unit]
Description=codex-chat Telegram Codex service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_REPO_DIR
EnvironmentFile=$REMOTE_REPO_DIR/config/codex-chat.env
ExecStart=\$HOME/.bun/bin/bun $REMOTE_REPO_DIR/dist/main.js --config $REMOTE_REPO_DIR/config/codex-chat.toml start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

loginctl enable-linger "$USERNAME" || true
systemctl --user daemon-reload
systemctl --user enable --now codex-chat.service
systemctl --user status codex-chat.service --no-pager
REMOTE
```

If user systemd fails over SSH because no user bus is available, run once interactively as the user or use `machinectl shell`. Do not install a root service unless the user explicitly asks for a system-wide service.

## Phase 9: Verify end-to-end

Run:

```bash
ssh $USERNAME@$SERVER_IP bash <<REMOTE
set -euo pipefail
cd "$REMOTE_REPO_DIR"
systemctl --user is-active codex-chat.service
systemctl --user --no-pager -n 80 status codex-chat.service
./dist/main.js --config config/codex-chat.toml health --json || true
REMOTE
```

Then send a Telegram message to the bot. Expected behavior:

1. Telegram receives a 👀 reaction quickly.
2. `codex-chat` replies through the bot.
3. Logs show no auth, token, config, or OpenAI errors.

## Phase 10: Final report

Report only operational facts:

- server IP/hostname
- deploy username
- repo path
- service status
- whether SSH hardening, UFW, fail2ban, ed25519 GitHub key, build, and Telegram verification are complete
- any remaining manual step, such as adding the GitHub public key or completing Telegram pairing

Do not include secrets or private key material.
