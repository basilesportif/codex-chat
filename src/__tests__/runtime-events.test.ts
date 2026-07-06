import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../logger.js";
import { StateStore } from "../state.js";
import { RuntimeEventLog, runtimeEventsFromSlackObservation, type RuntimeEvent } from "../runtime-events.js";
import type { SlackTelemetryObservation } from "../slack-telemetry.js";
import type { AppConfig } from "../config.js";

const tempDirs: string[] = [];
const logger = createLogger("silent");

function testConfig(rootDir: string): AppConfig {
  return {
    rootDir,
    configPath: join(rootDir, "config", "codex-chat.toml"),
    service: { stateDir: "state" },
  } as AppConfig;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-chat-runtime-events-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function inboundObservation(overrides: Partial<SlackTelemetryObservation> = {}): SlackTelemetryObservation {
  return {
    schemaVersion: 1,
    observedAt: "2026-07-05T00:00:00.000Z",
    direction: "inbound",
    outcome: "accepted",
    eventId: "Ev123",
    channelId: "C123",
    ...overrides,
  };
}

describe("runtimeEventsFromSlackObservation", () => {
  test("maps an inbound observation to a single categorized event", () => {
    const [event, ...rest] = runtimeEventsFromSlackObservation(inboundObservation({ reason: "ok" }));
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      schemaVersion: 1,
      category: "inbound",
      kind: "inbound.accepted",
      surface: "slack",
      outcome: "accepted",
      eventId: "Ev123",
      channelId: "C123",
      reason: "ok",
    });
    expect(event.ts).toBe("2026-07-05T00:00:00.000Z");
  });

  test("context observation additionally yields a redaction-check event", () => {
    const events = runtimeEventsFromSlackObservation({
      schemaVersion: 1,
      observedAt: "2026-07-05T00:00:00.000Z",
      direction: "context",
      outcome: "hydrated",
      promptExposed: false,
      messagesIncluded: 3,
    });
    expect(events.map((event) => event.kind)).toEqual(["context.hydrated", "redaction.check"]);
    const redaction = events[1];
    expect(redaction).toMatchObject({ category: "redaction", outcome: "redacted", redactionApplied: true });
  });

  test("capability observations are not duplicated into runtime events", () => {
    expect(
      runtimeEventsFromSlackObservation({
        schemaVersion: 1,
        observedAt: "2026-07-05T00:00:00.000Z",
        direction: "capability",
        outcome: "denied",
      }),
    ).toEqual([]);
  });

  test("carries no message-body or secret-shaped fields", () => {
    const event = runtimeEventsFromSlackObservation(inboundObservation({ reason: "hi" }))[0];
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("text");
    expect(serialized).not.toContain("token");
    // Only known scalar keys are present.
    expect(Object.keys(event).sort()).toEqual(
      ["category", "channelId", "eventId", "kind", "outcome", "reason", "schemaVersion", "surface", "ts"].sort(),
    );
  });
});

describe("RuntimeEventLog", () => {
  test("emits to subscribers, buffers, and persists", async () => {
    const root = await tempRoot();
    const state = new StateStore(testConfig(root));
    await state.init();
    const log = new RuntimeEventLog(state, logger);
    const received: RuntimeEvent[] = [];
    const unsubscribe = log.subscribe((event) => received.push(event));

    log.emitSlackObservation(inboundObservation());
    // allow the async jsonl append to settle
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(1);
    expect(received[0].id).toMatch(/^evt_/);
    expect(received[0].seq).toBe(1);
    expect(log.recentAfter()).toHaveLength(1);

    const day = "2026-07-05";
    const raw = await readFile(join(root, "state", "runtime_events", `${day}.jsonl`), "utf8");
    const persisted = JSON.parse(raw.trim()) as RuntimeEvent;
    expect(persisted.kind).toBe("inbound.accepted");
    expect(persisted.id).toBe(received[0].id);
    expect(persisted.seq).toBe(1);

    unsubscribe();
    log.emitSlackObservation(inboundObservation());
    expect(received).toHaveLength(1);
  });

  test("recentAfter filters by timestamp and unsubscribing stops delivery", () => {
    const state = { recordRuntimeEvent: vi.fn(async () => undefined) };
    const log = new RuntimeEventLog(state, logger);
    log.emit({ schemaVersion: 1, ts: "2026-07-05T00:00:00.000Z", category: "inbound", kind: "inbound.accepted" });
    log.emit({ schemaVersion: 1, ts: "2026-07-05T00:05:00.000Z", category: "inbound", kind: "inbound.rejected" });
    expect(log.recentAfter("2026-07-05T00:02:00.000Z").map((event) => event.kind)).toEqual(["inbound.rejected"]);
    expect(state.recordRuntimeEvent).toHaveBeenCalledTimes(2);
  });

  test("recentAfterSeq replays same-millisecond events without loss", () => {
    const state = { recordRuntimeEvent: vi.fn(async () => undefined) };
    const log = new RuntimeEventLog(state, logger);
    const first = log.emit({ schemaVersion: 1, ts: "2026-07-05T00:00:00.000Z", category: "context", kind: "context.hydrated" });
    const second = log.emit({ schemaVersion: 1, ts: first.ts, category: "redaction", kind: "redaction.check" });

    expect(second.seq).toBe(first.seq + 1);
    expect(log.recentAfterSeq(first.seq).map((event) => event.kind)).toEqual(["redaction.check"]);
  });

  test("bounds the in-memory buffer", () => {
    const state = { recordRuntimeEvent: vi.fn(async () => undefined) };
    const log = new RuntimeEventLog(state, logger, 3);
    for (let i = 0; i < 10; i++) {
      log.emit({ schemaVersion: 1, ts: new Date(i * 1000).toISOString(), category: "inbound", kind: "inbound.accepted" });
    }
    expect(log.recentAfter()).toHaveLength(3);
  });
});
