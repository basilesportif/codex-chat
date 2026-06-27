# Brain admin routing boundary

`codex-chat` no longer serves a Clerk admin UI or `/api/admin/codex-chat/*`
compatibility API. Brain owns the human/admin surface for this transition. The
active admin URL is:

```text
https://brain.decisive-outcomes.com/admin
```

`codex-chat` keeps only runtime HTTP contracts it must own, including the Slack
Events API (`/api/slack/events` by default) and runtime ingestion endpoints such
as `/api/ingest/audio`. Slack manifest rendering/validation remains available
from checked-in no-secret scripts under `slack-app/`; Brain can call those from
the selected `codex-chat` checkout instead of depending on a codex-chat-hosted
admin route.

Caddy should route Brain admin traffic to `brain-admin.service` and Slack Events
traffic to the codex-chat API listener. Do not keep redirects or proxy rules for
the removed `/admin/codex-chat` or `/api/admin/codex-chat/*` surfaces:

```caddyfile
brain.decisive-outcomes.com {
	@admin path /admin /admin/*
	handle @admin {
		reverse_proxy 127.0.0.1:49347
	}

	@brainAdminApi path /api/admin/brain /api/admin/brain/*
	handle @brainAdminApi {
		reverse_proxy 127.0.0.1:49347
	}

	@brainHealth path /healthz
	handle @brainHealth {
		reverse_proxy 127.0.0.1:49347
	}

	handle {
		respond "not found" 404
	}
}

me.galebach.com {
	handle /api/slack/events {
		reverse_proxy 127.0.0.1:49346
	}
	# other codex-chat-web/private page handlers live here
}
```

Brain's own Clerk keys and allowlist belong in `~/.config/brain-admin/env`. They
should not be written into the codex-chat service environment.
