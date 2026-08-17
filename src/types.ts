export type JsonRecord = Record<string, unknown>;

export type SurfaceKind = "telegram" | "slack" | "dashboard" | "system" | "loop" | "monitor" | "audio_ingest";

export interface ActorContext {
  id: string;
  surfaceKind: SurfaceKind;
  surfaceUserId?: string;
  displayName?: string;
  handle?: string;
  organizationId?: string;
  workspaceId?: string;
  teamId?: string;
  isAdmin?: boolean;
  isPersonalOwner?: boolean;
  authenticatedAt?: string;
  correlationId: string;
  metadata?: JsonRecord;
}

export interface OutputTarget {
  id: string;
  surfaceKind: SurfaceKind;
  workspaceId?: string;
  teamId?: string;
  channelId?: string;
  chatId?: string;
  threadId?: string;
  messageId?: string;
  routingPolicy: "source_reply" | "explicit_target" | "admin_notify" | "artifact_only" | "silent";
  allowedOutputTypes: Array<"text" | "image" | "document" | "reaction" | "progress" | "artifact">;
  auditLabels?: string[];
  metadata?: JsonRecord;
}

export interface ConversationKey {
  id: string;
  surfaceKind: SurfaceKind;
  workspaceId?: string;
  channelId?: string;
  chatId?: string;
  threadId?: string;
  metadata?: JsonRecord;
}

export interface CapabilityGrant {
  id: string;
  name: string;
  description: string;
  scope: "user" | "chat" | "channel" | "workspace" | "temporary" | "system";
  operations: string[];
  resourceSelectors: JsonRecord;
  source: string;
  grantor?: string;
  actorId?: string;
  conversationSessionId?: string;
  expiresAt?: string;
  auditPolicy?: "log" | "log_denials" | "silent";
  createdAt: string;
}

export type CapabilityResource = JsonRecord;

export interface CapabilityRequirement {
  operation: string;
  action?: string;
  resource: CapabilityResource;
  reason: string;
  caller?: string;
}

export interface CapabilityDecision {
  id: string;
  allowed: boolean;
  actorId?: string;
  actorDisplayName?: string;
  operation: string;
  action?: string;
  resourceSummary: JsonRecord;
  resourceHash: string;
  grantIds: string[];
  reason?: string;
  checkedAt: string;
  caller?: string;
  brainSubjectIds?: string[];
}

export interface CapabilityDecisionRecord extends CapabilityDecision {
  recordedAt: string;
}

export interface CapabilityCheckResult {
  allowed: boolean;
  operation: string;
  grantIds: string[];
  reason?: string;
  checkedAt: string;
}

export interface BrainCapabilityManifestEntry {
  capabilityId: string;
  selectors?: JsonRecord;
}

export interface BrainSubjectManifest {
  subjectId: string;
  capabilities: BrainCapabilityManifestEntry[];
}

export interface ProgressEvent {
  id: string;
  type:
    | "checklist_created"
    | "checklist_updated"
    | "item_started"
    | "item_completed"
    | "item_failed"
    | "subagent_dispatched"
    | "subagent_steered"
    | "subagent_cancelled"
    | "subagent_completed"
    | "tool_call_started"
    | "tool_call_completed"
    | "tool_call_failed"
    | "partial_summary"
    | "waiting"
    | "final_result";
  conversationSessionId?: string;
  runId?: string;
  parentRunId?: string;
  checklistItemId?: string;
  message: string;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";
  correlationId: string;
  outputTarget?: OutputTarget;
  metadata?: JsonRecord;
  occurredAt: string;
}

export interface RunContext {
  runId: string;
  parentRunId?: string;
  conversationSessionId: string;
  actor: ActorContext;
  originTarget: OutputTarget;
  defaultOutputTarget: OutputTarget;
  capabilityGrants: CapabilityGrant[];
  surfaceMetadata?: JsonRecord;
  progressSink?: OutputTarget;
  cancellation?: JsonRecord;
  steering?: JsonRecord;
  artifactDir?: string;
  correlationId: string;
  inboundEventId?: string;
  contextBudget?: JsonRecord;
  createdAt: string;
}

export interface ConversationSession {
  id: string;
  key: ConversationKey;
  status: "active" | "hibernated" | "archived";
  actorIds: string[];
  defaultOutputTarget?: OutputTarget;
  effectiveGrantIds: string[];
  currentRunId?: string;
  metadata?: JsonRecord;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export type Route =
  | "return_to_main"
  | "send_to_user"
  | "send_progress_and_return"
  | "send_to_admins"
  | "dispatch_subagent"
  | "store_only"
  | "silent";

export type SubagentBackendKind = "codex_exec" | "codex_app_server" | "claude_agent_sdk";
export type ServiceTier = "standard" | "fast";
export type ServiceTierMode = "auto" | "always" | "omit";
export type SubagentOwnerType = "main" | "loop" | "monitor" | "employee";
export type SubagentResultTarget = "main" | "user" | "employee" | "admins" | "store_only" | "silent";

export interface Attachment {
  kind: "image" | "document" | "voice" | "audio";
  localPath: string;
  mimeType?: string;
  originalName?: string;
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface TelegramReplyChatSummary {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface TelegramReplySenderSummary {
  userId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot?: boolean;
  senderChat?: TelegramReplyChatSummary;
  senderTag?: string;
  authorSignature?: string;
}

export interface TelegramReplyOriginContext {
  type: string;
  date?: number;
  sender?: TelegramReplySenderSummary;
  senderName?: string;
  chat?: TelegramReplyChatSummary;
  messageId?: number;
  authorSignature?: string;
}

export interface TelegramSameChatReplyContext {
  chatId: number;
  messageId: number;
  messageThreadId?: number;
  sender?: TelegramReplySenderSummary;
  snippet?: string;
  /** Full text of the replied-to message when it can be hydrated from our own outbound store. */
  fullText?: string;
  /**
   * True only when `fullText` came from this service's own outbound message store —
   * i.e. proof that we sent the replied-to message. Do not infer authorship from
   * `fullText` alone; a future hydration source would make that inference lie.
   */
  hydratedFromOurStore?: boolean;
  /**
   * True when the body below is a partial view of the original, in either sense:
   * no `fullText` was recoverable and the Telegram `snippet` was cut at 280 chars, or
   * `fullText` was recovered but itself capped at `REPLY_FULL_TEXT_MAX_CHARS`.
   * Which one applies is determined by whether `fullText` is set.
   */
  snippetTruncated?: boolean;
  contentType?: string;
}

export interface TelegramExternalReplyContext {
  origin?: TelegramReplyOriginContext;
  chat?: TelegramReplyChatSummary;
  messageId?: number;
  contentType?: string;
  hasMediaSpoiler?: boolean;
}

export interface TelegramReplyQuoteContext {
  snippet: string;
  position?: number;
  isManual?: boolean;
}

export interface TelegramReplyStoryContext {
  chat?: TelegramReplyChatSummary;
  storyId: number;
}

export interface TelegramReplyContext {
  replyToMessage?: TelegramSameChatReplyContext;
  externalReply?: TelegramExternalReplyContext;
  quote?: TelegramReplyQuoteContext;
  replyToStory?: TelegramReplyStoryContext;
  replyToChecklistTaskId?: number;
  replyToPollOptionId?: string;
}

export interface UserEvent {
  source: "telegram" | "slack" | "loop" | "monitor" | "subagent" | "audio_ingest" | "system";
  chatId?: number;
  userId?: number;
  username?: string;
  messageId?: number;
  reply?: TelegramReplyContext;
  text: string;
  transcript?: string;
  attachments: Attachment[];
  metadata?: JsonRecord;
  correlationId?: string;
  actor?: ActorContext;
  outputTarget?: OutputTarget;
  conversationKey?: ConversationKey;
  conversationSessionId?: string;
  capabilityGrants?: CapabilityGrant[];
  brainSubjectManifest?: BrainSubjectManifest;
  runContext?: RunContext;
  /** Original timestamp supplied by the source surface, kept apart from processing time. */
  sourceTimestamp?: string;
  receivedAt: string;
}

export const USER_EVENT_SOURCES = ["telegram", "slack", "loop", "monitor", "subagent", "audio_ingest", "system"] as const satisfies readonly UserEvent["source"][];
type MissingUserEventSource = Exclude<UserEvent["source"], (typeof USER_EVENT_SOURCES)[number]>;
const _userEventSourcesAreExhaustive: Record<MissingUserEventSource, never> = {};

export type MainAgentProvider = "codex" | "claude_agent_sdk";

export interface MainAgentTurnInput {
  text: string;
  attachments?: Attachment[];
  source?: string;
  turnId?: string;
}

export type MainAgentEvent =
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string; raw?: unknown }
  | { type: "status"; message: string; raw?: unknown };

export interface MainAgentHealth {
  ok: boolean;
  transport: string;
  detail?: string;
  sessionId?: string;
  provider?: MainAgentProvider;
}

/** Context-window telemetry for a provider's persisted main session. */
export interface MainAgentContextStats {
  /**
   * The session these figures describe. The watchdog scopes its per-session
   * escalation counters to it, so evidence gathered against one conversation
   * can never condemn the next one.
   */
  sessionId?: string;
  /**
   * How full the main session's context window actually is, measured from the
   * LAST single API request of the last completed turn (its own input +
   * cache-read + cache-creation tokens). Deliberately NOT the turn's summed
   * usage: a result message's `usage` is cumulative over every request the
   * agentic loop made, which on a long turn overstates occupancy by an order
   * of magnitude (see `effectiveInputTokens` in claude-main-agent.ts).
   */
  lastTurnInputTokens?: number;
  /** Turn input size at or above which the next turn starts a fresh session. */
  rolloverThresholdTokens?: number;
  /** True once a rollover is queued and waiting for the next turn boundary. */
  rolloverPending?: boolean;
  /** The serving model's context window, when the provider reports one. */
  contextWindowTokens?: number;
}

/**
 * Liveness telemetry for the turn currently in flight, used by the service
 * watchdog to tell "slow but alive" from "wedged". A provider that cannot
 * report it leaves the watchdog on plain wall-clock timing.
 */
export interface MainAgentTurnWatchdogState {
  /** Epoch ms of the most recent event this provider saw for the live turn. */
  lastActivityAt?: number;
  /** Events seen since the turn started; 0 means the turn was silent throughout. */
  activityEvents: number;
  /**
   * True while the provider is doing bounded work that legitimately produces
   * no events (a context-rollover session restart), during which the
   * inactivity deadline must not fire.
   */
  suspended: boolean;
  suspendedReason?: string;
}

export interface MainAgentClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<MainAgentHealth>;
  sendTurn(input: MainAgentTurnInput): AsyncIterable<MainAgentEvent>;
  /** Drop the current main thread/session and create a fresh one. */
  resetSession?(reason?: string): Promise<MainAgentHealth>;
  /**
   * Delete this provider's persisted main-session record without restarting.
   * The watchdog uses it so recovery always clears the ACTIVE provider's key
   * rather than a hardcoded one.
   */
  clearPersistedSession?(reason?: string): Promise<void>;
  /** Optional: last observed context size of this provider's main session. */
  contextStats?(): MainAgentContextStats | undefined;
  /**
   * Optional: per-turn liveness for the service watchdog. Providers that
   * implement it get activity-based (inactivity) timing; providers that do not
   * keep the historical wall-clock abort.
   */
  turnWatchdogState?(): MainAgentTurnWatchdogState | undefined;
  /** Optional — clients may expose recent app-server output for introspection. */
  getRecentLogs?(n?: number, includeRaw?: boolean): string[];
  /** Optional: bootstrap text queued when the behavior pack changed since the session last saw it. */
  consumePendingBehaviorRefresh?(): string | undefined;
}

/** @deprecated Use MainAgentTurnInput. */
export type CodexTurnInput = MainAgentTurnInput;
/** @deprecated Use MainAgentEvent. */
export type CodexEvent = MainAgentEvent;
/** @deprecated Use MainAgentHealth. */
export type CodexHealth = MainAgentHealth;
/** @deprecated Use MainAgentClient. */
export type CodexClient = MainAgentClient;

export interface StoredAction {
  id: string;
  idempotencyKey?: string;
  type: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  createdAt: string;
  completedAt?: string;
  runId?: string;
  conversationSessionId?: string;
  correlationId?: string;
  outputTarget?: OutputTarget;
  payload: unknown;
  error?: string;
}

export interface SubagentJob {
  id: string;
  profile: string;
  route: Route;
  ownerType?: SubagentOwnerType;
  ownerId?: string;
  ownerRequestId?: string;
  parentTurnId?: string;
  conversationSessionId?: string;
  correlationId?: string;
  originTarget?: OutputTarget;
  defaultOutputTarget?: OutputTarget;
  resultTarget?: SubagentResultTarget;
  originActorId?: string;
  dispatchCapabilityDecisionId?: string;
  dispatchGrantIds?: string[];
  resultCapabilityDecisionId?: string;
  allowedControlActorIds?: string[];
  capabilitySummary?: JsonRecord;
  brainSubjectId?: string;
  brainCapabilityManifest?: BrainSubjectManifest;
  status: "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "timed_out" | "abandoned";
  promptPath: string;
  artifactDir: string;
  model?: string;
  effort?: string;
  serviceTier?: ServiceTier;
  serviceTierMode?: ServiceTierMode;
  codexProfile?: string;
  modelProvider?: string;
  summary?: string;
  enqueuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  abandonedAt?: string;
  pid?: number;
  pgid?: number;
  cancelRequestedAt?: string;
  cancelReason?: string;
  termSentAt?: string;
  killSentAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  lastMessagePath?: string;
  originChatId?: number;
  originMessageId?: number;
  backend?: SubagentBackendKind;
  /** True when the dispatch directive explicitly requested this backend; runtime override re-stamping skips these jobs. */
  backendExplicit?: boolean;
  backendThreadId?: string;
  activeTurnId?: string;
  socketPath?: string;
  transport?: "stdio" | "ws" | "unix";
  interruptRequestedAt?: string;
  lastSteeredAt?: string;
  steerCount?: number;
  /** Live nested/background agents inside a Claude-backed child session; the job cannot complete while this is set. */
  waitingOnNestedAgents?: number;
}

export type EmployeeStatus = "disabled" | "idle" | "proposal_pending" | "running" | "stopped" | "error";
export type EmployeeProposalAction = "start" | "stop" | "steer" | "warmup" | "compact";

export interface EmployeeProposal {
  action: EmployeeProposalAction;
  text?: string;
  proposedAt: string;
  proposedBy?: string;
  reason: string;
}

export interface EmployeeRuntimeState {
  id: string;
  status: EmployeeStatus;
  enabled: boolean;
  directory: string;
  profile: string;
  model: string;
  effort: string;
  startup: "on_demand" | "always";
  updatedAt: string;
  runtimeMode: "scaffold_only" | "app_server";
  lastProposal?: EmployeeProposal;
  lastError?: string;
  activeTurnId?: string;
  backendThreadId?: string;
  startedAt?: string;
  stoppedAt?: string;
  resumedAt?: string;
  lastSteeredAt?: string;
  lastResumeError?: string;
  pid?: number;
  pendingChildResults?: EmployeePendingChildResult[];
  lastChildResultAt?: string;
  lastServiceActionAt?: string;
  lastServiceActionError?: string;
}

export interface EmployeePendingChildResult {
  jobId: string;
  ownerRequestId?: string;
  status: SubagentJob["status"];
  resultPath: string;
  resultPreview: string;
  storedAt: string;
  reason: string;
}

export interface LoopRun {
  id: string;
  loopId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "dropped";
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  route?: Route;
  outputPath?: string;
  error?: string;
}

export interface MonitorEvent {
  id: string;
  monitorId: string;
  patternId: string;
  line: string;
  stream: "stdout" | "stderr";
  captures: string[];
  contextPath?: string;
  createdAt: string;
}
