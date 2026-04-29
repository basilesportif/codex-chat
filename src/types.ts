export type JsonRecord = Record<string, unknown>;

export type Route =
  | "return_to_main"
  | "send_to_user"
  | "send_progress_and_return"
  | "send_to_admins"
  | "dispatch_subagent"
  | "store_only"
  | "silent";

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
  source: "telegram" | "loop" | "monitor" | "subagent" | "system";
  chatId?: number;
  userId?: number;
  username?: string;
  messageId?: number;
  reply?: TelegramReplyContext;
  text: string;
  transcript?: string;
  attachments: Attachment[];
  metadata?: JsonRecord;
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
  payload: unknown;
  error?: string;
}

export interface SubagentJob {
  id: string;
  profile: string;
  route: Route;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  promptPath: string;
  artifactDir: string;
  model?: string;
  effort?: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  lastMessagePath?: string;
  originChatId?: number;
  originMessageId?: number;
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
