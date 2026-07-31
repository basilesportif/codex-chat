import { describe, expect, test } from "vitest";
import { formatTemporalAnchorBlock, temporalAnchorForEvent } from "../temporal.js";

describe("per-message temporal anchors", () => {
  test("uses Telegram source time instead of delayed processing time across Eastern midnight", () => {
    const anchor = temporalAnchorForEvent({
      sourceTimestamp: "2026-07-23T03:30:00.000Z", // Jul 22 23:30 Eastern
      receivedAt: "2026-07-23T05:30:00.000Z" // Jul 23 01:30 Eastern
    }, "America/New_York");

    expect(anchor.anchorAt).toBe("2026-07-23T03:30:00.000Z");
    const prompt = formatTemporalAnchorBlock(anchor);
    expect(prompt).toContain("anchor_local_datetime: 2026-07-22T23:30:00");
    expect(prompt).toContain("processing_delay_seconds: 7200");
    expect(prompt).toContain("explicit timezone named by the user overrides configured_timezone");
  });

  test("falls back to received time when a source has no timestamp", () => {
    const anchor = temporalAnchorForEvent({ receivedAt: "2026-07-23T04:30:00Z" }, "America/New_York");
    expect(anchor.anchorAt).toBe("2026-07-23T04:30:00.000Z");
    expect(anchor.sourceTimestamp).toBeUndefined();
  });
});
