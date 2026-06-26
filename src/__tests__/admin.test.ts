import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { authorizeAdminRequest, parseAdminAllowedEmails } from "../admin-auth.js";
import { ApiGateway, type ApiGatewayHooks } from "../api.js";
import { loadConfig, type AppConfig } from "../config.js";
import { mergeEnvFileText, writeMergedEnvFile } from "../env-file.js";
import { FileStore } from "../file-store.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";
import type { Transcriber, TranscribeInput, TranscriptionResult } from "../transcription.js";

const tempDirs: string[] = [];
const gateways: ApiGateway[] = [];
const originalEnv = { ...process.env };

class StubTranscriber implements Transcriber {
  readonly transcribe = vi.fn(async (_input: TranscribeInput): Promise<TranscriptionResult> => ({ text: "", mode: _input.mode ?? "regular" }));
}

function fakeRequest(token?: string): { headers: Record<string, string | undefined> } {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

async function tempRoot(prefix = "codex-chat-admin-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "test behavior\n");
  await writeFile(join(root, "loops.json"), JSON.stringify({ version: 1, defaults: {}, loops: [] }));
  await writeFile(join(root, "monitors.json"), JSON.stringify({ version: 1, monitors: [] }));
  await mkdir(join(root, "slack-app"), { recursive: true });
  await writeFile(join(root, "slack-app", "manifest.json"), await readFile(join(process.cwd(), "slack-app", "manifest.json"), "utf8"));
  return root;
}

async function adminConfig(envFile?: string): Promise<AppConfig> {
  const root = await tempRoot();
  const configPath = join(root, "config", "codex-chat.toml");
  await writeFile(configPath, `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[codex]
startupTimeoutSec = 1
turnTimeoutSec = 1

[behavior]
dir = "."
entrypoint = "AGENTS.md"

[loops]
enabled = false
path = "loops.json"

[monitors]
enabled = false
path = "monitors.json"

[transcription]
enabled = false

[api]
enabled = true
host = "127.0.0.1"
port = 0

[admin]
enabled = true
envFile = "${envFile ?? join(root, "env")}"
publicBaseUrl = "https://me.galebach.com"
`);
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk";
  process.env.CLERK_SECRET_KEY = "sk_test_secret";
  process.env.CLERK_ALLOWED_EMAILS = "timgalebachukraine@gmail.com,tim.galebach@gmail.com";
  return loadConfig(configPath);
}

async function apiHarness(envFile?: string, hooks: ApiGatewayHooks = {}): Promise<{ config: AppConfig; baseUrl: string }> {
  const config = await adminConfig(envFile);
  const logger = createLogger("silent");
  const state = new StateStore(config);
  await state.init();
  const files = new FileStore(config, state);
  await files.init();
  const gateway = new ApiGateway(config, state, files, new StubTranscriber(), logger, hooks);
  await gateway.start();
  gateways.push(gateway);
  const port = gateway.address()?.port;
  if (!port) throw new Error("Admin API test did not bind a port");
  return { config, baseUrl: `http://127.0.0.1:${port}` };
}

async function authFetch(baseUrl: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...(init.headers ?? {}), authorization: "Bearer test-token" } });
}

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("admin auth", () => {
  test("parses allowlist case-insensitively", () => {
    expect(parseAdminAllowedEmails(" Tim.Galebach@Gmail.com,\ntimgalebachukraine@gmail.com ")).toEqual(new Set([
      "tim.galebach@gmail.com",
      "timgalebachukraine@gmail.com"
    ]));
  });

  test("fails closed when Clerk keys or allowed emails are missing", async () => {
    await expect(authorizeAdminRequest(fakeRequest("token") as never, { clerkSecretKey: "sk", clerkPublishableKey: "pk", clerkAllowedEmails: "" })).resolves.toMatchObject({ ok: false, statusCode: 403, error: "admin_allowlist_empty" });
    await expect(authorizeAdminRequest(fakeRequest("token") as never, { clerkSecretKey: "sk", clerkPublishableKey: "", clerkAllowedEmails: "tim.galebach@gmail.com" })).resolves.toMatchObject({ ok: false, statusCode: 503, error: "admin_auth_not_configured" });
  });

  test("allows only configured Clerk user emails", async () => {
    const verifyTokenImpl = vi.fn(async () => ({ sub: "user_123" }) as never);
    const getUser = vi.fn(async () => ({
      primaryEmailAddressId: "email_1",
      emailAddresses: [{ id: "email_1", emailAddress: "Tim.Galebach@Gmail.com" }]
    }));

    await expect(authorizeAdminRequest(fakeRequest("token") as never, {
      clerkSecretKey: "sk",
      clerkPublishableKey: "pk",
      clerkAllowedEmails: "tim.galebach@gmail.com"
    }, { verifyTokenImpl, getUser })).resolves.toMatchObject({ ok: true, admin: { email: "tim.galebach@gmail.com" } });

    await expect(authorizeAdminRequest(fakeRequest("token") as never, {
      clerkSecretKey: "sk",
      clerkPublishableKey: "pk",
      clerkAllowedEmails: "someone@example.com"
    }, { verifyTokenImpl, getUser })).resolves.toMatchObject({ ok: false, statusCode: 403, error: "forbidden" });
  });

  test("accepts Clerk __session cookie for server-rendered admin page auth", async () => {
    const verifyTokenImpl = vi.fn(async () => ({ sub: "user_123" }) as never);
    const getUser = vi.fn(async () => ({
      primaryEmailAddressId: "email_1",
      emailAddresses: [{ id: "email_1", emailAddress: "tim.galebach@gmail.com" }]
    }));

    await expect(authorizeAdminRequest({ headers: { cookie: "__session=cookie-token" } } as never, {
      clerkSecretKey: "sk",
      clerkPublishableKey: "pk",
      clerkAllowedEmails: "tim.galebach@gmail.com"
    }, { verifyTokenImpl, getUser })).resolves.toMatchObject({ ok: true });
    expect(verifyTokenImpl).toHaveBeenCalledWith("cookie-token", { secretKey: "sk" });
  });
});

describe("admin env file management", () => {
  test("merges env vars while preserving unrelated lines", () => {
    const merged = mergeEnvFileText("# keep\nFOO=bar\nSLACK_BOT_TOKEN=old\nexport CODEX_CHAT_SLACK_ENABLED=false\n", {
      SLACK_BOT_TOKEN: "xoxb-new value",
      CODEX_CHAT_SLACK_ENABLED: "true",
      SLACK_SIGNING_SECRET: "it's secret"
    });

    expect(merged).toContain("# keep\nFOO=bar\n");
    expect(merged).toContain("SLACK_BOT_TOKEN='xoxb-new value'");
    expect(merged).toContain("CODEX_CHAT_SLACK_ENABLED='true'");
    expect(merged).toContain("SLACK_SIGNING_SECRET='it'\"'\"'s secret'");
  });

  test("writes env file with chmod 600", async () => {
    const root = await tempRoot();
    const envFile = join(root, "nested", "env");
    await writeMergedEnvFile(envFile, { SLACK_BOT_TOKEN: "xoxb-test", CODEX_CHAT_SLACK_ENABLED: "true" });
    const mode = (await stat(envFile)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(envFile, "utf8")).toContain("SLACK_BOT_TOKEN='xoxb-test'");
  });
});

describe("admin routes", () => {
  test("admin page route is server-authenticated", async () => {
    const { baseUrl } = await apiHarness(undefined, {
      adminAuthDeps: {
        verifyTokenImpl: vi.fn(async () => ({ sub: "user_123" }) as never),
        getUser: vi.fn(async () => ({
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "tim.galebach@gmail.com" }]
        }))
      }
    });

    const noAuth = await fetch(`${baseUrl}/admin/codex-chat/`);
    expect(noAuth.status).toBe(401);
    const authed = await fetch(`${baseUrl}/admin/codex-chat/`, { headers: { cookie: "__session=test-token" } });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain("codex-chat admin");
  });

  test("render manifest route requires auth and returns validated manifest", async () => {
    const { baseUrl } = await apiHarness(undefined, {
      adminAuthDeps: {
        verifyTokenImpl: vi.fn(async () => ({ sub: "user_123" }) as never),
        getUser: vi.fn(async () => ({
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "tim.galebach@gmail.com" }]
        }))
      }
    });
    const noAuth = await fetch(`${baseUrl}/api/admin/codex-chat/manifest`);
    expect(noAuth.status).toBe(401);

    const response = await authFetch(baseUrl, "/api/admin/codex-chat/manifest?baseUrl=https%3A%2F%2Fme.galebach.com&eventsPath=%2Fapi%2Fslack%2Fevents");
    expect(response.status).toBe(200);
    const payload = await response.json() as { validation: { ok: boolean }; requestUrl: string };
    expect(payload.validation.ok).toBe(true);
    expect(payload.requestUrl).toBe("https://me.galebach.com/api/slack/events");
  });

  test("Slack config route writes only redacted status and no secret echo", async () => {
    const root = await tempRoot();
    const envFile = join(root, "env");
    const { baseUrl } = await apiHarness(envFile, {
      adminAuthDeps: {
        verifyTokenImpl: vi.fn(async () => ({ sub: "user_123" }) as never),
        getUser: vi.fn(async () => ({
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "tim.galebach@gmail.com" }]
        }))
      }
    });

    // Monkey-patch the route auth by using the exported auth tests separately; here verify that unauthenticated API fails closed.
    const response = await fetch(`${baseUrl}/api/admin/codex-chat/slack-config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signingSecret: "secret", botToken: "xoxb-secret" })
    });
    expect(response.status).toBe(401);

    const authed = await authFetch(baseUrl, "/api/admin/codex-chat/slack-config", {
      method: "POST",
      body: JSON.stringify({ signingSecret: "secret-value", botToken: "xoxb-secret-value", baseUrl: "https://me.galebach.com", eventsPath: "/api/slack/events" })
    });
    expect(authed.status).toBe(200);
    const payload = await authed.json() as { message: string };
    expect(JSON.stringify(payload)).not.toContain("secret-value");
    const written = await readFile(envFile, "utf8");
    expect(written).toContain("SLACK_SIGNING_SECRET='secret-value'");
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  });
});
