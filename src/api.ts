import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import type { AppConfig } from "./config.js";
import type { FileStore } from "./file-store.js";
import type { StateStore } from "./state.js";
import type { Transcriber } from "./transcription.js";
import { AudioIngestionError, AudioIngestionService, sanitizeAudioIngestMetadata, type AudioIngestionResponse } from "./audio-ingest.js";
import { authenticateIngestRequest, type IngestApiKey } from "./ingest-auth.js";
import {
  normalizeSlackEventCallback,
  verifySlackRequestSignature,
  type SlackEventEnvelope
} from "./slack.js";
import type { UserEvent } from "./types.js";

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const SLACK_EVENT_MAX_BYTES = 1024 * 1024;
const SLACK_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MAX_SEEN_SLACK_EVENTS = 5_000;

export interface AudioIngestionCompletedEvent {
  keyIdentity: string;
  result: AudioIngestionResponse;
}

export interface ApiGatewayHooks {
  onAudioIngestionCompleted?: (event: AudioIngestionCompletedEvent) => Promise<void>;
  onSlackUserEvent?: (event: UserEvent) => Promise<void>;
}

interface MultipartFilePart {
  fieldName: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

interface ParsedMultipartForm {
  fields: Record<string, string>;
  files: MultipartFilePart[];
}

export function isLoopbackApiHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export class ApiGateway {
  private server?: Server;
  private readonly audioIngestion: AudioIngestionService;
  private readonly seenSlackEventIds = new Map<string, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    files: FileStore,
    transcriber: Transcriber,
    private readonly logger: Logger,
    private readonly hooks: ApiGatewayHooks = {}
  ) {
    this.audioIngestion = new AudioIngestionService(state, files, transcriber, logger, {
      maxBytes: Math.floor(config.ingest.audioMaxMb * 1024 * 1024)
    });
  }

  async start(): Promise<void> {
    if (!this.config.api.enabled) return;
    if (!isLoopbackApiHost(this.config.api.host) && !this.config.api.allowNonLocalhost) {
      throw new Error(`Refusing to bind codex-chat API to non-loopback host ${this.config.api.host}. Set api.allowNonLocalhost=true only behind private networking and server-to-server auth.`);
    }
    if (this.config.slack.enabled && !this.config.slackSigningSecret) {
      throw new Error(`${this.config.slack.signingSecretEnv} is required when slack.enabled=true`);
    }
    if (!this.config.slack.enabled && this.config.ingest.apiKeys.length === 0) {
      throw new Error(`${this.config.ingest.apiKeysEnv} is required when api.enabled=true`);
    }
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.logger.error({ component: "api", event: "request_failed", error }, "API request failed");
        this.sendJson(response, 500, { error: "internal_error" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.api.port, this.config.api.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.address();
    this.logger.info({ component: "api", event: "started", host: this.config.api.host, port: address?.port ?? this.config.api.port }, "HTTP API started");
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  address(): AddressInfo | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address : undefined;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? this.config.api.host}`);
    if (this.config.slack.enabled && request.method === "POST" && url.pathname === this.config.slack.eventsPath) {
      await this.handleSlackEvents(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ingest/audio") {
      await this.handleAudioIngest(request, response);
      return;
    }
    this.sendJson(response, 404, { error: "not_found" });
  }

  private async handleSlackEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request, SLACK_EVENT_MAX_BYTES);
    const verification = verifySlackRequestSignature({
      signingSecret: this.config.slackSigningSecret,
      body,
      timestampHeader: firstHeaderValue(request.headers["x-slack-request-timestamp"]),
      signatureHeader: firstHeaderValue(request.headers["x-slack-signature"])
    });
    if (!verification.ok) {
      const statusCode = verification.reason === "missing_secret" ? 503 : 401;
      this.logger.warn({ component: "slack", event: "signature_rejected", reason: verification.reason }, "Slack request signature rejected");
      this.sendJson(response, statusCode, { error: verification.reason });
      return;
    }

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(body.toString("utf8")) as SlackEventEnvelope;
    } catch {
      this.sendJson(response, 400, { error: "invalid_json" });
      return;
    }

    if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
      this.sendJson(response, 200, { challenge: envelope.challenge });
      return;
    }
    if (envelope.type !== "event_callback") {
      this.sendJson(response, 200, { ok: true, ignored: true });
      return;
    }

    const normalized = normalizeSlackEventCallback(envelope);
    if (normalized.eventId && this.hasSeenSlackEvent(normalized.eventId)) {
      this.sendJson(response, 200, { ok: true, duplicate: true });
      return;
    }
    if (normalized.status === "ignored") {
      if (normalized.eventId) this.rememberSlackEvent(normalized.eventId);
      this.logger.debug({ component: "slack", event: "event_ignored", reason: normalized.reason, eventId: normalized.eventId }, "Slack event ignored");
      this.sendJson(response, 200, { ok: true, ignored: true, reason: normalized.reason });
      return;
    }

    this.rememberSlackEvent(normalized.eventId);
    this.sendJson(response, 200, { ok: true });
    void this.hooks.onSlackUserEvent?.(normalized.event).catch((error) => {
      this.logger.error({ component: "slack", event: "enqueue_failed", eventId: normalized.eventId, error }, "Slack event acknowledged but enqueue failed");
    });
  }

  private async handleAudioIngest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const auth = authenticateIngestRequest(request, this.config.ingest.apiKeys as readonly IngestApiKey[]);
    if (!auth.authorized || !auth.identity) {
      this.sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    this.logger.info({ component: "api", event: "audio_ingest_request_received", keyIdentity: auth.identity }, "audio ingestion request received");

    let form: ParsedMultipartForm;
    try {
      form = await this.readMultipartForm(request, this.maxBodyBytes());
    } catch (error) {
      const statusCode = error instanceof AudioIngestionError ? error.statusCode : 400;
      const errorCode = error instanceof AudioIngestionError ? error.errorCode : "invalid_multipart";
      this.logger.warn({ component: "api", event: "audio_ingest_rejected", keyIdentity: auth.identity, statusCode, errorCode }, "audio ingestion request rejected");
      this.sendJson(response, statusCode, { error: errorCode });
      return;
    }

    const file = form.files.find((part) => part.fieldName === "file");
    if (!file) {
      this.sendJson(response, 400, { error: "missing_file" });
      return;
    }

    const metadata = sanitizeAudioIngestMetadata(form.fields);
    this.logger.info({
      component: "api",
      event: "audio_ingest_file_received",
      keyIdentity: auth.identity,
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.data.length
    }, "audio ingestion file received");

    try {
      const result = await this.audioIngestion.ingest({
        keyIdentity: auth.identity,
        metadata,
        file: {
          filename: file.filename,
          contentType: file.contentType,
          data: file.data
        }
      });
      this.logger.info({
        component: "api",
        event: "audio_ingest_completed",
        keyIdentity: auth.identity,
        ingestionId: result.ingestion_id,
        status: result.status,
        duplicate: result.duplicate || undefined
      }, "audio ingestion request completed");
      if (!result.duplicate && result.status === "completed") {
        try {
          await this.hooks.onAudioIngestionCompleted?.({ keyIdentity: auth.identity, result });
        } catch (error) {
          this.logger.error({
            component: "api",
            event: "audio_ingest_delivery_failed",
            keyIdentity: auth.identity,
            ingestionId: result.ingestion_id,
            error
          }, "audio ingestion completed but delivery to message handling failed");
        }
      }
      this.sendJson(response, result.duplicate ? 200 : 201, result);
    } catch (error) {
      const statusCode = error instanceof AudioIngestionError ? error.statusCode : 500;
      const errorCode = error instanceof AudioIngestionError ? error.errorCode : "internal_error";
      this.logger.error({
        component: "api",
        event: "audio_ingest_failed",
        keyIdentity: auth.identity,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        statusCode,
        errorCode,
        error
      }, "audio ingestion request failed");
      this.sendJson(response, statusCode, { error: errorCode });
    }
  }

  private async readMultipartForm(request: IncomingMessage, maxBytes: number): Promise<ParsedMultipartForm> {
    const contentType = firstHeaderValue(request.headers["content-type"]);
    const boundary = parseMultipartBoundary(contentType);
    if (!boundary) throw new AudioIngestionError(400, "invalid_multipart", "multipart/form-data boundary is required");
    const body = await readBody(request, maxBytes);
    return parseMultipartBody(body, boundary);
  }

  private maxBodyBytes(): number {
    return Math.max(1, Math.floor(this.config.ingest.audioMaxMb * 1024 * 1024) + MULTIPART_OVERHEAD_BYTES);
  }

  private sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
    if (response.headersSent) return;
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(value)}\n`);
  }

  private hasSeenSlackEvent(eventId: string): boolean {
    this.pruneSeenSlackEvents();
    return this.seenSlackEventIds.has(eventId);
  }

  private rememberSlackEvent(eventId: string): void {
    this.pruneSeenSlackEvents();
    this.seenSlackEventIds.set(eventId, Date.now());
    while (this.seenSlackEventIds.size > MAX_SEEN_SLACK_EVENTS) {
      const oldest = this.seenSlackEventIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenSlackEventIds.delete(oldest);
    }
  }

  private pruneSeenSlackEvents(): void {
    const cutoff = Date.now() - SLACK_IDEMPOTENCY_TTL_MS;
    for (const [eventId, seenAt] of this.seenSlackEventIds) {
      if (seenAt < cutoff) this.seenSlackEventIds.delete(eventId);
    }
  }
}

export function parseMultipartBoundary(contentType: string): string | undefined {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:("[^"]+")|([^;]+))/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const boundary = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw.trim();
  return boundary && boundary.length <= 200 ? boundary : undefined;
}

export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new AudioIngestionError(413, "request_too_large", "request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseMultipartBody(body: Buffer, boundary: string): ParsedMultipartForm {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFilePart[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) throw new AudioIngestionError(400, "invalid_multipart", "multipart boundary not found");

  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    const maybeEnd = body.subarray(partStart, partStart + 2).toString("latin1");
    if (maybeEnd === "--") break;
    if (maybeEnd !== "\r\n") throw new AudioIngestionError(400, "invalid_multipart", "malformed multipart boundary");
    partStart += 2;
    const next = body.indexOf(delimiter, partStart);
    if (next < 0) throw new AudioIngestionError(400, "invalid_multipart", "unterminated multipart body");
    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 13 && body[partEnd - 1] === 10) partEnd -= 2;
    const part = body.subarray(partStart, partEnd);
    const parsed = parseMultipartPart(part);
    if (parsed) {
      if (parsed.filename !== undefined) files.push(parsed as MultipartFilePart);
      else fields[parsed.fieldName] = parsed.data.toString("utf8");
    }
    cursor = next;
  }

  return { fields, files };
}

function parseMultipartPart(part: Buffer): (MultipartFilePart & { filename?: string }) | undefined {
  const separator = Buffer.from("\r\n\r\n");
  const headerEnd = part.indexOf(separator);
  if (headerEnd < 0) throw new AudioIngestionError(400, "invalid_multipart", "multipart part missing headers");
  const headerText = part.subarray(0, headerEnd).toString("latin1");
  const data = part.subarray(headerEnd + separator.length);
  const headers = parsePartHeaders(headerText);
  const disposition = headers["content-disposition"] ?? "";
  const params = parseContentDisposition(disposition);
  const fieldName = params.name;
  if (!fieldName) return undefined;
  return {
    fieldName,
    filename: params.filename,
    contentType: headers["content-type"],
    data
  };
}

function parsePartHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const out: { name?: string; filename?: string } = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || rawValueParts.length === 0) continue;
    let rawValue = rawValueParts.join("=").trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) rawValue = rawValue.slice(1, -1);
    rawValue = rawValue.replace(/%22/g, '"');
    if (key === "name") out.name = rawValue;
    if (key === "filename") out.filename = rawValue;
  }
  return out;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
