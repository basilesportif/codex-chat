# Brain admin Clerk auth and routing

The codex-chat Slack/bootstrap admin page is currently published at:

```text
https://brain.decisive-outcomes.com/admin
```

Runtime env should make the public URL and sign-in route explicit:

```text
CODEX_CHAT_ADMIN_ENABLED=true
CODEX_CHAT_ADMIN_PUBLIC_BASE_URL=https://brain.decisive-outcomes.com
CODEX_CHAT_ADMIN_ROUTE_PATH=/admin
CLERK_SIGN_IN_URL=https://brain.decisive-outcomes.com/admin/auth/sign-in
CLERK_ALLOWED_EMAILS=timgalebachukraine@gmail.com,tim.galebach@gmail.com
```

Do not configure `CLERK_SIGN_IN_URL` to a Clerk-hosted `*.accounts.dev` URL for
this app. The admin sign-in page is app-hosted, matching the working
`me.galebach.com/private/pages` pattern: unauthenticated `/admin` browser
requests redirect to `/admin/auth/sign-in?redirect_url=...`, and that page mounts
Clerk with force/fallback redirects back to `/admin`.

Caddy should proxy the new host/path to codex-chat on `127.0.0.1:49346`:

```caddyfile
brain.decisive-outcomes.com {
	@admin path /admin /admin/*
	handle @admin {
		reverse_proxy 127.0.0.1:49346
	}

	@codexChatAdminApi path /api/admin/codex-chat /api/admin/codex-chat/*
	handle @codexChatAdminApi {
		reverse_proxy 127.0.0.1:49346
	}

	handle {
		respond "not found" 404
	}
}
```

The older `/admin/codex-chat/` URL can remain as a same-host compatibility
redirect, but do not redirect the hyphenated host to `brain.decisiveoutcomes.com`:

```caddyfile
@oldCodexChatAdmin path /admin/codex-chat /admin/codex-chat/*
redir @oldCodexChatAdmin https://brain.decisive-outcomes.com/admin 308
```

DNS should be in the `decisive-outcomes.com` zone. The public Cloudflare record
may answer with Cloudflare proxy IPs, but the configured origin should be
`178.104.208.141`.

Clerk dashboard values that may need to be allowed for production:

```text
Allowed origin / application URL: https://brain.decisive-outcomes.com
Allowed redirect URL: https://brain.decisive-outcomes.com/admin
Allowed redirect URL: https://brain.decisive-outcomes.com/admin/auth/sign-in
```
