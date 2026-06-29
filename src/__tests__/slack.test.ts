import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiGateway, type ApiGatewayHooks } from "../api.js";
import { loadConfig, type AppConfig } from "../config.js";
import { FileStore } from "../file-store.js";
import { createLogger } from "../logger.js";
import { ensureEventRuntimeContext } from "../runtime.js";
import { renderSlackManifest } from "../slack-manifest.js";
import { SlackGateway, normalizeSlackEventCallback, slackSignatureForTest, verifySlackRequestSignature } from "../slack.js";
import { ServiceSupervisor } from "../service.js";
import { StateStore } from "../state.js";
import type { SlackTelemetrySummary } from "../slack-telemetry.js";
import type { Transcriber, TranscriptionResult, TranscribeInput } from "../transcription.js";
import type { CodexEvent, UserEvent } from "../types.js";

const tempDirs: string[] = [];
const gateways: ApiGateway[] = [];
const originalEnv = { ...process.env };

class StubTranscriber implements Transcriber {
  readonly transcribe = vi.fn(async (_input: TranscribeInput): Promise<TranscriptionResult> => ({ text: "", mode: _input.mode ?? "regular" }));
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CODEXCHAT_INGEST_API_KEYS;
  process.env.SLACK_SIGNING_SECRET = "test-slack-signing-secret";
  process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(prefix = "codex-chat-slack-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "test behavior\n");
  await writeFile(join(root, "loops.json"), JSON.stringify({ version: 1, defaults: {}, loops: [] }));
  await writeFile(join(root, "monitors.json"), JSON.stringify({ version: 1, monitors: [] }));
  return root;
}

async function slackConfig(extraToml = ""): Promise<AppConfig> {
  const root = await tempRoot();
  const configPath = join(root, "config", "codex-chat.toml");
  await writeFile(configPath, `
version = 1

[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"

[codex]
transport = "app-server"
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
enabled = false
host = "127.0.0.1"
port = 0

[slack]
enabled = true
${extraToml}
`);
  return loadConfig(configPath);
}

async function apiHarness(hooks: ApiGatewayHooks = {}): Promise<{ config: AppConfig; gateway: ApiGateway; baseUrl: string; state: StateStore }> {
  const config = await slackConfig();
  const logger = createLogger("silent");
  const state = new StateStore(config);
  await state.init();
  const files = new FileStore(config, state);
  await files.init();
  const gateway = new ApiGateway(config, state, files, new StubTranscriber(), logger, hooks);
  await gateway.start();
  gateways.push(gateway);
  const port = gateway.address()?.port;
  if (!port) throw new Error("Slack API test did not bind a port");
  return { config, gateway, baseUrl: `http://127.0.0.1:${port}`, state };
}

function slackEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A123",
    event_id: "Ev123",
    event_time: 1_782_000_000,
    authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
    event: {
      type: "app_mention",
      user: "U234",
      text: "<@UBOT> please summarize this thread",
      channel: "C345",
      channel_type: "channel",
      ts: "1782000000.000100",
      event_ts: "1782000000.000100"
    },
    ...overrides
  };
}

async function postSlack(baseUrl: string, payload: Record<string, unknown>, signingSecret = "test-slack-signing-secret"): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  return fetch(`${baseUrl}/api/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": slackSignatureForTest(signingSecret, body, timestamp)
    },
    body
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForSlackTelemetry(
  state: StateStore,
  predicate: (summary: SlackTelemetrySummary) => boolean,
  label = "Slack telemetry summary",
): Promise<SlackTelemetrySummary> {
  for (let i = 0; i < 80; i++) {
    const summary = await state.readSlackTelemetrySummary();
    if (predicate(summary)) return summary;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} was not recorded`);
}

async function waitForIdle(service: ServiceSupervisor): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!(service as unknown as { turnRunning: boolean }).turnRunning) return;
    await flush();
  }
}

describe("Slack runtime foundation", () => {
  test("renders the Brain-branded Slack manifest with the Brain Events URL", async () => {
    const result = await renderSlackManifest({
      rootDir: process.cwd(),
      baseUrl: "https://brain.decisive-outcomes.com",
      eventsPath: "/api/slack/events"
    });

    expect(result.validation).toEqual({ ok: true, errors: [] });
    expect(result.requestUrl).toBe("https://brain.decisive-outcomes.com/api/slack/events");
    expect(result.manifest).toMatchObject({
      display_information: {
        name: "Brain",
        description: "Company-brain Slack surface for Brain."
      },
      features: { bot_user: { display_name: "Brain" } }
    });
  });

  test("verifies Slack request signatures and rejects tampering", () => {
    const body = JSON.stringify({ type: "event_callback" });
    const timestamp = 1_782_000_000;
    const signature = slackSignatureForTest("secret", body, timestamp);

    expect(verifySlackRequestSignature({
      signingSecret: "secret",
      body,
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      nowMs: timestamp * 1000
    })).toEqual({ ok: true });
    expect(verifySlackRequestSignature({
      signingSecret: "secret",
      body: `${body}tampered`,
      timestampHeader: String(timestamp),
      signatureHeader: signature,
      nowMs: timestamp * 1000
    })).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("normalizes app mentions into actor, output target, thread session, and narrow Slack grants", () => {
    const normalized = normalizeSlackEventCallback(slackEnvelope(), "2026-06-26T00:00:00.000Z");

    expect(normalized.status).toBe("event");
    if (normalized.status !== "event") throw new Error("expected event");
    expect(normalized.event.text).toBe("please summarize this thread");
    expect(normalized.event.actor).toMatchObject({
      id: "slack:team:T123:user:U234",
      surfaceKind: "slack",
      surfaceUserId: "U234",
      teamId: "T123"
    });
    expect(normalized.event.outputTarget).toMatchObject({
      surfaceKind: "slack",
      teamId: "T123",
      channelId: "C345",
      threadId: "1782000000.000100",
      messageId: "1782000000.000100",
      routingPolicy: "source_reply"
    });
    expect(normalized.event.conversationKey).toMatchObject({
      id: "slack:team:T123:channel:C345:thread:1782000000.000100",
      surfaceKind: "slack"
    });
    expect(normalized.event.capabilityGrants?.[0]).toMatchObject({
      scope: "temporary",
      operations: expect.arrayContaining(["slack:read_source", "slack:post_source_thread", "subagents:dispatch"]),
      resourceSelectors: { surfaceKind: "slack", teamId: "T123", channelId: "C345", threadTs: "1782000000.000100" }
    });
  });

  test("normalizes Slack DMs as conversation-scoped sessions without requiring a thread", () => {
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvDm",
      event: {
        type: "message",
        user: "U234",
        text: "hello from a DM",
        channel: "D345",
        channel_type: "im",
        ts: "1782000001.000100",
        event_ts: "1782000001.000100"
      }
    }), "2026-06-26T00:00:00.000Z");

    expect(normalized.status).toBe("event");
    if (normalized.status !== "event") throw new Error("expected event");
    expect(normalized.event.conversationKey?.id).toBe("slack:team:T123:conversation:D345");
    expect(normalized.event.outputTarget?.threadId).toBeUndefined();
    expect(normalized.event.text).toBe("hello from a DM");
  });

  test("synthetic subagent callbacks can preserve a Slack output target", () => {
    const normalized = normalizeSlackEventCallback(slackEnvelope(), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");
    const callback: UserEvent = {
      source: "subagent",
      text: "Subagent done.",
      attachments: [],
      receivedAt: "2026-06-26T00:01:00.000Z",
      metadata: {
        defaultOutputTarget: normalized.event.outputTarget,
        conversationSessionId: normalized.event.conversationSessionId,
        correlationId: normalized.event.correlationId
      }
    };

    ensureEventRuntimeContext(callback);

    expect(callback.outputTarget).toMatchObject({
      surfaceKind: "slack",
      channelId: "C345",
      threadId: "1782000000.000100"
    });
    expect(callback.conversationSessionId).toBe(normalized.event.conversationSessionId);
    expect(callback.conversationKey?.id).toBe("slack:team:T123:channel:C345:thread:1782000000.000100");
  });

  test("Slack Events API route fast-acks, enqueues once, and accepts no ingest key", async () => {
    const events: UserEvent[] = [];
    const { baseUrl, config, state } = await apiHarness({
      onSlackUserEvent: async (event) => {
        events.push(event);
      }
    });

    expect(config.api.enabled).toBe(true);
    expect(config.ingest.apiKeys).toEqual([]);
    const first = await postSlack(baseUrl, slackEnvelope());
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("slack");

    const duplicate = await postSlack(baseUrl, slackEnvelope());
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ ok: true, duplicate: true });
    await flush();
    expect(events).toHaveLength(1);

    const summary = await waitForSlackTelemetry(
      state,
      (value) => value.lastAcceptedEvent?.eventId === "Ev123" && value.lastIgnoredOrRejected?.reason === "duplicate_event",
      "accepted and duplicate Slack telemetry",
    );
    expect(summary.lastAcceptedEvent).toMatchObject({
      direction: "inbound",
      outcome: "accepted",
      eventId: "Ev123",
      eventType: "app_mention",
      teamId: "T123",
      channelId: "C345",
      userId: "U234",
      textLength: "<@UBOT> please summarize this thread".length,
    });
    expect(summary.counters["inbound.accepted"]).toBe(1);
    expect(summary.counters["inbound.duplicate"]).toBe(1);
    const rawTelemetry = await readFile(state.path("slack_telemetry/summary.json"), "utf8");
    expect(rawTelemetry).not.toContain("please summarize this thread");
    expect(rawTelemetry).not.toContain("xoxb-test-token");
  });

  test("Slack Events API rejects invalid signatures", async () => {
    const events: UserEvent[] = [];
    const { baseUrl, state } = await apiHarness({
      onSlackUserEvent: async (event) => {
        events.push(event);
      }
    });

    const response = await postSlack(baseUrl, slackEnvelope(), "wrong-secret");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(events).toHaveLength(0);
    const summary = await waitForSlackTelemetry(
      state,
      (value) => value.lastIgnoredOrRejected?.reason === "invalid_signature",
      "invalid signature Slack telemetry",
    );
    expect(summary.lastIgnoredOrRejected).toMatchObject({
      direction: "inbound",
      outcome: "rejected",
      reason: "invalid_signature",
      responseStatus: 401,
    });
    const rawTelemetry = await readFile(state.path("slack_telemetry/summary.json"), "utf8");
    expect(rawTelemetry).not.toContain("please summarize this thread");
    expect(rawTelemetry).not.toContain("test-slack-signing-secret");
  });

  test("service delivers main-loop final text to Slack output target without Telegram", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "Slack answer." };
    });
    const slackSend = vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const telegramSend = vi.spyOn(service.telegram, "sendText").mockResolvedValue();
    const normalized = normalizeSlackEventCallback(slackEnvelope(), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(slackSend).toHaveBeenCalledWith(normalized.event.outputTarget, "Slack answer.");
    expect(telegramSend).not.toHaveBeenCalled();
    const sessionsDir = service.state.path("conversation_sessions");
    const files = await readdir(sessionsDir);
    expect(files).toHaveLength(1);
    const session = JSON.parse(await readFile(join(sessionsDir, files[0]!), "utf8")) as { key?: { id?: string }; defaultOutputTarget?: { channelId?: string } };
    expect(session.key?.id).toBe("slack:team:T123:channel:C345:thread:1782000000.000100");
    expect(session.defaultOutputTarget?.channelId).toBe("C345");
    const summary = await waitForSlackTelemetry(
      service.state,
      (value) => value.lastOutboundSuccess?.channelId === "C345",
      "Slack outbound success telemetry",
    );
    expect(summary.lastOutboundAttempt).toMatchObject({
      direction: "outbound",
      outcome: "attempt",
      channelId: "C345",
      threadTs: "1782000000.000100",
    });
    expect(summary.lastOutboundSuccess).toMatchObject({
      direction: "outbound",
      outcome: "success",
      channelId: "C345",
      threadTs: "1782000000.000100",
      outboundResultCount: 1,
      outboundResultChannels: ["C345"],
    });
    const rawTelemetry = await readFile(service.state.path("slack_telemetry/summary.json"), "utf8");
    expect(rawTelemetry).not.toContain("Slack answer.");
    expect(rawTelemetry).not.toContain("xoxb-test-token");
  });

  test("Slack outbound failure telemetry preserves send failure semantics and redacts body text", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    vi.spyOn(service.slack, "sendText").mockRejectedValue(new Error("Slack chat.postMessage failed: channel_not_found"));
    const normalized = normalizeSlackEventCallback(slackEnvelope(), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await expect((service as unknown as {
      sendTextToOutputTarget: (target: UserEvent["outputTarget"], text: string) => Promise<void>;
    }).sendTextToOutputTarget(normalized.event.outputTarget, "Do not store this Slack reply body")).rejects.toThrow("channel_not_found");

    const summary = await waitForSlackTelemetry(
      service.state,
      (value) => value.lastOutboundFailure?.reason?.includes("channel_not_found") === true,
      "Slack outbound failure telemetry",
    );
    expect(summary.lastOutboundFailure).toMatchObject({
      direction: "outbound",
      outcome: "failure",
      channelId: "C345",
      threadTs: "1782000000.000100",
      reason: "Slack chat.postMessage failed: channel_not_found",
    });
    const rawTelemetry = await readFile(service.state.path("slack_telemetry/summary.json"), "utf8");
    expect(rawTelemetry).not.toContain("Do not store this Slack reply body");
  });

  test("SlackGateway posts source-thread text through chat.postMessage without exposing tokens to tests", async () => {
    const config = await slackConfig();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { channel?: string; thread_ts?: string; text?: string };
      expect(init?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });
      expect(body).toMatchObject({ channel: "C345", thread_ts: "1782000000.000100", text: "hello" });
      return new Response(JSON.stringify({ ok: true, channel: "C345", ts: "1782000002.000100" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);
    const normalized = normalizeSlackEventCallback(slackEnvelope(), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await expect(gateway.sendText(normalized.event.outputTarget, "hello")).resolves.toEqual([{ channel: "C345", ts: "1782000002.000100" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
