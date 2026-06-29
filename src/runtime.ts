import { createHash } from "node:crypto";
import type {
  ActorContext,
  CapabilityCheckResult,
  CapabilityGrant,
  ConversationKey,
  ConversationSession,
  OutputTarget,
  ProgressEvent,
  RunContext,
  SurfaceKind,
  UserEvent
} from "./types.js";
import { makeId, nowIso } from "./util.js";

const TELEGRAM_ADMIN_OPERATIONS = [
  "telegram:read",
  "telegram:write",
  "telegram:react",
  "service:commands",
  "service:deploy",
  "subagents:dispatch",
  "subagents:control",
  "runtime:admin",
  "runtime:*",
  "*"
];

const TELEGRAM_USER_OPERATIONS = [
  "telegram:read",
  "telegram:write",
  "telegram:react",
  "service:commands",
  "subagents:dispatch"
];

const SLACK_SOURCE_OPERATIONS = [
  "slack:read_source",
  "slack:post_source",
  "slack:post_source_thread",
  "slack:progress_source",
  "subagents:dispatch"
];

export interface TelegramRuntimeInput {
  chatId: number;
  userId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  messageId?: number;
  messageThreadId?: number;
  chatType?: string;
  chatTitle?: string;
  isAdmin?: boolean;
  receivedAt?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export interface SlackRuntimeInput {
  teamId: string;
  enterpriseId?: string;
  channelId: string;
  channelType?: string;
  userId: string;
  userName?: string;
  userDisplayName?: string;
  botUserId?: string;
  messageTs: string;
  threadTs?: string;
  eventId?: string;
  eventTime?: number;
  retryNum?: number;
  retryReason?: string;
  receivedAt?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

export function buildTelegramRuntimeContext(input: TelegramRuntimeInput): {
  correlationId: string;
  actor: ActorContext;
  outputTarget: OutputTarget;
  conversationKey: ConversationKey;
  conversationSessionId: string;
  capabilityGrants: CapabilityGrant[];
} {
  const correlationId = input.correlationId ?? makeId("corr");
  const conversationKey = buildTelegramConversationKey(input);
  const conversationSessionId = conversationSessionIdForKey(conversationKey);
  const actor = buildTelegramActorContext({ ...input, correlationId });
  const outputTarget = buildTelegramOutputTarget(input);
  const capabilityGrants = buildTelegramCapabilityGrants({
    actor,
    chatId: input.chatId,
    conversationSessionId,
    isAdmin: input.isAdmin === true,
    createdAt: input.receivedAt
  });
  return { correlationId, actor, outputTarget, conversationKey, conversationSessionId, capabilityGrants };
}

export function buildSlackRuntimeContext(input: SlackRuntimeInput): {
  correlationId: string;
  actor: ActorContext;
  outputTarget: OutputTarget;
  conversationKey: ConversationKey;
  conversationSessionId: string;
  capabilityGrants: CapabilityGrant[];
} {
  const correlationId = input.correlationId ?? (input.eventId ? `slack:${input.eventId}` : makeId("corr"));
  const conversationKey = buildSlackConversationKey(input);
  const conversationSessionId = conversationSessionIdForKey(conversationKey);
  const actor = buildSlackActorContext({ ...input, correlationId });
  const outputTarget = buildSlackOutputTarget(input);
  const capabilityGrants = buildSlackCapabilityGrants({
    actor,
    teamId: input.teamId,
    channelId: input.channelId,
    threadTs: outputTarget.threadId,
    conversationSessionId,
    createdAt: input.receivedAt
  });
  return { correlationId, actor, outputTarget, conversationKey, conversationSessionId, capabilityGrants };
}

export function withTelegramRuntimeContext<T extends UserEvent>(
  event: T,
  input: TelegramRuntimeInput
): T {
  const runtime = buildTelegramRuntimeContext(input);
  return Object.assign(event, runtime, {
    metadata: {
      ...event.metadata,
      correlationId: runtime.correlationId,
      conversationSessionId: runtime.conversationSessionId,
      conversationKey: runtime.conversationKey.id
    }
  });
}

export function withSlackRuntimeContext<T extends UserEvent>(
  event: T,
  input: SlackRuntimeInput
): T {
  const runtime = buildSlackRuntimeContext(input);
  return Object.assign(event, runtime, {
    metadata: {
      ...event.metadata,
      correlationId: runtime.correlationId,
      conversationSessionId: runtime.conversationSessionId,
      conversationKey: runtime.conversationKey.id
    }
  });
}

export function buildSyntheticRuntimeContext(event: UserEvent): {
  correlationId: string;
  actor: ActorContext;
  outputTarget: OutputTarget;
  conversationKey: ConversationKey;
  conversationSessionId: string;
  capabilityGrants: CapabilityGrant[];
} {
  if (event.source === "telegram" && event.chatId !== undefined && event.userId !== undefined) {
    return buildTelegramRuntimeContext({
      chatId: event.chatId,
      userId: event.userId,
      username: event.username,
      messageId: event.messageId,
      messageThreadId: telegramMessageThreadId(event),
      isAdmin: Boolean(event.actor?.isAdmin),
      receivedAt: event.receivedAt,
      correlationId: event.correlationId,
      metadata: event.metadata
    });
  }
  if (event.source === "slack" && event.metadata) {
    const teamId = stringMetadata(event.metadata, "slackTeamId");
    const channelId = stringMetadata(event.metadata, "slackChannelId");
    const userId = stringMetadata(event.metadata, "slackUserId");
    const messageTs = stringMetadata(event.metadata, "slackMessageTs");
    if (teamId && channelId && userId && messageTs) {
      return buildSlackRuntimeContext({
        teamId,
        enterpriseId: stringMetadata(event.metadata, "slackEnterpriseId"),
        channelId,
        channelType: stringMetadata(event.metadata, "slackChannelType"),
        userId,
        userName: event.username,
        botUserId: stringMetadata(event.metadata, "slackBotUserId"),
        messageTs,
        threadTs: stringMetadata(event.metadata, "slackThreadTs"),
        eventId: stringMetadata(event.metadata, "slackEventId"),
        eventTime: numberMetadata(event.metadata, "slackEventTime"),
        retryNum: numberMetadata(event.metadata, "slackRetryNum"),
        retryReason: stringMetadata(event.metadata, "slackRetryReason"),
        receivedAt: event.receivedAt,
        correlationId: event.correlationId,
        metadata: event.metadata
      });
    }
  }
  const preservedOutputTarget = event.outputTarget
    ?? outputTargetMetadata(event.metadata, "defaultOutputTarget")
    ?? outputTargetMetadata(event.metadata, "originTarget");
  const surfaceKind = preservedOutputTarget?.surfaceKind ?? surfaceKindForEvent(event.source);
  const correlationId = event.correlationId ?? (typeof event.metadata?.correlationId === "string" ? event.metadata.correlationId : makeId("corr"));
  const key: ConversationKey = event.conversationKey ?? conversationKeyFromOutputTarget(preservedOutputTarget) ?? {
    id: `${surfaceKind}:${event.chatId ?? event.metadata?.originChatId ?? "default"}`,
    surfaceKind,
    chatId: event.chatId !== undefined ? String(event.chatId) : undefined,
    metadata: event.metadata
  };
  const conversationSessionId = typeof event.metadata?.conversationSessionId === "string"
    ? event.metadata.conversationSessionId
    : conversationSessionIdForKey(key);
  const actor: ActorContext = {
    id: `${surfaceKind}:system`,
    surfaceKind,
    isAdmin: true,
    isPersonalOwner: surfaceKind === "system",
    correlationId,
    metadata: event.metadata
  };
  const outputTarget: OutputTarget = preservedOutputTarget ?? (event.chatId !== undefined
    ? buildTelegramOutputTarget({
      chatId: event.chatId,
      userId: event.userId ?? 0,
      username: event.username,
      messageId: event.messageId,
      messageThreadId: telegramMessageThreadId(event),
      correlationId,
      receivedAt: event.receivedAt,
      metadata: event.metadata
    })
    : {
      id: `${surfaceKind}:silent`,
      surfaceKind,
      routingPolicy: "silent",
      allowedOutputTypes: ["artifact"],
      metadata: event.metadata
    });
  const grant = systemGrant(actor, conversationSessionId, event.receivedAt);
  return { correlationId, actor, outputTarget, conversationKey: key, conversationSessionId, capabilityGrants: [grant] };
}

export function ensureEventRuntimeContext<T extends UserEvent>(event: T): T {
  if (event.actor && event.outputTarget && event.conversationKey && event.conversationSessionId && event.capabilityGrants) {
    return event;
  }
  const runtime = buildSyntheticRuntimeContext(event);
  return Object.assign(event, runtime, {
    metadata: {
      ...event.metadata,
      correlationId: runtime.correlationId,
      conversationSessionId: runtime.conversationSessionId,
      conversationKey: runtime.conversationKey.id
    }
  });
}

export function buildRunContext(input: {
  event: UserEvent;
  runId: string;
  parentRunId?: string;
  artifactDir?: string;
  createdAt?: string;
}): RunContext {
  const event = ensureEventRuntimeContext(input.event);
  const createdAt = input.createdAt ?? nowIso();
  return {
    runId: input.runId,
    parentRunId: input.parentRunId,
    conversationSessionId: event.conversationSessionId!,
    actor: event.actor!,
    originTarget: event.outputTarget!,
    defaultOutputTarget: event.outputTarget!,
    capabilityGrants: event.capabilityGrants ?? [],
    surfaceMetadata: event.metadata,
    progressSink: event.outputTarget,
    artifactDir: input.artifactDir,
    correlationId: event.correlationId!,
    inboundEventId: inboundEventId(event),
    createdAt
  };
}

export function createOrUpdateConversationSession(input: {
  existing?: ConversationSession;
  key: ConversationKey;
  actor: ActorContext;
  outputTarget: OutputTarget;
  grants: CapabilityGrant[];
  runId?: string;
  now?: string;
}): ConversationSession {
  const now = input.now ?? nowIso();
  const existingActorIds = input.existing?.actorIds ?? [];
  const actorIds = existingActorIds.includes(input.actor.id)
    ? existingActorIds
    : [...existingActorIds, input.actor.id];
  const grantIds = [...new Set([...(input.existing?.effectiveGrantIds ?? []), ...input.grants.map((grant) => grant.id)])];
  return {
    id: input.existing?.id ?? conversationSessionIdForKey(input.key),
    key: input.key,
    status: "active",
    actorIds,
    defaultOutputTarget: input.outputTarget,
    effectiveGrantIds: grantIds,
    currentRunId: input.runId ?? input.existing?.currentRunId,
    metadata: {
      ...input.existing?.metadata,
      lastCorrelationId: input.actor.correlationId,
      surfaceKind: input.key.surfaceKind
    },
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: now
  };
}

export function createProgressEvent(input: {
  type: ProgressEvent["type"];
  message: string;
  runContext?: RunContext;
  event?: UserEvent;
  status?: ProgressEvent["status"];
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}): ProgressEvent {
  const correlationId = input.runContext?.correlationId ?? input.event?.correlationId ?? makeId("corr");
  return {
    id: makeId("progress"),
    type: input.type,
    conversationSessionId: input.runContext?.conversationSessionId ?? input.event?.conversationSessionId,
    runId: input.runContext?.runId,
    parentRunId: input.runContext?.parentRunId,
    message: input.message,
    status: input.status,
    correlationId,
    outputTarget: input.runContext?.defaultOutputTarget ?? input.event?.outputTarget,
    metadata: input.metadata,
    occurredAt: input.occurredAt ?? nowIso()
  };
}

export function checkCapability(
  grants: CapabilityGrant[] | undefined,
  operation: string,
  _resource: Record<string, unknown> = {}
): CapabilityCheckResult {
  const now = nowIso();
  const matched = (grants ?? []).filter((grant) =>
    grant.operations.includes("*") || grant.operations.includes(operation) || grant.operations.some((allowed) =>
      allowed.endsWith(":*") && operation.startsWith(allowed.slice(0, -1))
    )
  );
  if (matched.length > 0) {
    return { allowed: true, operation, grantIds: matched.map((grant) => grant.id), checkedAt: now };
  }
  return { allowed: false, operation, grantIds: [], reason: `No grant allows ${operation}`, checkedAt: now };
}

export function hasCapability(grants: CapabilityGrant[] | undefined, operation: string, resource?: Record<string, unknown>): boolean {
  return checkCapability(grants, operation, resource).allowed;
}

export function telegramTargetChatId(target: OutputTarget | undefined): number | undefined {
  if (!target || target.surfaceKind !== "telegram" || target.chatId === undefined) return undefined;
  const chatId = Number(target.chatId);
  return Number.isFinite(chatId) ? chatId : undefined;
}

export function telegramTargetMessageId(target: OutputTarget | undefined): number | undefined {
  if (!target || target.surfaceKind !== "telegram" || target.messageId === undefined) return undefined;
  const messageId = Number(target.messageId);
  return Number.isFinite(messageId) ? messageId : undefined;
}

export function telegramOutputTarget(input: {
  base?: OutputTarget;
  chatId: number;
  messageId?: number;
  routingPolicy?: OutputTarget["routingPolicy"];
  allowedOutputTypes?: OutputTarget["allowedOutputTypes"];
}): OutputTarget {
  return {
    ...(input.base ?? {}),
    id: `telegram:chat:${input.chatId}${input.messageId !== undefined ? `:message:${input.messageId}` : ""}`,
    surfaceKind: "telegram",
    chatId: String(input.chatId),
    messageId: input.messageId !== undefined ? String(input.messageId) : undefined,
    routingPolicy: input.routingPolicy ?? input.base?.routingPolicy ?? "source_reply",
    allowedOutputTypes: input.allowedOutputTypes ?? input.base?.allowedOutputTypes ?? ["text", "image", "document", "reaction", "progress", "artifact"],
    metadata: input.base?.metadata
  };
}

export function slackTargetChannelId(target: OutputTarget | undefined): string | undefined {
  if (!target || target.surfaceKind !== "slack") return undefined;
  return target.channelId;
}

export function slackTargetThreadTs(target: OutputTarget | undefined): string | undefined {
  if (!target || target.surfaceKind !== "slack") return undefined;
  return target.threadId;
}

export function slackOutputTarget(input: {
  base?: OutputTarget;
  teamId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  channelType?: string;
  routingPolicy?: OutputTarget["routingPolicy"];
  allowedOutputTypes?: OutputTarget["allowedOutputTypes"];
}): OutputTarget {
  return {
    ...(input.base ?? {}),
    id: `slack:team:${input.teamId}:channel:${input.channelId}${input.threadTs ? `:thread:${input.threadTs}` : ""}${input.messageTs ? `:message:${input.messageTs}` : ""}`,
    surfaceKind: "slack",
    workspaceId: input.teamId,
    teamId: input.teamId,
    channelId: input.channelId,
    threadId: input.threadTs,
    messageId: input.messageTs,
    routingPolicy: input.routingPolicy ?? input.base?.routingPolicy ?? "source_reply",
    allowedOutputTypes: input.allowedOutputTypes ?? input.base?.allowedOutputTypes ?? ["text", "reaction", "progress", "artifact"],
    auditLabels: input.base?.auditLabels ?? ["slack", "source"],
    metadata: {
      ...input.base?.metadata,
      slackTeamId: input.teamId,
      slackChannelId: input.channelId,
      slackChannelType: input.channelType,
      slackThreadTs: input.threadTs,
      slackMessageTs: input.messageTs
    }
  };
}

function buildTelegramActorContext(input: TelegramRuntimeInput & { correlationId: string }): ActorContext {
  const displayName = [input.firstName, input.lastName].filter(Boolean).join(" ").trim() || input.username;
  return {
    id: `telegram:user:${input.userId}`,
    surfaceKind: "telegram",
    surfaceUserId: String(input.userId),
    displayName,
    handle: input.username,
    isAdmin: input.isAdmin === true,
    isPersonalOwner: input.isAdmin === true,
    authenticatedAt: input.receivedAt,
    correlationId: input.correlationId,
    metadata: {
      telegramUserId: input.userId,
      telegramChatId: input.chatId,
      telegramUsername: input.username,
      telegramChatType: input.chatType,
      telegramChatTitle: input.chatTitle,
      ...input.metadata
    }
  };
}

function buildSlackActorContext(input: SlackRuntimeInput & { correlationId: string }): ActorContext {
  const displayName = input.userDisplayName || input.userName;
  return {
    id: `slack:team:${input.teamId}:user:${input.userId}`,
    surfaceKind: "slack",
    surfaceUserId: input.userId,
    displayName,
    handle: input.userName,
    organizationId: input.enterpriseId,
    workspaceId: input.teamId,
    teamId: input.teamId,
    authenticatedAt: input.receivedAt,
    correlationId: input.correlationId,
    metadata: {
      slackTeamId: input.teamId,
      slackEnterpriseId: input.enterpriseId,
      slackUserId: input.userId,
      slackUserName: input.userName,
      slackChannelId: input.channelId,
      slackChannelType: input.channelType,
      slackBotUserId: input.botUserId,
      ...input.metadata
    }
  };
}

function buildTelegramConversationKey(input: TelegramRuntimeInput): ConversationKey {
  const threadId = input.messageThreadId !== undefined ? String(input.messageThreadId) : undefined;
  return {
    id: `telegram:chat:${input.chatId}${threadId ? `:thread:${threadId}` : ""}`,
    surfaceKind: "telegram",
    chatId: String(input.chatId),
    threadId,
    metadata: {
      telegramChatId: input.chatId,
      telegramMessageThreadId: input.messageThreadId,
      telegramChatType: input.chatType,
      telegramChatTitle: input.chatTitle
    }
  };
}

function buildSlackConversationKey(input: SlackRuntimeInput): ConversationKey {
  const channelType = input.channelType ?? slackChannelTypeFromId(input.channelId);
  const requestedThreadTs = input.threadTs;
  const conversationScoped = isSlackConversationScoped(channelType, requestedThreadTs);
  const threadTs = conversationScoped ? undefined : (requestedThreadTs ?? input.messageTs);
  return {
    id: conversationScoped
      ? `slack:team:${input.teamId}:conversation:${input.channelId}`
      : `slack:team:${input.teamId}:channel:${input.channelId}:thread:${threadTs}`,
    surfaceKind: "slack",
    workspaceId: input.teamId,
    channelId: input.channelId,
    threadId: threadTs,
    metadata: {
      slackTeamId: input.teamId,
      slackEnterpriseId: input.enterpriseId,
      slackChannelId: input.channelId,
      slackChannelType: channelType,
      slackThreadTs: threadTs,
      slackMessageTs: input.messageTs
    }
  };
}

function buildTelegramOutputTarget(input: TelegramRuntimeInput): OutputTarget {
  const threadId = input.messageThreadId !== undefined ? String(input.messageThreadId) : undefined;
  return {
    id: `telegram:chat:${input.chatId}${threadId ? `:thread:${threadId}` : ""}${input.messageId !== undefined ? `:message:${input.messageId}` : ""}`,
    surfaceKind: "telegram",
    chatId: String(input.chatId),
    threadId,
    messageId: input.messageId !== undefined ? String(input.messageId) : undefined,
    routingPolicy: "source_reply",
    allowedOutputTypes: ["text", "image", "document", "reaction", "progress", "artifact"],
    auditLabels: ["telegram", "source"],
    metadata: {
      telegramChatId: input.chatId,
      telegramMessageId: input.messageId,
      telegramMessageThreadId: input.messageThreadId,
      telegramChatType: input.chatType,
      telegramChatTitle: input.chatTitle
    }
  };
}

function buildSlackOutputTarget(input: SlackRuntimeInput): OutputTarget {
  const channelType = input.channelType ?? slackChannelTypeFromId(input.channelId);
  const requestedThreadTs = input.threadTs;
  const conversationScoped = isSlackConversationScoped(channelType, requestedThreadTs);
  const threadTs = conversationScoped ? undefined : (requestedThreadTs ?? input.messageTs);
  return {
    id: `slack:team:${input.teamId}:channel:${input.channelId}${threadTs ? `:thread:${threadTs}` : ""}:message:${input.messageTs}`,
    surfaceKind: "slack",
    workspaceId: input.teamId,
    teamId: input.teamId,
    channelId: input.channelId,
    threadId: threadTs,
    messageId: input.messageTs,
    routingPolicy: "source_reply",
    allowedOutputTypes: ["text", "reaction", "progress", "artifact"],
    auditLabels: ["slack", "source"],
    metadata: {
      slackTeamId: input.teamId,
      slackEnterpriseId: input.enterpriseId,
      slackChannelId: input.channelId,
      slackChannelType: channelType,
      slackThreadTs: threadTs,
      slackMessageTs: input.messageTs,
      slackEventId: input.eventId,
      slackEventTime: input.eventTime,
      slackRetryNum: input.retryNum,
      slackRetryReason: input.retryReason,
      slackBotUserId: input.botUserId
    }
  };
}

function buildTelegramCapabilityGrants(input: {
  actor: ActorContext;
  chatId: number;
  conversationSessionId: string;
  isAdmin: boolean;
  createdAt?: string;
}): CapabilityGrant[] {
  const createdAt = input.createdAt ?? nowIso();
  const operations = input.isAdmin ? TELEGRAM_ADMIN_OPERATIONS : TELEGRAM_USER_OPERATIONS;
  return [{
    id: `grant:${input.actor.id}:${input.isAdmin ? "telegram-admin" : "telegram-user"}`,
    name: input.isAdmin ? "Telegram personal/admin compatibility" : "Telegram allowlist compatibility",
    description: input.isAdmin
      ? "Phase 1 compatibility grant for the existing Telegram personal/admin operator."
      : "Phase 1 compatibility grant for existing allowed Telegram users.",
    scope: "user",
    operations,
    resourceSelectors: {
      surfaceKind: "telegram",
      chatId: String(input.chatId)
    },
    source: input.isAdmin ? "telegram_admin_allowlist" : "telegram_allowlist",
    grantor: "codex-chat-phase-1",
    actorId: input.actor.id,
    conversationSessionId: input.conversationSessionId,
    auditPolicy: "log",
    createdAt
  }];
}

function buildSlackCapabilityGrants(input: {
  actor: ActorContext;
  teamId: string;
  channelId: string;
  threadTs?: string;
  conversationSessionId: string;
  createdAt?: string;
}): CapabilityGrant[] {
  const createdAt = input.createdAt ?? nowIso();
  return [{
    id: `grant:${input.actor.id}:slack-source:${input.conversationSessionId}`,
    name: "Slack source conversation compatibility",
    description: "Slack foundation grant for reading and replying to the originating Slack conversation only. Broader Slack capabilities require the future capability requirements session and enforcement phase.",
    scope: "temporary",
    operations: SLACK_SOURCE_OPERATIONS,
    resourceSelectors: {
      surfaceKind: "slack",
      teamId: input.teamId,
      channelId: input.channelId,
      threadTs: input.threadTs
    },
    source: "slack_event_source",
    grantor: "codex-chat-slack-foundation",
    actorId: input.actor.id,
    conversationSessionId: input.conversationSessionId,
    auditPolicy: "log",
    createdAt
  }];
}

function systemGrant(actor: ActorContext, conversationSessionId: string, createdAt?: string): CapabilityGrant {
  return {
    id: `grant:${actor.id}:system`,
    name: "System runtime compatibility",
    description: "Phase 1 permissive grant for service-owned synthetic runtime events.",
    scope: "system",
    operations: ["*"],
    resourceSelectors: { surfaceKind: actor.surfaceKind },
    source: "system",
    actorId: actor.id,
    conversationSessionId,
    auditPolicy: "log",
    createdAt: createdAt ?? nowIso()
  };
}

function conversationSessionIdForKey(key: ConversationKey): string {
  const digest = createHash("sha256").update(key.id).digest("hex").slice(0, 24);
  return `session_${digest}`;
}

function surfaceKindForEvent(source: UserEvent["source"]): SurfaceKind {
  if (source === "loop") return "loop";
  if (source === "monitor") return "monitor";
  if (source === "audio_ingest") return "audio_ingest";
  if (source === "telegram") return "telegram";
  if (source === "slack") return "slack";
  return "system";
}

function telegramMessageThreadId(event: UserEvent): number | undefined {
  const value = event.metadata?.telegramMessageThreadId;
  return typeof value === "number" ? value : undefined;
}

function inboundEventId(event: UserEvent): string {
  if (event.source === "telegram" && event.chatId !== undefined && event.messageId !== undefined) {
    return `telegram:${event.chatId}:${event.messageId}`;
  }
  if (event.source === "slack" && typeof event.metadata?.slackEventId === "string") {
    return `slack:${event.metadata.slackEventId}`;
  }
  return `${event.source}:${event.receivedAt}:${event.correlationId ?? "no-correlation"}`;
}

function conversationKeyFromOutputTarget(target: OutputTarget | undefined): ConversationKey | undefined {
  if (!target) return undefined;
  if (target.surfaceKind === "telegram" && target.chatId) {
    return {
      id: `telegram:chat:${target.chatId}${target.threadId ? `:thread:${target.threadId}` : ""}`,
      surfaceKind: "telegram",
      chatId: target.chatId,
      threadId: target.threadId,
      metadata: target.metadata
    };
  }
  if (target.surfaceKind === "slack" && target.teamId && target.channelId) {
    return {
      id: target.threadId
        ? `slack:team:${target.teamId}:channel:${target.channelId}:thread:${target.threadId}`
        : `slack:team:${target.teamId}:conversation:${target.channelId}`,
      surfaceKind: "slack",
      workspaceId: target.workspaceId ?? target.teamId,
      channelId: target.channelId,
      threadId: target.threadId,
      metadata: target.metadata
    };
  }
  return undefined;
}

function outputTargetMetadata(metadata: Record<string, unknown> | undefined, key: string): OutputTarget | undefined {
  const value = metadata?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<OutputTarget>;
  if (typeof candidate.id !== "string" || typeof candidate.surfaceKind !== "string") return undefined;
  if (candidate.surfaceKind !== "telegram" && candidate.surfaceKind !== "slack" && candidate.surfaceKind !== "dashboard" && candidate.surfaceKind !== "system" && candidate.surfaceKind !== "loop" && candidate.surfaceKind !== "monitor" && candidate.surfaceKind !== "audio_ingest") return undefined;
  if (candidate.routingPolicy !== "source_reply" && candidate.routingPolicy !== "explicit_target" && candidate.routingPolicy !== "admin_notify" && candidate.routingPolicy !== "artifact_only" && candidate.routingPolicy !== "silent") return undefined;
  if (!Array.isArray(candidate.allowedOutputTypes)) return undefined;
  return candidate as OutputTarget;
}

function isSlackConversationScoped(channelType: string | undefined, requestedThreadTs?: string): boolean {
  if (requestedThreadTs) return false;
  return channelType === "im" || channelType === "mpim" || channelType === "group";
}

function slackChannelTypeFromId(channelId: string): string | undefined {
  if (channelId.startsWith("D")) return "im";
  if (channelId.startsWith("G")) return "group";
  if (channelId.startsWith("C")) return "channel";
  return undefined;
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value ? value : undefined;
}

function numberMetadata(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
