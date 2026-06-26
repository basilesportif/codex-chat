# Codex Chat Slack App

This directory is the self-contained installable Slack application surface for
`codex-chat`. It contains the Slack manifest, non-secret install metadata
schema, adapter config examples, and manifest helper scripts.

The canonical Slack install/setup/operator runbook now lives in
[`SLACK.md`](./SLACK.md). Keep detailed Slack instructions there so this
subtree can be moved to another repository later without losing the runbook.

## Key files

- [`SLACK.md`](./SLACK.md) — canonical Slack app install, setup, deploy,
  canary, and troubleshooting runbook.
- [`manifest.json`](./manifest.json) — committed Slack app manifest template
  with placeholder Events API URL.
- [`install-metadata.example.json`](./install-metadata.example.json) —
  non-secret workspace/app/bot metadata template for private ops records.
- [`codex-chat.slack.example.toml`](./codex-chat.slack.example.toml) — example
  codex-chat config fragment for enabling the Slack adapter.
- [`.env.example`](./.env.example) — environment variable names for Slack
  secrets and adapter enablement.
- [`scripts/render-manifest.mjs`](./scripts/render-manifest.mjs) — render a
  deploy-ready manifest from the template without secrets.
- [`scripts/render-remote-manifest.sh`](./scripts/render-remote-manifest.sh) —
  SSH-friendly wrapper that pulls, renders, validates, and prints manifest JSON.
- [`scripts/validate-manifest.mjs`](./scripts/validate-manifest.mjs) — validate
  the Slack manifest and install metadata template.

## Runtime mapping

Slack Events API requests are delivered to `/api/slack/events` by default and
normalized in `src/slack.ts` for the shared codex-chat runtime. See
[`SLACK.md`](./SLACK.md#adapter-mapping) for supported Slack surfaces, required
scopes/events, and operational details.
