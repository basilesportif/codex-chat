import { describe, expect, test } from "vitest";
import { formatEmojiFollowupInput, singleEmoji } from "../emoji-followup.js";

describe("emoji follow-up normalization", () => {
  test("accepts exactly one emoji grapheme and preserves ordinary emoji text", () => {
    expect(singleEmoji(" ✅ ")).toBe("✅");
    expect(singleEmoji("👨‍👩‍👧‍👦")).toBe("👨‍👩‍👧‍👦");
    expect(singleEmoji("yes ✅")).toBeUndefined();
    expect(singleEmoji("✅ 👍")).toBeUndefined();
    expect(singleEmoji("ok")).toBeUndefined();
  });

  test("includes exact reference, actor, context, and safety instruction", () => {
    const text = formatEmojiFollowupInput({
      emoji: "✅",
      platform: "Slack",
      actorId: "slack:team:T123:user:U234",
      reference: {
        platform: "slack",
        messageId: "100.2",
        content: "Deploy staging?\nExact content.",
        sentAt: "2026-07-12T00:00:00.000Z",
        teamId: "T123",
        channelId: "C345",
        threadId: "100.1"
      },
      interaction: "reaction"
    });
    expect(text).toContain("Confirmed actor: slack:team:T123:user:U234");
    expect(text).toContain("Referenced outbound message ID: 100.2");
    expect(text).toContain('"Deploy staging?\\nExact content."');
    expect(text).toContain("thread_ts=100.1");
    expect(text).toContain("ask a concise clarifying question instead of executing");
  });
});
