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

export interface CapabilityCheckResult {
  allowed: boolean;
  operation: string;
  grantIds: string[];
  reason?: string;
  checkedAt: string;
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
  runContext?: RunContext;
  receivedAt: string;
}

export interface CodexTurnInput {
  text: string;
  attachments?: Attachment[];
  source?: string;
  turnId?: string;
}

export type CodexEvent =
  | { type: "delta"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string; raw?: unknown }
  | { type: "status"; message: string; raw?: unknown };

export interface CodexHealth {
  ok: boolean;
  transport: string;
  detail?: string;
  sessionId?: string;
}

export interface CodexClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<CodexHealth>;
  sendTurn(input: CodexTurnInput): AsyncIterable<CodexEvent>;
  /** Drop the current main thread/session and create a fresh one. */
  resetSession?(reason?: string): Promise<CodexHealth>;
  /** Optional — clients may expose recent app-server output for introspection. */
  getRecentLogs?(n?: number, includeRaw?: boolean): string[];
}

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
  status: "queued" | "running" | "completed" | "failed" | "dropped";
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
