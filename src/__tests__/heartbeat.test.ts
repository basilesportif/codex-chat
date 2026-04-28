import { afterEach, describe, expect, test, vi } from "vitest";
import { CodexHeartbeat } from "../heartbeat.js";
import type { CodexClient, CodexHealth } from "../types.js";

function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof CodexHeartbeat["prototype"]["constructor"]>[2];
}

function fakeCodex(healthSequence: CodexHealth[]): CodexClient {
  let call = 0;
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    health: vi.fn().mockImplementation(async () => healthSequence[Math.min(call++, healthSequence.length - 1)] as CodexHealth),
    sendTurn: vi.fn(),
    resume: vi.fn().mockResolvedValue(undefined)
  } as CodexClient;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodexHeartbeat", () => {
  test("alerts once when threshold is crossed and stays quiet on subsequent failures within reAlertMs", async () => {
    const codex = fakeCodex([
      { ok: false, transport: "app-server", detail: "down" },
      { ok: false, transport: "app-server", detail: "down" },
      { ok: false, transport: "app-server", detail: "down" }
    ]);
    const notifyOps = vi.fn().mockResolvedValue(undefined);
    const hb = new CodexHeartbeat(codex, notifyOps, fakeLogger() as never, 1000, 3, 60_000);

    await (hb as unknown as { check(): Promise<void> }).check();
    await (hb as unknown as { check(): Promise<void> }).check();
    await (hb as unknown as { check(): Promise<void> }).check();

    expect(notifyOps).toHaveBeenCalledTimes(1);
    expect(notifyOps.mock.calls[0]?.[0]).toContain("unhealthy");
  });

  test("re-alerts after reAlertMs while still down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const codex = fakeCodex([{ ok: false, transport: "app-server" }]);
    const notifyOps = vi.fn().mockResolvedValue(undefined);
    const hb = new CodexHeartbeat(codex, notifyOps, fakeLogger() as never, 1000, 1, 60_000);

    await (hb as unknown as { check(): Promise<void> }).check(); // first failure → alert
    expect(notifyOps).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(30_000));
    await (hb as unknown as { check(): Promise<void> }).check(); // 30s in, no re-alert
    expect(notifyOps).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(70_000));
    await (hb as unknown as { check(): Promise<void> }).check(); // 70s in, re-alert
    expect(notifyOps).toHaveBeenCalledTimes(2);
    expect(notifyOps.mock.calls[1]?.[0]).toContain("still unhealthy");
  });

  test("recovery alert announces downtime", async () => {
    const codex = fakeCodex([
      { ok: false, transport: "app-server" },
      { ok: true, transport: "app-server" }
    ]);
    const notifyOps = vi.fn().mockResolvedValue(undefined);
    const hb = new CodexHeartbeat(codex, notifyOps, fakeLogger() as never, 1000, 1, 60_000);

    await (hb as unknown as { check(): Promise<void> }).check();
    await (hb as unknown as { check(): Promise<void> }).check();

    expect(notifyOps).toHaveBeenCalledTimes(2);
    expect(notifyOps.mock.calls[1]?.[0]).toContain("restored");
  });
});
