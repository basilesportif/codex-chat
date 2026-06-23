# Codex Web Clerk Private Pages Plan

Date: 2026-06-23

## Goal

The end goal is that all new scratch pages Tim creates are private by default and available only to the allowed users authenticated through Clerk for `me.galebach.com`. Move generated Codex Web scratch pages from public-by-obscurity hosting to server-side Clerk-protected private pages using the existing Caddy deployment as a simple reverse proxy to an ExpressJS serving program. Unauthenticated users must be sent directly into Clerk sign-in for the requested private page, with no Codex-hosted intermediate landing page or extra sign-in button page. Preserve current public `/pages/*` behavior only for legacy pages and explicitly requested public/legacy publishes during migration.

Allowed users must be exactly:

```env
CLERK_ALLOWED_EMAILS=timgalebachukraine@gmail.com,tim.galebach@gmail.com
```

The implementation must parse the allowlist case-insensitively, de-dupe internally, and require a verified matching Clerk email. If `CLERK_ALLOWED_EMAILS` is unset or blank, authenticated users must receive `403` server-side.

## Findings

- Authoritative `codex-chat-web` source is remote: `tim@89.167.72.52:~/pkg/tim/codex-chat-web`; deploy host/domain are `codex-chat-assistant-1` / `me.galebach.com` per repo registry (`index.yaml:823-919`).
- Current setup already uses Caddy. Today, Caddy serves all `/pages/*` directly from `/srv/codex-chat-web/pages` (`/etc/caddy/Caddyfile:15-31`). Protected page requests must stop being directly file-served by Caddy; they should hit ExpressJS first so server-side Clerk auth gates both HTML and assets.
- Current `codex-chat-web` is static + publisher/pruner only. Defaults publish public, unlisted pages to `/srv/codex-chat-web/pages/<id>/` and `https://me.galebach.com/pages/<id>/` (`README.md:56-70`, `scripts/lib/generated-pages.mjs:19-24`).
- Active manifest pages at research time: `conference-map`, `frsa-2026-just-the-facts`, `frsa-2026-meeting-synthesis`; legacy redirect exists for the old conference-map URL.
- Current env file on deploy host exists at `/home/tim/.config/codex-chat-web/env`, mode `0600`, currently only `GOOGLE_MAPS_API_KEY`; preserve it.
- Repo registry identifies Tim's continual learning repo as the Clerk reference: `tim-continual-learning` at `tim@89.167.72.52:~/pkg/mush/tim-continual-learning`, remote `git@github.com:basilesportif/tim-continual-learning.git`. Relevant Clerk guidance lives in `skills/clerk/SKILL.md` and `skills/admin-site/references/clerk-react-pattern.md`.
- Tim's documented Clerk defaults from that repo: keep the repo's existing env-key pattern instead of migrating patterns unnecessarily; keep `CLERK_SECRET_KEY` server-only; use `CLERK_PUBLISHABLE_KEY`/`VITE_CLERK_PUBLISHABLE_KEY` according to the app's existing frontend model; for Express use `@clerk/express`, `clerkMiddleware()`, `getAuth()`, and `clerkClient.users.getUser()`; resolve the primary Clerk email; normalize `CLERK_ALLOWED_EMAILS` into a lowercase set; reject missing/invalid auth as unauthenticated and signed-in users outside the allowlist as `403`; do not use roles/public signup unless Tim explicitly asks.
- Tim's documented Clerk UI preference: do not put an extra button or Codex landing page in front of auth. Signed-out users should immediately see Clerk's sign-in UI or be redirected to Clerk's hosted sign-in flow. For `codex-chat-web` private static pages, prefer a server-side redirect to `CLERK_SIGN_IN_URL` with a return URL to the originally requested private page.

## Implementation Plan

1. **Use Tim's continual learning repo as the Clerk reference**
   - Before coding product changes, verify the authoritative `tim-continual-learning` location from the repo registry: `tim@89.167.72.52:~/pkg/mush/tim-continual-learning`.
   - Use `skills/clerk/SKILL.md` as the shared Clerk rulebook and `skills/admin-site/references/clerk-react-pattern.md` as the concrete allowlist/admin example.
   - Apply these reference requirements to `codex-chat-web`:
     - preserve a single consistent Clerk env pattern for this repo; do not invent a second publishable-key pattern;
     - keep `CLERK_SECRET_KEY` server-only and never write secret values into source, manifests, logs, or static files;
     - use `@clerk/express` with `clerkMiddleware()`, `getAuth()`, and `clerkClient.users.getUser()` for server-side checks;
     - derive authorization from Clerk's resolved primary/verified email and the lowercased `CLERK_ALLOWED_EMAILS` set;
     - all generated scratch pages and their assets are private by default; only explicit legacy/public publish flags may use public `/pages/*`;
     - signed-out users go directly to Clerk sign-in for the requested private URL, not to a Codex-hosted explanation/intermediate page;
     - signed-in users outside the allowlist receive a server-side `403`.
   - Carry over only the relevant Clerk pattern; do not introduce extra framework or static-root complexity just because the reference repo has it.

2. **Add Clerk-protected ExpressJS serving program**
   - Use official Clerk Express SDK: `@clerk/express` with `clerkMiddleware()`, server-side `getAuth()`, and `clerkClient.users.getUser()`.
   - Add `server.mjs` plus a testable helper module, e.g. `scripts/lib/private-server.mjs`.
   - Express should be the only path for protected page requests. It should serve both HTML and static assets after server-side auth.
   - Unauthenticated protected HTML or asset requests must not receive page content. Browser navigations should `302` directly to Clerk sign-in using `CLERK_SIGN_IN_URL` and a return URL for the originally requested private page; non-navigation/API-style requests may receive `401` with no page content.
   - Authenticated users not in the verified-email allowlist must receive `403` server-side.

3. **Use Caddy only as reverse proxy for protected routes**
   - Add a Caddy `handle` before any static `/pages/*` file server for protected routes, for example:
     ```caddyfile
     handle /private/* {
       reverse_proxy 127.0.0.1:3027
     }
     ```
   - Route protected generated pages through Express at:
     - `https://me.galebach.com/private/pages/<id>/`
     - assets under `https://me.galebach.com/private/pages/<id>/...`
   - Keep the existing `/pages/*` direct static handler during migration so current public pages and redirects continue working.
   - Do not add another Caddy-served static root for protected pages. If a separate filesystem directory is needed, it is only Express's private storage, not a Caddy-served root.

4. **Choose the minimal safe storage transition**
   - Preferred: publish new protected pages into an Express-only storage location, e.g. `/srv/codex-chat-web/private-pages`, owned by `tim` and not served directly by Caddy.
   - Keep legacy public root `/srv/codex-chat-web/pages` unchanged for existing public pages.
   - Avoid extra root/path complexity beyond what prevents accidental public exposure and preserves current behavior.

5. **Add logout on every private page**
   - For private HTML responses, inject a small fixed auth bar containing the signed-in username/email.
   - Clicking username submits `POST /private/auth/logout`.
   - Server revokes the current Clerk session via `clerkClient.sessions.revokeSession(sessionId)` and redirects to sign-in/home.
   - Do not depend on frontend-only auth for access control.

6. **Migrate publisher defaults so scratch pages are private by default**
   - Change defaults in `scripts/lib/generated-pages.mjs`:
     - `DEFAULT_RUNTIME_ROOT=/srv/codex-chat-web/private-pages`
     - `DEFAULT_PUBLIC_BASE_URL=https://me.galebach.com/private/pages`
     - `DEFAULT_VISIBILITY=private-auth`
   - Keep explicit `--runtime-root /srv/codex-chat-web/pages --public-base-url https://me.galebach.com/pages --visibility public` (or equivalent explicit flags) available only for intentional legacy/public publishes. No generated scratch page should silently fall back to public `/pages/*`.
   - Update pruner to use each manifest entry's `runtimePath` when present, so old public pages and new private pages both prune correctly.

7. **Deploy systemd integration**
   - Add `deploy/codex-chat-web.service` for the ExpressJS server on `CODEX_CHAT_WEB_PORT` (default `3027`).
   - Validate Caddy after adding the reverse proxy and reload only after validation succeeds.
   - Do not change the existing `/pages/*` handler until protected route smoke tests pass.

8. **Add Clerk env upload script**
   - Add `scripts/upload-clerk-env.sh`.
   - It should prompt without echoing:
     - `CLERK_PUBLISHABLE_KEY`
     - `CLERK_SECRET_KEY`
     - `CLERK_SIGN_IN_URL`
   - It should set/merge:
     ```env
     CLERK_ALLOWED_EMAILS=timgalebachukraine@gmail.com,tim.galebach@gmail.com
     CODEX_CHAT_WEB_PORT=3027
     CODEX_CHAT_WEB_PRIVATE_RUNTIME_ROOT=/srv/codex-chat-web/private-pages
     CODEX_CHAT_WEB_PUBLIC_BASE_URL=https://me.galebach.com/private/pages
     ```
   - Preserve existing `GOOGLE_MAPS_API_KEY`; install env as `/home/tim/.config/codex-chat-web/env` mode `0600`.

## Likely Files to Change in `codex-chat-web`

- `package.json`, `package-lock.json`
- `server.mjs`
- `scripts/lib/private-server.mjs`
- `scripts/lib/generated-pages.mjs`
- `scripts/upload-clerk-env.sh`
- `scripts/__tests__/*.test.mjs`
- `deploy/codex-chat-web.service`
- `docs/deploy-caddy.md`
- `docs/generated-pages-architecture.md`
- `README.md`
- `AGENTS.md`
- Follow-up: `assistant-agent-logic/config/skills/generated-web-page.md`

## Verification Plan

Source checkout:

```sh
ssh tim@89.167.72.52 'cd ~/pkg/tim/codex-chat-web && npm test'
```

Deploy checkout:

```sh
cd /home/tim/pkg/tim/codex-chat-web
npm test
```

After deploy:

```sh
systemctl is-active codex-chat-web caddy
curl -fsS http://127.0.0.1:3027/healthz
sudo caddy validate --config /etc/caddy/Caddyfile
```

Publish private smoke page:

```sh
npm run publish:page -- --dir /tmp/ccw-smoke --id auth-smoke-$(date +%s) --ttl-hours 1
```

Unauthenticated checks:

```sh
curl -si https://me.galebach.com/private/pages/$ID/ | head -40
curl -si https://me.galebach.com/private/pages/$ID/app.js | head -40
curl -I  https://me.galebach.com/pages/$ID/
```

Expect private browser navigations to `302` directly to the configured Clerk sign-in URL with a return URL, with no Codex-hosted intermediate page and no private page content. Non-navigation/private asset requests may return `401`, but must not disclose page content. Legacy public path must be `404` for a new private ID.

Authenticated browser checks:

- Visit private URL and sign in via Clerk as either `timgalebachukraine@gmail.com` or `tim.galebach@gmail.com`.
- Confirm page and assets load.
- Confirm username/email appears.
- Click username; confirm logout; reload private URL redirects directly to Clerk sign-in.
- Temporarily test blank allowlist in staging/local: `CLERK_ALLOWED_EMAILS=` must produce server-side `403`.

Legacy behavior checks:

```sh
curl -I https://me.galebach.com/
curl -I https://me.galebach.com/pages/conference-map/
curl -I https://me.galebach.com/pages/conference-map/app.js
curl -I https://me.galebach.com/pages/it-consulting-june-2026-conference-map-google/
```

Expect current `200`/asset behavior and existing `308` redirect preserved.

## Rollback

- Remove/disable Caddy `/private/*` reverse proxy; reload Caddy.
- `sudo systemctl disable --now codex-chat-web`
- Revert repo commit on deploy checkout and source checkout.
- Set publisher env override back to:
  ```env
  CODEX_CHAT_WEB_PUBLIC_BASE_URL=https://me.galebach.com/pages
  CODEX_CHAT_WEB_RUNTIME_ROOT=/srv/codex-chat-web/pages
  ```
- Legacy `/pages/*` remains untouched, so current pages should continue working.

## Open Questions

1. Preferred private URL: `/private/pages/<id>/` vs `/scratch/pages/<id>/`?
2. Should existing active public pages be copied to private root now, or only new pages become private?
3. Confirm the exact Clerk Account Portal/sign-in URL to store as `CLERK_SIGN_IN_URL`; implementation must treat it as required for private browser redirects.
