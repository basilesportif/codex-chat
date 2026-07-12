import type { OutboundMessageRecord } from "./state.js";

const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A Telegram reply trigger is exactly one emoji grapheme, with no other text. */
export function singleEmoji(value: string): string | undefined {
  const trimmed = value.trim();
  const segments = [...emojiSegmenter.segment(trimmed)].map((part) => part.segment);
  if (segments.length !== 1) return undefined;
  const candidate = segments[0];
  if (!(/\p{Extended_Pictographic}/u.test(candidate) || /\p{Regional_Indicator}{2}/u.test(candidate) || /^[#*0-9]\uFE0F?\u20E3$/u.test(candidate))) return undefined;
  return candidate;
}

export function formatEmojiFollowupInput(input: {
  emoji: string;
  platform: "Telegram" | "Slack";
  actorId: string;
  actorDisplay?: string;
  reference: OutboundMessageRecord;
  interaction: "reply" | "reaction";
}): string {
  const actor = input.actorDisplay ? `${input.actorDisplay} (${input.actorId})` : input.actorId;
  const context = input.reference.platform === "telegram"
    ? `chat_id=${input.reference.chatId}${input.reference.threadId ? `, thread_id=${input.reference.threadId}` : ""}`
    : `team_id=${input.reference.teamId ?? "unknown"}, channel_id=${input.reference.channelId}${input.reference.threadId ? `, thread_ts=${input.reference.threadId}` : ""}`;
  return [
    "[Verified emoji follow-up]",
    `Emoji: ${input.emoji}`,
    `Platform: ${input.platform}`,
    `Interaction: exact ${input.interaction} on a persisted bot-authored outbound message`,
    `Confirmed actor: ${actor}`,
    `Referenced outbound message ID: ${input.reference.messageId}`,
    `Thread/context: ${context}`,
    `Exact referenced outbound message content (JSON string): ${JSON.stringify(input.reference.content)}`,
    "Infer the intended follow-up from the emoji and that exact referenced message. Do not require a pre-created confirmation prompt or action token. Decide whether any inferred action is authorized by the current actor permissions/capabilities and all safety rules. If the intent or target is ambiguous, the action is unsupported, or execution would be high-risk, ask a concise clarifying question instead of executing."
  ].join("\n");
}
