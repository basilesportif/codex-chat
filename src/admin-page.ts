import type { AppConfig } from "./config.js";

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsString(value: string | undefined): string {
  return JSON.stringify(value ?? "");
}

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function deriveClerkFrontendApi(publishableKey: string): string {
  const match = String(publishableKey || "").match(/^pk_(?:test|live)_(.+)$/);
  if (!match) return "";
  try {
    const decoded = Buffer.from(match[1] ?? "", "base64")
      .toString("utf8")
      .trim()
      .replace(/\$$/, "");
    if (!decoded || !decoded.includes(".") || decoded.includes("/") || /\s/.test(decoded)) return "";
    return decoded;
  } catch {
    return "";
  }
}

export function renderAdminSignInPage(
  config: AppConfig,
  redirectUrl: string,
): string {
  const publishableKey = config.clerkPublishableKey ?? "";
  const frontendApi = deriveClerkFrontendApi(publishableKey);
  const clerkBase = frontendApi ? `https://${frontendApi}` : "";
  const payload = safeJsonForHtml({ publishableKey, redirectUrl });
  const signInScripts = clerkBase
    ? `<script defer crossorigin="anonymous" src="${htmlEscape(clerkBase)}/npm/@clerk/ui@1/dist/ui.browser.js" type="text/javascript"></script>\n  <script defer crossorigin="anonymous" data-clerk-publishable-key="${htmlEscape(publishableKey)}" src="${htmlEscape(clerkBase)}/npm/@clerk/clerk-js@6/dist/clerk.browser.js" type="text/javascript"></script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign in · Brain Control Plane</title>
  <style>
    :root { color-scheme: dark; --bg:#020617; --panel:#0f172a; --muted:#94a3b8; --text:#e5e7eb; --line:#334155; --accent:#38bdf8; --danger:#f87171; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; background: radial-gradient(circle at top, rgba(56,189,248,.16), transparent 32rem), var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(100% - 32px, 540px); border:1px solid var(--line); border-radius:24px; background:rgba(15,23,42,.86); padding:24px; box-shadow:0 24px 80px rgb(0 0 0 / .38); }
    h1 { margin:0 0 8px; font-size:22px; } p { margin:0 0 18px; color:var(--muted); }
    #sign-in { min-height:360px; display:grid; place-items:center; }
    .error { color:#fecaca; background:rgba(127,29,29,.35); border:1px solid rgba(248,113,113,.35); border-radius:12px; padding:12px; }
    a { color:var(--accent); }
  </style>
  ${signInScripts}
</head>
<body>
  <main>
    <h1>Sign in to Brain Control Plane</h1>
    <p>Continue with Clerk, then return to the admin page.</p>
    <div id="sign-in">Loading sign-in…</div>
  </main>
  <script type="application/json" id="admin-sign-in-config">${payload}</script>
  <script>
    function withTimeout(promise, ms, message) {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        })
      ]).finally(() => clearTimeout(timer));
    }

    window.addEventListener('load', async function () {
      const root = document.getElementById('sign-in');
      const config = JSON.parse(document.getElementById('admin-sign-in-config').textContent);
      if (!config.publishableKey || !window.Clerk) {
        root.textContent = '';
        const errorBox = document.createElement('div');
        errorBox.className = 'error';
        errorBox.textContent = 'Clerk is not configured for this admin page.';
        root.appendChild(errorBox);
        return;
      }
      try {
        await withTimeout(
          window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } }),
          10000,
          'Timed out loading Clerk sign-in. Check Clerk allowed origins for this domain, browser third-party cookie settings, or network blockers.'
        );
        if (window.Clerk.user) {
          window.location.assign(config.redirectUrl);
          return;
        }
        root.textContent = '';
        window.Clerk.mountSignIn(root, {
          forceRedirectUrl: config.redirectUrl,
          fallbackRedirectUrl: config.redirectUrl,
          signUpForceRedirectUrl: config.redirectUrl,
          signUpFallbackRedirectUrl: config.redirectUrl
        });
      } catch (error) {
        root.textContent = '';
        const errorBox = document.createElement('div');
        errorBox.className = 'error';
        errorBox.textContent = error.message || 'Sign-in failed to load. Please refresh and try again.';
        root.appendChild(errorBox);
      }
    });
  </script>
</body>
</html>`;
}

export function renderAdminPage(config: AppConfig): string {
  const publishableKey = config.clerkPublishableKey ?? "";
  const signInUrl = config.clerkSignInUrl ?? "";
  const publicBaseUrl =
    config.slack.publicBaseUrl || config.admin.publicBaseUrl || "";
  const eventsPath = config.slack.eventsPath;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Brain Control Plane</title>
  <style>
    :root { color-scheme: light dark; --bg:#0f172a; --panel:#111827; --muted:#94a3b8; --text:#e5e7eb; --line:#334155; --accent:#38bdf8; --danger:#f87171; --ok:#4ade80; }
    body { margin: 0; font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    header { padding: 28px 32px; border-bottom: 1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 56px; }
    h1 { margin: 0; font-size: 28px; } h2 { margin: 0 0 12px; font-size: 20px; } h3 { margin: 18px 0 8px; }
    .muted { color: var(--muted); } .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:20px; }
    .card { background: color-mix(in srgb, var(--panel), white 4%); border: 1px solid var(--line); border-radius: 16px; padding: 20px; box-shadow: 0 15px 40px rgb(0 0 0 / .2); }
    label { display:block; font-weight: 650; margin-top: 12px; }
    input, textarea { width: 100%; box-sizing: border-box; margin-top: 6px; border-radius: 10px; border: 1px solid var(--line); background: #020617; color: var(--text); padding: 10px 12px; font: inherit; }
    textarea { min-height: 440px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.45; }
    button { border: 0; border-radius: 999px; padding: 10px 16px; font-weight: 700; background: var(--accent); color:#00111a; cursor:pointer; }
    button.secondary { background:#1e293b; color:var(--text); border:1px solid var(--line); } button.danger { background: var(--danger); color:#220202; }
    .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; } .status { white-space: pre-wrap; border-radius: 12px; padding: 12px; background:#020617; border:1px solid var(--line); }
    .ok { color: var(--ok); } .bad { color: var(--danger); } .hidden { display:none !important; }
    code { background:#020617; border:1px solid var(--line); border-radius:6px; padding:1px 5px; }
    #sign-in { min-height: 420px; display:flex; align-items:center; justify-content:center; }
    #auth-status { max-width: 440px; text-align:right; font-size:13px; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Brain Control Plane</h1>
      <div class="muted">Brain control plane for Slack app configuration and manifest workflow. Full capabilities admin is still future work.</div>
    </div>
    <div class="row"><div id="auth-status" class="muted"></div><div id="user-button"></div><button id="sign-out" class="secondary hidden">Sign out / switch account</button></div>
  </header>
  <main>
    <section id="boot" class="card"><h2>Loading admin…</h2><p class="muted">Checking the server-side allowlist. Clerk account controls load separately so a Clerk client-side delay cannot block this page.</p></section>
    <section id="sign-in-panel" class="card hidden"><h2>Sign in</h2><p class="muted">Use an allowlisted Clerk account.</p><div id="sign-in"></div></section>
    <section id="denied" class="card hidden"><h2>Access denied</h2><p id="denied-message" class="bad"></p><button id="denied-sign-out" class="danger">Sign out / switch account</button></section>
    <section id="app" class="hidden">
      <div class="grid">
        <section class="card">
          <h2>Slack env config</h2>
          <p class="muted">Secrets are write-only here. Existing values are never displayed.</p>
          <div id="config-status" class="status muted">Loading current status…</div>
          <form id="slack-form">
            <label>Slack public base URL <input name="baseUrl" placeholder="https://me.galebach.com" value="${htmlEscape(publicBaseUrl)}" /></label>
            <label>Slack Events path <input name="eventsPath" value="${htmlEscape(eventsPath)}" /></label>
            <label>Slack Signing Secret <input name="signingSecret" type="password" autocomplete="off" placeholder="paste to add/replace" /></label>
            <label>Slack Bot Token <input name="botToken" type="password" autocomplete="off" placeholder="xoxb-…" /></label>
            <label>Slack App Token <input name="appToken" type="password" autocomplete="off" placeholder="optional; not needed for HTTP Events API" /></label>
            <div class="row" style="margin-top:16px"><button type="submit">Write env file</button><button type="button" id="reload-config" class="secondary">Reload status</button></div>
          </form>
          <p class="muted">After writing env vars, restart the service manually unless you used the SSH bootstrap command.</p>
          <div id="save-status" class="status muted hidden"></div>
        </section>
        <section class="card">
          <h2>Rendered Slack manifest</h2>
          <p class="muted">Edit locally, validate, copy, or download. This page does not persist arbitrary manifest templates.</p>
          <div class="row"><button id="copy-manifest" class="secondary">Copy</button><button id="download-manifest" class="secondary">Download</button><button id="validate-manifest" class="secondary">Validate edited JSON</button><button id="reload-manifest" class="secondary">Render again</button></div>
          <p id="manifest-status" class="muted">Loading manifest…</p>
          <textarea id="manifest-text" spellcheck="false"></textarea>
        </section>
      </div>
    </section>
  </main>
  <script>
    const CONFIG = {
      publishableKey: ${jsString(publishableKey)},
      signInUrl: ${jsString(signInUrl)},
      defaultBaseUrl: ${jsString(publicBaseUrl)},
      defaultEventsPath: ${jsString(eventsPath)}
    };

    const $ = (id) => document.getElementById(id);
    const show = (id) => $(id).classList.remove('hidden');
    const hide = (id) => $(id).classList.add('hidden');
    const setText = (id, text) => { $(id).textContent = text; };

    function frontendApiFromPublishableKey(key) {
      const parts = String(key || '').split('_');
      if (parts.length < 3) throw new Error('Invalid CLERK_PUBLISHABLE_KEY');
      return atob(parts[2]).slice(0, -1);
    }

    function loadScript(src, attrs = {}) {
      return new Promise((resolve, reject) => {
        const existing = Array.from(document.scripts).find((script) => script.src === src);
        if (existing) {
          if (existing.dataset.loaded === 'true') resolve();
          else {
            existing.addEventListener('load', resolve, { once: true });
            existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)), { once: true });
          }
          return;
        }
        const script = document.createElement('script');
        script.src = src;
        script.defer = true;
        script.crossOrigin = 'anonymous';
        for (const [key, value] of Object.entries(attrs)) script.setAttribute(key, value);
        script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
        script.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(script);
      });
    }

    function withTimeout(promise, ms, message) {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
        })
      ]).finally(() => clearTimeout(timer));
    }

    function adminSignInUrl() {
      if (CONFIG.signInUrl) return CONFIG.signInUrl;
      const path = location.pathname.replace(/\\/?$/, '/auth/sign-in');
      return path + '?redirect_url=' + encodeURIComponent(location.href);
    }

    let clerkLoadError = '';
    let clerkLoadPromise;

    async function loadClerkControls() {
      if (!CONFIG.publishableKey) throw new Error('CLERK_PUBLISHABLE_KEY is missing; account switch controls are unavailable.');
      const frontendApi = frontendApiFromPublishableKey(CONFIG.publishableKey);
      await withTimeout(loadScript('https://' + frontendApi + '/npm/@clerk/ui@1/dist/ui.browser.js'), 10000, 'Timed out loading Clerk UI bundle.');
      await withTimeout(loadScript('https://' + frontendApi + '/npm/@clerk/clerk-js@6/dist/clerk.browser.js', { 'data-clerk-publishable-key': CONFIG.publishableKey }), 10000, 'Timed out loading Clerk browser SDK.');
      await withTimeout(Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } }), 10000, 'Timed out initializing Clerk. Check Clerk allowed origins for this domain, browser third-party cookie settings, or network blockers.');
      return Clerk;
    }

    function beginClerkLoad() {
      if (!clerkLoadPromise) {
        clerkLoadPromise = loadClerkControls().catch((error) => {
          clerkLoadError = error.message || String(error);
          return null;
        });
      }
      return clerkLoadPromise;
    }

    async function authHeaders() {
      if (typeof window.Clerk?.session?.getToken !== 'function') return {};
      try {
        const token = await withTimeout(window.Clerk.session.getToken(), 2500, 'Timed out getting Clerk session token; falling back to same-origin session cookie.');
        return token ? { authorization: 'Bearer ' + token } : {};
      } catch {
        return {};
      }
    }

    async function api(path, options = {}) {
      const headers = { ...(options.headers || {}), ...(await authHeaders()) };
      if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
      const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
      if (!response.ok) {
        const error = new Error(payload?.error || 'request_failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    async function loadConfigStatus() {
      const data = await api('/api/admin/codex-chat/slack-config');
      const lines = [
        'env file: ' + data.envFile,
        'service: ' + data.serviceName,
        'restart after save: ' + data.restartCommand,
        '',
        ...data.requiredVars.map((name) => name + ': ' + (data.present[name] ? 'present' : 'missing'))
      ];
      setText('config-status', lines.join('\\n'));
      document.querySelector('[name="baseUrl"]').value = data.baseUrl || CONFIG.defaultBaseUrl || '';
      document.querySelector('[name="eventsPath"]').value = data.eventsPath || CONFIG.defaultEventsPath || '/api/slack/events';
    }

    async function loadManifest() {
      const baseUrl = document.querySelector('[name="baseUrl"]').value || CONFIG.defaultBaseUrl;
      const eventsPath = document.querySelector('[name="eventsPath"]').value || CONFIG.defaultEventsPath;
      const query = new URLSearchParams();
      if (baseUrl) query.set('baseUrl', baseUrl);
      if (eventsPath) query.set('eventsPath', eventsPath);
      const data = await api('/api/admin/codex-chat/manifest?' + query.toString());
      $('manifest-text').value = data.text;
      setText('manifest-status', data.validation.ok ? 'Valid manifest for ' + data.requestUrl : 'Invalid manifest: ' + data.validation.errors.join('; '));
      $('manifest-status').className = data.validation.ok ? 'ok' : 'bad';
    }

    async function initialize() {
      const clerkReady = beginClerkLoad();
      let me;
      try {
        me = await api('/api/admin/codex-chat/me');
      } catch (error) {
        hide('boot'); show('denied'); setText('denied-message', 'Server rejected this session: ' + (error.payload?.error || error.message));
        return;
      }
      hide('boot');
      hide('denied'); hide('sign-in-panel'); show('app');
      setText('auth-status', 'Signed in as ' + (me.email || 'an allowlisted Clerk user') + '.');
      show('sign-out');

      void clerkReady.then((clerk) => {
        if (!clerk) {
          setText('auth-status', 'Signed in as ' + (me.email || 'an allowlisted Clerk user') + '. Clerk account controls unavailable: ' + clerkLoadError);
          return;
        }
        try {
          if (clerk.isSignedIn) {
            clerk.mountUserButton($('user-button'));
            setText('auth-status', 'Signed in as ' + (me.email || clerk.user?.primaryEmailAddress?.emailAddress || 'an allowlisted Clerk user') + '.');
          } else {
            setText('auth-status', 'Server session is valid, but Clerk browser state is signed out. Use switch account if needed.');
          }
        } catch (error) {
          setText('auth-status', 'Signed in as ' + (me.email || 'an allowlisted Clerk user') + '. Clerk account controls failed: ' + (error.message || String(error)));
        }
      });

      try {
        await Promise.all([loadConfigStatus(), loadManifest()]);
      } catch (error) {
        show('denied'); setText('denied-message', 'Server rejected this Clerk session: ' + (error.payload?.error || error.message));
      }
    }

    async function signOutOrSwitch() {
      let clerk = window.Clerk || null;
      if (!clerk) {
        setText('auth-status', 'Loading Clerk account controls to sign out…');
        clerk = await withTimeout(beginClerkLoad(), 3000, 'Timed out waiting for Clerk account controls.').catch(() => null);
      }
      if (clerk?.signOut) return clerk.signOut({ redirectUrl: location.pathname });
      window.location.assign(adminSignInUrl());
    }

    $('sign-out').onclick = () => { void signOutOrSwitch(); };
    $('denied-sign-out').onclick = () => { void signOutOrSwitch(); };
    $('reload-config').onclick = () => loadConfigStatus().catch((e) => setText('config-status', e.message));
    $('reload-manifest').onclick = () => loadManifest().catch((e) => setText('manifest-status', e.message));
    $('slack-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const body = Object.fromEntries(form.entries());
      show('save-status'); setText('save-status', 'Writing env file…');
      try {
        const result = await api('/api/admin/codex-chat/slack-config', { method: 'POST', body: JSON.stringify(body) });
        setText('save-status', result.message + '\\n\\nRestart command:\\n' + result.restartCommand);
        event.currentTarget.signingSecret.value = '';
        event.currentTarget.botToken.value = '';
        event.currentTarget.appToken.value = '';
        await Promise.all([loadConfigStatus(), loadManifest()]);
      } catch (error) {
        setText('save-status', 'Failed: ' + (error.payload?.error || error.message));
      }
    };
    $('copy-manifest').onclick = async () => { await navigator.clipboard.writeText($('manifest-text').value); setText('manifest-status', 'Copied manifest to clipboard.'); };
    $('download-manifest').onclick = () => {
      const blob = new Blob([$('manifest-text').value], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'brain-control-plane.slack.manifest.json'; a.click(); URL.revokeObjectURL(url);
    };
    $('validate-manifest').onclick = async () => {
      try {
        const data = await api('/api/admin/codex-chat/manifest/validate', { method: 'POST', body: JSON.stringify({ manifest: $('manifest-text').value }) });
        setText('manifest-status', data.validation.ok ? 'Edited manifest is valid.' : 'Invalid manifest: ' + data.validation.errors.join('; '));
        $('manifest-status').className = data.validation.ok ? 'ok' : 'bad';
      } catch (error) { setText('manifest-status', 'Validation failed: ' + (error.payload?.error || error.message)); $('manifest-status').className = 'bad'; }
    };
    window.addEventListener('load', initialize);
  </script>
</body>
</html>`;
}
