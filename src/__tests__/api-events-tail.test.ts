import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiGateway } from "../api.js";
import { loadConfig } from "../config.js";
import { FileStore } from "../file-store.js";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";
import { RuntimeEventLog } from "../runtime-events.js";
import { DisabledTranscriber } from "../transcription.js";
import type { SlackTelemetryObservation } from "../slack-telemetry.js";

const tempDirs: string[] = [];
const gateways: ApiGateway[] = [];
const originalEnv = { ...process.env };
const logger = createLogger("silent");
const tailApiKey = ["tail", "key"].join("-");

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.CODEXCHAT_INGEST_API_KEYS = `agent:${tailApiKey}`;
  delete process.env.CODEX_CHAT_SLACK_ENABLED;
  delete process.env.CODEX_CHAT_API_PORT;
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  process.env = { ...originalEnv };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHarness(): Promise<{ baseUrl: string; runtimeEvents: RuntimeEventLog }> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-events-tail-"));
  tempDirs.push(root);
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "codex-chat.toml"), `
version = 1
[service]
workspace = "${root}"
stateDir = "state"
logLevel = "silent"
[api]
enabled = true
host = "127.0.0.1"
port = 0
[transcription]
enabled = false
`);
  const config = await loadConfig(join(configDir, "codex-chat.toml"));
  const state = new StateStore(config);
  await state.init();
  const files = new FileStore(config, state);
  await files.init();
  const runtimeEvents = new RuntimeEventLog(state, logger);
  const gateway = new ApiGateway(config, state, files, new DisabledTranscriber(), logger, {}, runtimeEvents);
  await gateway.start();
  gateways.push(gateway);
  const port = gateway.address()?.port;
  if (!port) throw new Error("test API did not bind a port");
  return { baseUrl: `http://127.0.0.1:${port}`, runtimeEvents };
}

const inboundObservation: SlackTelemetryObservation = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  direction: "inbound",
  outcome: "accepted",
  eventId: "Ev123",
};

async function readFirstSseData(response: Response, controller: AbortController): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 4000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const line = buffer.split("\n").find((entry) => entry.startsWith("data:"));
      if (line) return JSON.parse(line.slice("data:".length).trim()) as Record<string, unknown>;
    }
    throw new Error("no SSE data frame received");
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }
}

async function readFirstSseChunk(response: Response, controller: AbortController): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    if (result === "timeout" || result.done || !result.value) throw new Error("no SSE bytes received");
    return decoder.decode(result.value);
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }
}

async function readSseDataFrames(response: Response, controller: AbortController): Promise<Array<Record<string, unknown>>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<Record<string, unknown>> = [];
  let buffer = "";
  try {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), frames.length > 0 ? 50 : 250)),
      ]);
      if (result === "timeout") break;
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("\n");
        if (data) frames.push(JSON.parse(data) as Record<string, unknown>);
        frameEnd = buffer.indexOf("\n\n");
      }
    }
    return frames;
  } finally {
    controller.abort();
    reader.cancel().catch(() => undefined);
  }
}

describe("runtime events tail endpoint", () => {
  test("refuses when unauthenticated", async () => {
    const { baseUrl } = await makeHarness();
    const response = await fetch(`${baseUrl}/api/events/tail`);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  test("streams buffered runtime events to an authenticated agent", async () => {
    const { baseUrl, runtimeEvents } = await makeHarness();
    runtimeEvents.emitSlackObservation(inboundObservation);
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events/tail`, {
      headers: { Authorization: `Bearer ${tailApiKey}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const event = await readFirstSseData(response, controller);
    expect(event).toMatchObject({ category: "inbound", kind: "inbound.accepted", eventId: "Ev123" });
  });

  test("flushes an idle authenticated tail connection immediately", async () => {
    const { baseUrl } = await makeHarness();
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/events/tail`, {
      headers: { Authorization: `Bearer ${tailApiKey}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(readFirstSseChunk(response, controller)).resolves.toContain(": connected");
  });

  test("replays same-millisecond events exactly once by sequence cursor", async () => {
    const { baseUrl, runtimeEvents } = await makeHarness();
    const ts = "2026-07-05T00:00:00.000Z";
    const first = runtimeEvents.emit({ schemaVersion: 1, ts, category: "context", kind: "context.hydrated" });
    const second = runtimeEvents.emit({ schemaVersion: 1, ts, category: "redaction", kind: "redaction.check" });

    for (const request of [
      { url: `${baseUrl}/api/events/tail`, headers: { "Last-Event-ID": String(first.seq) } },
      { url: `${baseUrl}/api/events/tail?afterSeq=${first.seq}`, headers: {} },
    ]) {
      const controller = new AbortController();
      const response = await fetch(request.url, {
        headers: { Authorization: `Bearer ${tailApiKey}`, ...request.headers },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const frames = await readSseDataFrames(response, controller);
      expect(frames.map((event) => event.seq)).toEqual([second.seq]);
      expect(frames[0]).toMatchObject({ kind: "redaction.check" });
    }
  });
});
