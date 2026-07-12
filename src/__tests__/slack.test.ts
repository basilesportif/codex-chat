import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiGateway, type ApiGatewayHooks } from "../api.js";
import { CAPABILITY_DENIED_MESSAGE } from "../capabilities.js";
import { loadConfig, type AppConfig } from "../config.js";
import { FileStore } from "../file-store.js";
import { createLogger } from "../logger.js";
import { ensureEventRuntimeContext } from "../runtime.js";
import { renderSlackManifest } from "../slack-manifest.js";
import { SlackGateway, normalizeSlackEventCallback, normalizeSlackReactionAdded, slackSignatureForTest, verifySlackRequestSignature } from "../slack.js";
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
  await new Promise((resolve) => setTimeout(resolve, 25));
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
  const capabilityStorePath = join(root, "capabilities.json");
  await writeBrainCapabilityStore(capabilityStorePath);
  process.env.BRAIN_CAPABILITY_STORE_PATH = capabilityStorePath;
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

async function writeBrainCapabilityStore(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    schemaVersion: 2,
    storeId: "test-brain-capabilities",
    mode: "identity_capability_foundation",
    writesEnabled: false,
    enforcementEnabled: false,
    people: [{
      id: "person_tim",
      displayName: "Tim",
      status: "active",
      personType: "human",
      primarySubjectId: "person:person_tim",
      identityIds: [
        "identity_slack_T123_U234",
        "identity_slack_T0BCF7LBNNB_U0BDR0E1KJL"
      ],
      subjectIds: ["person:person_tim"],
      notes: [],
      source: "admin_seed",
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z"
    }],
    externalIdentities: [
      {
        id: "identity_slack_T123_U234",
        provider: "slack",
        providerUserId: "U234",
        providerTeamId: "T123",
        personId: "person_tim",
        label: "Test Tim Slack",
        status: "linked",
        channelKinds: ["slack_workspace"],
        communicationChannelIds: [],
        proofIds: [],
        metadata: { teamId: "T123" },
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z"
      },
      {
        id: "identity_slack_T0BCF7LBNNB_U0BDR0E1KJL",
        provider: "slack",
        providerUserId: "U0BDR0E1KJL",
        providerTeamId: "T0BCF7LBNNB",
        personId: "person_tim",
        label: "Tim Slack (T0BCF7LBNNB/U0BDR0E1KJL)",
        status: "linked",
        channelKinds: ["slack_workspace"],
        communicationChannelIds: [],
        proofIds: [],
        metadata: { teamId: "T0BCF7LBNNB" },
        createdAt: "2026-06-30T00:00:00.000Z",
        updatedAt: "2026-06-30T00:00:00.000Z"
      }
    ],
    identityProofs: [],
    communicationChannels: [],
    subjects: [
      { id: "person:person_tim", kind: "person", label: "Tim", description: "Test Tim", source: "admin_seed", personId: "person_tim" },
      { id: "identity:identity_slack_T123_U234", kind: "external_identity", label: "Test Tim Slack", description: "Test Tim Slack", source: "identity_link", personId: "person_tim", identityId: "identity_slack_T123_U234", externalIds: { teamId: "T123", userId: "U234" } },
      { id: "identity:identity_slack_T0BCF7LBNNB_U0BDR0E1KJL", kind: "external_identity", label: "Tim Slack", description: "Tim Slack", source: "identity_link", personId: "person_tim", identityId: "identity_slack_T0BCF7LBNNB_U0BDR0E1KJL", externalIds: { teamId: "T0BCF7LBNNB", userId: "U0BDR0E1KJL" } }
    ],
    grantBundles: [],
    grants: [
      "slack.event.receive",
      "assistant.run",
      "assistant.context.read",
      "slack.history.read",
      "slack.source.react",
      "output.text.send",
      "subagents.dispatch",
      "subagents.result.deliver"
    ].map((operation) => ({
      id: `grant_seed_tim_${operation.replace(/[^a-z0-9]+/gi, "_")}`,
      subjectId: "person:person_tim",
      capabilityId: operation,
      grantKind: "capability",
      resource: { kind: "global", id: "*", selectors: {
        source: "*", surfaceKind: "*", teamId: "*", channelId: "*", threadTs: "*", messageTs: "*",
        chatId: "*", messageId: "*", conversationSessionId: "*", actorId: "*", targetId: "*",
        targetPolicy: "*", outputType: "*"
      } },
      actions: ["*"],
      source: { kind: "seed", id: "test" },
      grantedBy: "system:test",
      grantedAt: "2026-06-30T00:00:00.000Z",
      status: "active",
      reason: "Test Tim owner Slack grant.",
      enforcement: "enforcing"
    })),
    audit: { appendOnly: true, writesEnabled: false, path: "", values: "", requiredFields: [], eventTypes: [], sampleEvent: {} },
    notes: []
  }, null, 2));
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

async function readCapabilityDecisionRecords(dir: string): Promise<Array<Record<string, unknown>>> {
  const files = await readdir(dir).catch(() => []);
  const records: Array<Record<string, unknown>> = [];
  for (const file of files.filter((item) => item.endsWith(".jsonl"))) {
    const text = await readFile(join(dir, file), "utf8");
    for (const line of text.trim().split("\n")) {
      if (line) records.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return records;
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
      features: { bot_user: { display_name: "Brain" } },
      oauth_config: {
        scopes: {
          bot: expect.arrayContaining(["reactions:write"])
        }
      }
    });
    expect((result.manifest as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot).toContain("reactions:read");
    expect((result.manifest as { settings: { event_subscriptions: { bot_events: string[] } } }).settings.event_subscriptions.bot_events).toContain("reaction_added");
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

  test("normalizes a reaction only when bound to the exact persisted bot outbound message", () => {
    const envelope = slackEnvelope({
      event_id: "EvReaction1",
      event: {
        type: "reaction_added",
        user: "U234",
        reaction: "white_check_mark",
        item_user: "UBOT",
        item: { type: "message", channel: "C345", ts: "1782000001.000200" },
        event_ts: "1782000002.000300"
      }
    });
    const normalized = normalizeSlackReactionAdded(envelope, {
      platform: "slack",
      teamId: "T123",
      channelId: "C345",
      threadId: "1782000000.000100",
      messageId: "1782000001.000200",
      content: "Should I publish the report?",
      sentAt: "2026-07-12T00:00:00.000Z"
    });
    expect(normalized.status).toBe("event");
    if (normalized.status !== "event") throw new Error("expected event");
    expect(normalized.event.text).toContain("Emoji: :white_check_mark:");
    expect(normalized.event.text).toContain("Confirmed actor: slack:team:T123:user:U234");
    expect(normalized.event.text).toContain('"Should I publish the report?"');
    expect(normalized.event.outputTarget).toMatchObject({ channelId: "C345", threadId: "1782000000.000100" });

    expect(normalizeSlackReactionAdded(envelope, {
      platform: "slack", channelId: "C999", messageId: "1782000001.000200", content: "other", sentAt: "now"
    })).toMatchObject({ status: "ignored", reason: "outbound_message_mismatch" });
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
    expect(normalized.event.metadata).toMatchObject({
      slackSourceKind: "public_channel_root",
      slackReplyThreadTs: "1782000000.000100"
    });
    // Runtime no longer fabricates grants; authorization comes solely from
    // Brain decisions at the enforcement gates.
    expect(normalized.event.capabilityGrants).toEqual([]);
  });

  test("normalizes existing thread mentions to continue in the source thread", () => {
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvThread",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> continue this",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000005.000200",
        thread_ts: "1782000000.000100",
        event_ts: "1782000005.000200"
      }
    }), "2026-06-26T00:00:00.000Z");

    expect(normalized.status).toBe("event");
    if (normalized.status !== "event") throw new Error("expected event");
    expect(normalized.event.outputTarget).toMatchObject({
      surfaceKind: "slack",
      channelId: "C345",
      threadId: "1782000000.000100",
      messageId: "1782000005.000200"
    });
    expect(normalized.event.conversationKey?.id).toBe("slack:team:T123:channel:C345:thread:1782000000.000100");
    expect(normalized.event.metadata).toMatchObject({
      slackSourceKind: "thread",
      slackSourceThreadTs: "1782000000.000100",
      slackEventThreadTs: "1782000000.000100",
      slackReplyThreadTs: "1782000000.000100"
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

  test("Slack Events API ignores arbitrary reactions and durably suppresses reaction toggles", async () => {
    const events: UserEvent[] = [];
    const { baseUrl, state } = await apiHarness({ onSlackUserEvent: async (event) => { events.push(event); } });
    const reaction = (eventId: string) => slackEnvelope({
      event_id: eventId,
      event: {
        type: "reaction_added",
        user: "U234",
        reaction: "thumbsup",
        item_user: "UBOT",
        item: { type: "message", channel: "C345", ts: "1782000001.000200" },
        event_ts: "1782000002.000300"
      }
    });

    const arbitrary = await postSlack(baseUrl, reaction("EvReactionArbitrary"));
    await expect(arbitrary.json()).resolves.toMatchObject({ ok: true, ignored: true, reason: "reaction_not_on_persisted_bot_message" });
    expect(events).toHaveLength(0);

    await state.saveOutboundMessage({
      platform: "slack", teamId: "T123", channelId: "C345", threadId: "1782000000.000100",
      messageId: "1782000001.000200", content: "Exact saved bot response", sentAt: "2026-07-12T00:00:00.000Z"
    });
    await expect((await postSlack(baseUrl, reaction("EvReactionFirst"))).json()).resolves.toEqual({ ok: true });
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]?.text).toContain("Exact saved bot response");

    // Slack emits a fresh event_id when a user removes and re-adds the same reaction.
    await expect((await postSlack(baseUrl, reaction("EvReactionReadded"))).json()).resolves.toMatchObject({ ok: true, ignored: true, reason: "duplicate_reaction_toggle" });
    await flush();
    expect(events).toHaveLength(1);
  });

  test("Slack Events API service hook adds an immediate eyes reaction without delaying ack", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const enqueue = vi.spyOn(service, "enqueueUserEvent").mockResolvedValue(undefined);
    const addReaction = vi.spyOn(service.slack, "addReaction").mockResolvedValue({ ok: true });
    await service.api.start();
    gateways.push(service.api);

    const response = await postSlack(`http://127.0.0.1:${service.api.address()?.port}`, slackEnvelope());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    await flush();

    expect(addReaction).toHaveBeenCalledWith({
      channel: "C345",
      timestamp: "1782000000.000100",
      name: "eyes"
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    await waitForSlackTelemetry(
      service.state,
      (value) => value.lastAcceptedEvent?.eventId === "Ev123",
      "Slack immediate reaction hook telemetry",
    );
  });

  test("allows Tim's linked Slack identity through Brain capability enforcement", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const codexTurn = vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "Tim Slack answer." };
    });
    vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: false, error: "test_disabled" });
    const slackSend = vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C0BDR0ECSAC", ts: "1782000002.000100" }]);
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      team_id: "T0BCF7LBNNB",
      event_id: "EvTimSlackAllowed",
      authorizations: [{ team_id: "T0BCF7LBNNB", user_id: "UBOT", is_bot: true }],
      event: {
        type: "app_mention",
        user: "U0BDR0E1KJL",
        text: "<@UBOT> hello from Tim",
        channel: "C0BDR0ECSAC",
        channel_type: "channel",
        team: "T0BCF7LBNNB",
        ts: "1782000000.000100",
        event_ts: "1782000000.000100"
      }
    }), "2026-07-01T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(codexTurn).toHaveBeenCalledTimes(1);
    expect(slackSend).toHaveBeenCalledWith(normalized.event.outputTarget, "Tim Slack answer.");
    // Capability decisions are log-only (pino + capability_decisions/ audit
    // files); the visible Slack telemetry summary intentionally omits them.
  });

  test("denies unknown Slack identities before context hydration, Codex, or subagents", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const codexTurn = vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "must not run" };
    });
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: true, messages: [] });
    const replies = vi.spyOn(service.slack, "fetchConversationReplies").mockResolvedValue({ ok: true, messages: [] });
    const slackSend = vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const dispatch = vi.spyOn((service as unknown as { subagents: { dispatch: (input: unknown) => Promise<string> } }).subagents, "dispatch");
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvUnknownSlackDenied",
      event: {
        type: "app_mention",
        user: "U999",
        text: "<@UBOT> should be denied",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000000.000100",
        event_ts: "1782000000.000100"
      }
    }), "2026-07-01T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(slackSend).toHaveBeenCalledWith(normalized.event.outputTarget, CAPABILITY_DENIED_MESSAGE);
    expect(codexTurn).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(replies).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("adds Slack display name to unknown-actor denial audit records from a cache hit", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    vi.spyOn(service.slack, "cachedUserInfo").mockReturnValue({ displayName: "Ada Example" });
    const lookup = vi.spyOn(service.slack, "getUserInfo").mockResolvedValue({ displayName: "Ada Example" });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvUnknownSlackDisplayNameDenied",
      event: {
        type: "app_mention",
        user: "U999",
        text: "<@UBOT> should be denied",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000000.000100",
        event_ts: "1782000000.000100"
      }
    }), "2026-07-01T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);

    const auditRecords = await readCapabilityDecisionRecords(join(service.state.root, "capability_decisions"));
    expect(auditRecords).toContainEqual(expect.objectContaining({
      allowed: false,
      actorId: "slack:team:T123:user:U999",
      actorDisplayName: "Ada Example",
      reason: "actor_not_linked_to_brain_subject"
    }));
    expect(lookup).not.toHaveBeenCalled();
  });

  test("records unknown-actor denial before sending reply and refreshes users.info after cache miss", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const order: string[] = [];
    const originalRecord = service.state.recordCapabilityDecision.bind(service.state);
    vi.spyOn(service.state, "recordCapabilityDecision").mockImplementation(async (decision) => {
      order.push("record");
      return originalRecord(decision);
    });
    vi.spyOn(service.slack, "cachedUserInfo").mockReturnValue(undefined);
    vi.spyOn(service.slack, "getUserInfo").mockResolvedValue(undefined);
    vi.spyOn(service.slack, "sendText").mockImplementation(async () => {
      order.push("send");
      return [{ channel: "C345", ts: "1782000002.000100" }];
    });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvUnknownSlackNoDisplayNameDenied",
      event: {
        type: "app_mention",
        user: "U998",
        text: "<@UBOT> should be denied",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000000.000100",
        event_ts: "1782000000.000100"
      }
    }), "2026-07-01T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);

    expect(order).toEqual(["record", "send"]);
    const auditRecords = await readCapabilityDecisionRecords(join(service.state.root, "capability_decisions"));
    const record = auditRecords.find((item) => item.actorId === "slack:team:T123:user:U998" && item.reason === "actor_not_linked_to_brain_subject");
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty("actorDisplayName");
    expect(service.slack.getUserInfo).toHaveBeenCalledWith("U998");
  });

  test("enriches subsequent unknown-actor denials after a miss-triggered lookup populates cache", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const cached = vi.spyOn(service.slack, "cachedUserInfo")
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ displayName: "Ada Later" });
    vi.spyOn(service.slack, "getUserInfo").mockResolvedValue({ displayName: "Ada Later" });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const event = {
      type: "app_mention",
      user: "U997",
      text: "<@UBOT> should be denied",
      channel: "C345",
      channel_type: "channel",
      ts: "1782000000.000100",
      event_ts: "1782000000.000100"
    };
    const first = normalizeSlackEventCallback(slackEnvelope({ event_id: "EvUnknownSlackFirstDenied", event }), "2026-07-01T00:00:00.000Z");
    const second = normalizeSlackEventCallback(slackEnvelope({ event_id: "EvUnknownSlackSecondDenied", event: { ...event, ts: "1782000001.000100", event_ts: "1782000001.000100" } }), "2026-07-01T00:00:01.000Z");
    if (first.status !== "event" || second.status !== "event") throw new Error("expected events");

    await service.enqueueUserEvent(first.event);
    await service.enqueueUserEvent(second.event);

    const auditRecords = await readCapabilityDecisionRecords(join(service.state.root, "capability_decisions"));
    const records = auditRecords.filter((item) => item.actorId === "slack:team:T123:user:U997" && item.reason === "actor_not_linked_to_brain_subject");
    expect(records[0]).not.toHaveProperty("actorDisplayName");
    expect(records[1]).toMatchObject({ actorDisplayName: "Ada Later" });
    expect(cached).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["missing", "missing-capabilities.json", undefined],
    ["invalid", "invalid-capabilities.json", "{not-json"],
  ])("denies Slack fail-closed when Brain capability store is %s", async (_label, fileName, contents) => {
    const config = await slackConfig();
    const storePath = join(config.rootDir, fileName);
    if (contents !== undefined) await writeFile(storePath, contents);
    process.env.BRAIN_CAPABILITY_STORE_PATH = storePath;
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const codexTurn = vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "must not run" };
    });
    const slackSend = vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: true, messages: [] });
    const normalized = normalizeSlackEventCallback(slackEnvelope({ event_id: `EvStore${_label}` }), "2026-07-01T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(slackSend).toHaveBeenCalledWith(normalized.event.outputTarget, CAPABILITY_DENIED_MESSAGE);
    expect(codexTurn).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  test("Telegram is fail-closed too when the Brain capability store is missing", async () => {
    const config = await slackConfig();
    process.env.BRAIN_CAPABILITY_STORE_PATH = join(config.rootDir, "missing-capabilities.json");
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const codexTurn = vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (): AsyncIterable<CodexEvent> {
      yield { type: "final", text: "Telegram answer." };
    });
    const telegramSend = vi.spyOn(service.telegram, "sendText").mockResolvedValue();

    await service.enqueueUserEvent({
      source: "telegram",
      chatId: 253768951,
      userId: 253768951,
      username: "tim",
      messageId: 123,
      text: "telegram uses the same Brain enforcement",
      attachments: [],
      receivedAt: "2026-07-01T00:00:00.000Z",
    });
    await waitForIdle(service);

    expect(codexTurn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(telegramSend).toHaveBeenCalledWith(253768951, CAPABILITY_DENIED_MESSAGE, 123, "text"));
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
    vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: false, error: "test_disabled" });
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

  test("hydrates recent channel context for root channel mentions without unrelated thread replies", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    let prompt = "";
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompt = input.text;
      yield { type: "final", text: "Channel-context answer." };
    });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({
      ok: true,
      messages: [
        { type: "message", user: "U111", text: "Channel decision: ship on Friday", channel: "C345", ts: "1781999990.000100" },
        { type: "message", user: "U222", text: "Unrelated thread reply must stay out", channel: "C345", ts: "1781999995.000100", thread_ts: "1781999900.000100" },
        { type: "message", user: "U234", text: "<@UBOT> what did we decide?", channel: "C345", ts: "1782000000.000100" }
      ]
    });
    const replies = vi.spyOn(service.slack, "fetchConversationReplies").mockResolvedValue({ ok: true, messages: [] });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvChannelContext",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> what did we decide?",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000000.000100",
        event_ts: "1782000000.000100"
      }
    }), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C345", latest: "1782000000.000100", limit: 15 }));
    expect(replies).not.toHaveBeenCalled();
    expect(prompt).toContain("source_kind: public_channel_root");
    expect(prompt).toContain("selected_sources: channel_history");
    expect(prompt).toContain("Channel decision: ship on Friday");
    expect(prompt).not.toContain("Unrelated thread reply must stay out");
    const summary = await waitForSlackTelemetry(
      service.state,
      (value) => value.lastContextDecision?.eventId === "EvChannelContext" && value.lastOutboundSuccess?.channelId === "C345",
      "Slack context telemetry",
    );
    expect(summary.lastContextDecision).toMatchObject({
      direction: "context",
      outcome: "hydrated",
      sourceKind: "public_channel_root",
      selectedSources: ["channel_history"],
      messagesIncluded: 1,
      outputThreadTsPresent: true
    });
  });

  test("mango/pineapple canary hydrates pre-invocation top-level channel context only", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    let prompt = "";
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompt = input.text;
      yield { type: "final", text: "mango" };
    });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000045.000100" }]);
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({
      ok: true,
      messages: [
        { type: "message", user: "U234", text: "<@UBOT> what is the secret fruit from recent channel context?", channel: "C345", ts: "1782000040.000100" },
        { type: "message", user: "U111", text: "Context test: remember this for Brain.", channel: "C345", ts: "1782000030.000100" },
        { type: "message", user: "U111", text: "Context test: the secret fruit is mango.", channel: "C345", ts: "1782000020.000100" },
        { type: "message", bot_id: "BBRAIN", subtype: "bot_message", text: "pineapple bot-thread reply must stay out", channel: "C345", ts: "1782000010.000100", thread_ts: "1782000000.000100" },
        { type: "message", user: "U234", text: "<@UBOT> say pineapple", channel: "C345", ts: "1782000000.000100" }
      ]
    });
    const replies = vi.spyOn(service.slack, "fetchConversationReplies").mockResolvedValue({ ok: true, messages: [] });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvMangoCanary",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> what is the secret fruit from recent channel context?",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000040.000100",
        event_ts: "1782000040.000100"
      }
    }), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(history).toHaveBeenCalledWith(expect.objectContaining({ channel: "C345", latest: "1782000040.000100", inclusive: false, limit: 15 }));
    expect(replies).not.toHaveBeenCalled();
    const contextBlock = prompt.slice(
      prompt.indexOf("Slack context hydration"),
      prompt.indexOf("\n\nAvailable employees"),
    );
    expect(contextBlock).toContain("Slack history boundary:");
    expect(contextBlock).toContain("selected_sources: channel_history");
    expect(contextBlock).toContain("<@UBOT> say pineapple");
    expect(contextBlock).toContain("Context test: the secret fruit is mango.");
    expect(contextBlock).toContain("Context test: remember this for Brain.");
    expect(contextBlock).not.toContain("pineapple bot-thread reply must stay out");
    expect(contextBlock).not.toContain("what is the secret fruit from recent channel context?");
    expect(contextBlock.indexOf("<@UBOT> say pineapple")).toBeLessThan(contextBlock.indexOf("Context test: the secret fruit is mango."));
    expect(contextBlock.indexOf("Context test: the secret fruit is mango.")).toBeLessThan(contextBlock.indexOf("Context test: remember this for Brain."));
    expect(prompt).toContain("User content:\nwhat is the secret fruit from recent channel context?");
  });

  test("Slack context fallback tells the model not to infer history from prior turns", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    let prompt = "";
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompt = input.text;
      yield { type: "final", text: "I do not have recent channel history." };
    });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000045.000100" }]);
    vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: false, error: "missing_scope" });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvMissingScopeContext",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> what is the secret fruit from recent channel context?",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000040.000100",
        event_ts: "1782000040.000100"
      }
    }), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(prompt).toContain("selected_sources: source_event_only");
    expect(prompt).toContain("fallbacks: no_channel_history:missing_scope");
    expect(prompt).toContain("Slack history boundary:");
    expect(prompt).toContain("do not infer Slack history from prior Codex turns");
  });

  test("hydrates recent thread context for thread mentions without channel history", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    let prompt = "";
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompt = input.text;
      yield { type: "final", text: "Thread-context answer." };
    });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000006.000100" }]);
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: true, messages: [] });
    const replies = vi.spyOn(service.slack, "fetchConversationReplies").mockResolvedValue({
      ok: true,
      messages: [
        { type: "message", user: "U111", text: "Thread root deploy failed", channel: "C345", ts: "1782000000.000100", thread_ts: "1782000000.000100" },
        { type: "message", user: "U222", text: "Thread reply has the stack trace", channel: "C345", ts: "1782000001.000100", thread_ts: "1782000000.000100" },
        { type: "message", user: "U333", text: "Wrong thread content", channel: "C345", ts: "1782000002.000100", thread_ts: "1781999900.000100" }
      ]
    });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvThreadContext",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> summarize this thread",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000005.000200",
        thread_ts: "1782000000.000100",
        event_ts: "1782000005.000200"
      }
    }), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(history).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalledWith(expect.objectContaining({ channel: "C345", threadTs: "1782000000.000100", latest: "1782000005.000200", limit: 30 }));
    expect(prompt).toContain("source_kind: thread");
    expect(prompt).toContain("selected_sources: thread_replies");
    expect(prompt).toContain("Thread root deploy failed");
    expect(prompt).toContain("Thread reply has the stack trace");
    expect(prompt).not.toContain("Wrong thread content");
    await waitForSlackTelemetry(
      service.state,
      (value) => value.lastContextDecision?.eventId === "EvThreadContext" && value.lastOutboundSuccess?.channelId === "C345",
      "Slack thread context telemetry",
    );
  });

  test("guava thread canary hydrates Slack replies instead of falling back to channel/root context", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    let prompt = "";
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompt = input.text;
      yield { type: "final", text: "guava" };
    });
    const slackSend = vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000060.000100" }]);
    const history = vi.spyOn(service.slack, "fetchConversationHistory").mockResolvedValue({ ok: true, messages: [] });
    const replies = vi.spyOn(service.slack, "fetchConversationReplies").mockResolvedValue({
      ok: true,
      messages: [
        { type: "message", user: "U234", text: "<@UBOT> what is the secret fruit from recent channel context?", channel: "C345", ts: "1782000040.000100", thread_ts: "1782000040.000100" },
        { type: "message", bot_id: "BBRAIN", username: "Brain", text: "The secret fruit is mango.", channel: "C345", ts: "1782000045.000100", thread_ts: "1782000040.000100" },
        { type: "message", user: "U234", text: "Actually the secret fruit is guava", channel: "C345", ts: "1782000050.000100", thread_ts: "1782000040.000100" },
        { type: "message", user: "U234", text: "<@UBOT> what is the secret fruit now?", channel: "C345", ts: "1782000055.000100", thread_ts: "1782000040.000100" }
      ]
    });
    const normalized = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvGuavaThreadCanary",
      event: {
        type: "app_mention",
        user: "U234",
        text: "<@UBOT> what is the secret fruit now?",
        channel: "C345",
        channel_type: "channel",
        ts: "1782000055.000100",
        thread_ts: "1782000040.000100",
        event_ts: "1782000055.000100"
      }
    }), "2026-06-26T00:00:00.000Z");
    if (normalized.status !== "event") throw new Error("expected event");

    await service.enqueueUserEvent(normalized.event);
    await waitForIdle(service);

    expect(history).not.toHaveBeenCalled();
    expect(replies).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C345",
      threadTs: "1782000040.000100",
      latest: "1782000055.000100",
      inclusive: true,
      limit: 30
    }));
    const contextBlock = prompt.slice(
      prompt.indexOf("Slack context hydration"),
      prompt.indexOf("\n\nAvailable employees"),
    );
    expect(contextBlock).toContain("source_kind: thread");
    expect(contextBlock).toContain("selected_sources: thread_replies");
    expect(contextBlock).not.toContain("fallbacks: no_thread_history");
    expect(contextBlock).toContain("The secret fruit is mango.");
    expect(contextBlock).toContain("Actually the secret fruit is guava");
    expect(contextBlock.indexOf("The secret fruit is mango.")).toBeLessThan(contextBlock.indexOf("Actually the secret fruit is guava"));
    expect(prompt).toContain("User content:\nwhat is the secret fruit now?");
    expect(slackSend).toHaveBeenCalledWith(normalized.event.outputTarget, "guava");
    const summary = await waitForSlackTelemetry(
      service.state,
      (value) => value.lastContextDecision?.eventId === "EvGuavaThreadCanary" && value.lastOutboundSuccess?.channelId === "C345",
      "Slack guava thread canary telemetry",
    );
    expect(summary.lastContextDecision).toMatchObject({
      outcome: "hydrated",
      sourceKind: "thread",
      selectedSources: ["thread_replies"],
      messagesIncluded: 4,
    });
  });

  test("does not leak Slack context across channels", async () => {
    const config = await slackConfig();
    const logger = createLogger("silent");
    const service = new ServiceSupervisor(config, logger);
    await service.state.init();
    const prompts: string[] = [];
    vi.spyOn(service.codex, "sendTurn").mockImplementation(async function* (input): AsyncIterable<CodexEvent> {
      prompts.push(input.text);
      yield { type: "final", text: "Scoped answer." };
    });
    vi.spyOn(service.slack, "sendText").mockResolvedValue([{ channel: "C345", ts: "1782000002.000100" }]);
    vi.spyOn(service.slack, "fetchConversationHistory").mockImplementation(async (input) => ({
      ok: true,
      messages: input.channel === "C111"
        ? [{ type: "message", user: "U111", text: "C111 only: pricing launch", channel: "C111", ts: "1781999990.000100" }]
        : [{ type: "message", user: "U222", text: "C222 only: private incident", channel: "C222", ts: "1781999990.000100" }]
    }));
    const first = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvC111",
      event: { type: "app_mention", user: "U234", text: "<@UBOT> context?", channel: "C111", channel_type: "channel", ts: "1782000000.000100", event_ts: "1782000000.000100" }
    }), "2026-06-26T00:00:00.000Z");
    const second = normalizeSlackEventCallback(slackEnvelope({
      event_id: "EvC222",
      event: { type: "app_mention", user: "U234", text: "<@UBOT> context?", channel: "C222", channel_type: "channel", ts: "1782000010.000100", event_ts: "1782000010.000100" }
    }), "2026-06-26T00:00:01.000Z");
    if (first.status !== "event" || second.status !== "event") throw new Error("expected events");

    await service.enqueueUserEvent(first.event);
    await waitForIdle(service);
    await service.enqueueUserEvent(second.event);
    await waitForIdle(service);

    expect(prompts[0]).toContain("C111 only: pricing launch");
    expect(prompts[0]).not.toContain("C222 only: private incident");
    expect(prompts[1]).toContain("C222 only: private incident");
    expect(prompts[1]).not.toContain("C111 only: pricing launch");
    await waitForSlackTelemetry(
      service.state,
      (value) => (value.counters["outbound.success"] ?? 0) >= 2 && value.lastContextDecision?.eventId === "EvC222",
      "Slack channel isolation telemetry",
    );
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

  test("SlackGateway fetches thread replies with GET query arguments", async () => {
    const config = await slackConfig();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/^https:\/\/slack\.com\/api\/conversations\.replies\?/);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("channel")).toBe("C345");
      expect(parsed.searchParams.get("ts")).toBe("1782000040.000100");
      expect(parsed.searchParams.get("latest")).toBe("1782000055.000100");
      expect(parsed.searchParams.get("inclusive")).toBe("true");
      expect(parsed.searchParams.get("limit")).toBe("30");
      return new Response(JSON.stringify({
        ok: true,
        messages: [{ type: "message", user: "U234", text: "Actually the secret fruit is guava", ts: "1782000050.000100", thread_ts: "1782000040.000100" }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);

    await expect(gateway.fetchConversationReplies({
      channel: "C345",
      threadTs: "1782000040.000100",
      latest: "1782000055.000100",
      inclusive: true,
      limit: 30
    })).resolves.toEqual({
      ok: true,
      messages: [{ type: "message", user: "U234", text: "Actually the secret fruit is guava", ts: "1782000050.000100", thread_ts: "1782000040.000100" }],
      responseMetadata: undefined,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

    await expect(gateway.sendText(normalized.event.outputTarget, "hello")).resolves.toEqual([{ channel: "C345", ts: "1782000002.000100", text: "hello" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("SlackGateway adds source-message reactions through reactions.add best-effort", async () => {
    const config = await slackConfig();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { channel?: string; timestamp?: string; name?: string };
      expect(String(_url)).toBe("https://slack.com/api/reactions.add");
      expect(init?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });
      expect(body).toEqual({ channel: "C345", timestamp: "1782000000.000100", name: "eyes" });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);

    await expect(gateway.addReaction({
      channel: "C345",
      timestamp: "1782000000.000100",
      name: "eyes"
    })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("SlackGateway reaction failures return structured best-effort errors", async () => {
    const config = await slackConfig();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);

    await expect(gateway.addReaction({
      channel: "C345",
      timestamp: "1782000000.000100",
      name: "eyes"
    })).resolves.toEqual({ ok: false, error: "already_reacted", status: 200, retryAfterSec: undefined });
  });

  test("SlackGateway fetches users.info display names and caches successes", async () => {
    const config = await slackConfig();
    config.slackBotToken = ["xoxb", "test", "token"].join("-");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      user: {
        name: "ada",
        real_name: "Ada Real",
        profile: { display_name: "Ada Display", real_name: "Ada Profile" }
      }
    }), { status: 200 }));
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);

    await expect(gateway.getUserInfo("U00SYNTH01")).resolves.toEqual({ displayName: "Ada Display", realName: "Ada Profile" });
    await expect(gateway.getUserInfo("U00SYNTH01")).resolves.toEqual({ displayName: "Ada Display", realName: "Ada Profile" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("users.info");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("user=U00SYNTH01");
  });

  test("SlackGateway users.info failures are negative-cached and return undefined", async () => {
    const config = await slackConfig();
    config.slackBotToken = ["xoxb", "test", "token"].join("-");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "user_not_found" }), { status: 200 }));
    const gateway = new SlackGateway(config, createLogger("silent"), fetchImpl as unknown as typeof fetch);

    await expect(gateway.getUserInfo("U00SYNTH02")).resolves.toBeUndefined();
    await expect(gateway.getUserInfo("U00SYNTH02")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
