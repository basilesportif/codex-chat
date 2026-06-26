import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import {
  authorizeAdminRequest,
  type ClerkUserLookup,
  type VerifyClerkToken,
} from "./admin-auth.js";
import { renderAdminPage, renderAdminSignInPage } from "./admin-page.js";
import type { AppConfig } from "./config.js";
import {
  readEnvKeyPresence,
  resolveEnvFilePath,
  writeMergedEnvFile,
} from "./env-file.js";
import type { FileStore } from "./file-store.js";
import type { StateStore } from "./state.js";
import type { Transcriber } from "./transcription.js";
import {
  AudioIngestionError,
  AudioIngestionService,
  sanitizeAudioIngestMetadata,
  type AudioIngestionResponse,
} from "./audio-ingest.js";
import { authenticateIngestRequest, type IngestApiKey } from "./ingest-auth.js";
import {
  renderSlackManifest,
  validateSlackManifest,
} from "./slack-manifest.js";
import {
  normalizeSlackEventCallback,
  verifySlackRequestSignature,
  type SlackEventEnvelope,
} from "./slack.js";
import type { UserEvent } from "./types.js";

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const SLACK_EVENT_MAX_BYTES = 1024 * 1024;
const SLACK_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MAX_SEEN_SLACK_EVENTS = 5_000;
const ADMIN_JSON_MAX_BYTES = 128 * 1024;
const ADMIN_REQUIRED_ENV_VARS = [
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "CODEX_CHAT_SLACK_ENABLED",
  "CODEX_CHAT_SLACK_EVENTS_PATH",
  "CODEX_CHAT_API_ENABLED",
  "CODEX_CHAT_ADMIN_ENABLED",
  "CODEX_CHAT_BASE_URL",
  "CODEX_CHAT_ADMIN_PUBLIC_BASE_URL",
] as const;

export interface AudioIngestionCompletedEvent {
  keyIdentity: string;
  result: AudioIngestionResponse;
}

export interface ApiGatewayHooks {
  onAudioIngestionCompleted?: (
    event: AudioIngestionCompletedEvent,
  ) => Promise<void>;
  onSlackUserEvent?: (event: UserEvent) => Promise<void>;
  adminAuthDeps?: {
    verifyTokenImpl?: VerifyClerkToken;
    getUser?: ClerkUserLookup;
  };
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
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
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
    private readonly hooks: ApiGatewayHooks = {},
  ) {
    this.audioIngestion = new AudioIngestionService(
      state,
      files,
      transcriber,
      logger,
      {
        maxBytes: Math.floor(config.ingest.audioMaxMb * 1024 * 1024),
      },
    );
  }

  async start(): Promise<void> {
    if (!this.config.api.enabled) return;
    if (
      !isLoopbackApiHost(this.config.api.host) &&
      !this.config.api.allowNonLocalhost
    ) {
      throw new Error(
        `Refusing to bind codex-chat API to non-loopback host ${this.config.api.host}. Set api.allowNonLocalhost=true only behind private networking and server-to-server auth.`,
      );
    }
    if (this.config.slack.enabled && !this.config.slackSigningSecret) {
      throw new Error(
        `${this.config.slack.signingSecretEnv} is required when slack.enabled=true`,
      );
    }
    if (
      !this.config.slack.enabled &&
      this.config.ingest.apiKeys.length === 0 &&
      !this.config.admin.enabled
    ) {
      throw new Error(
        `${this.config.ingest.apiKeysEnv} is required when api.enabled=true`,
      );
    }
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        this.logger.error(
          { component: "api", event: "request_failed", error },
          "API request failed",
        );
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
    this.logger.info(
      {
        component: "api",
        event: "started",
        host: this.config.api.host,
        port: address?.port ?? this.config.api.port,
      },
      "HTTP API started",
    );
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

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? this.config.api.host}`,
    );
    if (
      this.config.admin.enabled &&
      request.method === "GET" &&
      this.isAdminRoutePath(url.pathname)
    ) {
      const canonicalPath = this.adminRoutePath();
      if (url.pathname !== canonicalPath) {
        response.statusCode = 308;
        response.setHeader("location", canonicalPath);
        response.end();
        return;
      }
      const auth = await authorizeAdminRequest(
        request,
        this.config,
        this.hooks.adminAuthDeps,
      );
      if (!auth.ok) {
        this.handleAdminPageAuthFailure(request, response, auth);
        return;
      }
      this.sendHtml(response, 200, renderAdminPage(this.config));
      return;
    }
    if (
      this.config.admin.enabled &&
      request.method === "GET" &&
      url.pathname === this.adminSignInPath()
    ) {
      const redirectUrl = safeAdminReturnUrl(
        url.searchParams.get("redirect_url"),
        this.adminPublicUrlFromRequest(request),
      );
      this.sendHtml(
        response,
        200,
        renderAdminSignInPage(this.config, redirectUrl),
      );
      return;
    }
    if (
      this.config.admin.enabled &&
      url.pathname.startsWith("/api/admin/codex-chat/")
    ) {
      await this.handleAdminRequest(request, response, url);
      return;
    }
    if (
      this.config.slack.enabled &&
      request.method === "POST" &&
      url.pathname === this.config.slack.eventsPath
    ) {
      await this.handleSlackEvents(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ingest/audio") {
      await this.handleAudioIngest(request, response);
      return;
    }
    this.sendJson(response, 404, { error: "not_found" });
  }

  private async handleAdminRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const auth = await authorizeAdminRequest(
      request,
      this.config,
      this.hooks.adminAuthDeps,
    );
    if (!auth.ok) {
      this.sendJson(response, auth.statusCode, { error: auth.error });
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/codex-chat/me"
    ) {
      this.sendJson(response, 200, {
        email: auth.admin.email,
        userId: auth.admin.userId,
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/codex-chat/slack-config"
    ) {
      await this.handleAdminSlackConfigGet(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/codex-chat/slack-config"
    ) {
      await this.handleAdminSlackConfigPost(request, response);
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/admin/codex-chat/manifest"
    ) {
      await this.handleAdminManifestGet(request, response, url);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/admin/codex-chat/manifest/validate"
    ) {
      await this.handleAdminManifestValidate(request, response);
      return;
    }
    this.sendJson(response, 404, { error: "not_found" });
  }

  private handleAdminPageAuthFailure(
    request: IncomingMessage,
    response: ServerResponse,
    auth: Exclude<
      Awaited<ReturnType<typeof authorizeAdminRequest>>,
      { ok: true }
    >,
  ): void {
    if (auth.statusCode === 401) {
      const currentUrl = this.adminPublicUrlFromRequest(request);
      const signInUrl = this.adminSignInUrlFromRequest(request);
      signInUrl.searchParams.set("redirect_url", currentUrl);
      response.statusCode = 302;
      response.setHeader("location", signInUrl.toString());
      response.end();
      return;
    }
    this.sendHtml(
      response,
      auth.statusCode,
      renderAdminDeniedPage(
        auth.error,
        this.adminSignInUrlFromRequest(request).toString(),
      ),
    );
  }

  private async handleAdminSlackConfigGet(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const envFile = resolveEnvFilePath(this.config.admin.envFile);
    const present = await readEnvKeyPresence(envFile, ADMIN_REQUIRED_ENV_VARS);
    this.sendJson(response, 200, {
      envFile,
      serviceName: this.config.admin.serviceName,
      requiredVars: ADMIN_REQUIRED_ENV_VARS,
      present,
      baseUrl: this.slackPublicBaseUrlFromRequest(request),
      eventsPath: this.config.slack.eventsPath,
      restartCommand: restartCommand(this.config.admin.serviceName),
    });
  }

  private async handleAdminSlackConfigPost(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = await readJsonBody(request, ADMIN_JSON_MAX_BYTES);
    } catch {
      this.sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    const signingSecret = stringField(payload, "signingSecret");
    const botToken = stringField(payload, "botToken");
    const appToken = stringField(payload, "appToken");
    const eventsPath =
      stringField(payload, "eventsPath") || this.config.slack.eventsPath;
    const baseUrl =
      stringField(payload, "baseUrl") ||
      this.slackPublicBaseUrlFromRequest(request);
    if (!signingSecret || !botToken) {
      this.sendJson(response, 400, {
        error: "signing_secret_and_bot_token_required",
      });
      return;
    }
    if (!eventsPath.startsWith("/")) {
      this.sendJson(response, 400, {
        error: "events_path_must_start_with_slash",
      });
      return;
    }
    try {
      new URL(baseUrl);
    } catch {
      this.sendJson(response, 400, { error: "base_url_invalid" });
      return;
    }
    const updates: Record<string, string> = {
      SLACK_SIGNING_SECRET: signingSecret,
      SLACK_BOT_TOKEN: botToken,
      CODEX_CHAT_SLACK_ENABLED: "true",
      CODEX_CHAT_SLACK_EVENTS_PATH: eventsPath,
      CODEX_CHAT_API_ENABLED: "true",
      CODEX_CHAT_ADMIN_ENABLED: "true",
      CODEX_CHAT_BASE_URL: baseUrl,
    };
    if (appToken) updates.SLACK_APP_TOKEN = appToken;
    await writeMergedEnvFile(this.config.admin.envFile, updates);
    this.sendJson(response, 200, {
      ok: true,
      message:
        "Slack env values were written without echoing secrets. Restart codex-chat to apply them.",
      envFile: resolveEnvFilePath(this.config.admin.envFile),
      restartRequired: true,
      restartCommand: restartCommand(this.config.admin.serviceName),
    });
  }

  private async handleAdminManifestGet(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    try {
      const baseUrl =
        url.searchParams.get("baseUrl") ||
        this.slackPublicBaseUrlFromRequest(request);
      const eventsPath =
        url.searchParams.get("eventsPath") || this.config.slack.eventsPath;
      const rendered = await renderSlackManifest({
        rootDir: this.config.rootDir,
        baseUrl,
        eventsPath,
      });
      this.sendJson(response, 200, rendered);
    } catch (error) {
      this.sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleAdminManifestValidate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let payload: Record<string, unknown>;
    try {
      payload = await readJsonBody(request, ADMIN_JSON_MAX_BYTES);
    } catch {
      this.sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    const text = stringField(payload, "manifest");
    if (!text) {
      this.sendJson(response, 400, { error: "manifest_required" });
      return;
    }
    try {
      const manifest = JSON.parse(text);
      const requestUrl = (
        manifest as {
          settings?: { event_subscriptions?: { request_url?: string } };
        }
      ).settings?.event_subscriptions?.request_url;
      const expectedEventsPath =
        typeof requestUrl === "string"
          ? new URL(requestUrl).pathname
          : this.config.slack.eventsPath;
      this.sendJson(response, 200, {
        validation: validateSlackManifest(manifest, expectedEventsPath),
      });
    } catch (error) {
      this.sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleSlackEvents(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request, SLACK_EVENT_MAX_BYTES);
    const verification = verifySlackRequestSignature({
      signingSecret: this.config.slackSigningSecret,
      body,
      timestampHeader: firstHeaderValue(
        request.headers["x-slack-request-timestamp"],
      ),
      signatureHeader: firstHeaderValue(request.headers["x-slack-signature"]),
    });
    if (!verification.ok) {
      const statusCode = verification.reason === "missing_secret" ? 503 : 401;
      this.logger.warn(
        {
          component: "slack",
          event: "signature_rejected",
          reason: verification.reason,
        },
        "Slack request signature rejected",
      );
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

    if (
      envelope.type === "url_verification" &&
      typeof envelope.challenge === "string"
    ) {
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
      this.logger.debug(
        {
          component: "slack",
          event: "event_ignored",
          reason: normalized.reason,
          eventId: normalized.eventId,
        },
        "Slack event ignored",
      );
      this.sendJson(response, 200, {
        ok: true,
        ignored: true,
        reason: normalized.reason,
      });
      return;
    }

    this.rememberSlackEvent(normalized.eventId);
    this.sendJson(response, 200, { ok: true });
    void this.hooks.onSlackUserEvent?.(normalized.event).catch((error) => {
      this.logger.error(
        {
          component: "slack",
          event: "enqueue_failed",
          eventId: normalized.eventId,
          error,
        },
        "Slack event acknowledged but enqueue failed",
      );
    });
  }

  private async handleAudioIngest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const auth = authenticateIngestRequest(
      request,
      this.config.ingest.apiKeys as readonly IngestApiKey[],
    );
    if (!auth.authorized || !auth.identity) {
      this.sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    this.logger.info(
      {
        component: "api",
        event: "audio_ingest_request_received",
        keyIdentity: auth.identity,
      },
      "audio ingestion request received",
    );

    let form: ParsedMultipartForm;
    try {
      form = await this.readMultipartForm(request, this.maxBodyBytes());
    } catch (error) {
      const statusCode =
        error instanceof AudioIngestionError ? error.statusCode : 400;
      const errorCode =
        error instanceof AudioIngestionError
          ? error.errorCode
          : "invalid_multipart";
      this.logger.warn(
        {
          component: "api",
          event: "audio_ingest_rejected",
          keyIdentity: auth.identity,
          statusCode,
          errorCode,
        },
        "audio ingestion request rejected",
      );
      this.sendJson(response, statusCode, { error: errorCode });
      return;
    }

    const file = form.files.find((part) => part.fieldName === "file");
    if (!file) {
      this.sendJson(response, 400, { error: "missing_file" });
      return;
    }

    const metadata = sanitizeAudioIngestMetadata(form.fields);
    this.logger.info(
      {
        component: "api",
        event: "audio_ingest_file_received",
        keyIdentity: auth.identity,
        filename: file.filename,
        contentType: file.contentType,
        sizeBytes: file.data.length,
      },
      "audio ingestion file received",
    );

    try {
      const result = await this.audioIngestion.ingest({
        keyIdentity: auth.identity,
        metadata,
        file: {
          filename: file.filename,
          contentType: file.contentType,
          data: file.data,
        },
      });
      this.logger.info(
        {
          component: "api",
          event: "audio_ingest_completed",
          keyIdentity: auth.identity,
          ingestionId: result.ingestion_id,
          status: result.status,
          duplicate: result.duplicate || undefined,
        },
        "audio ingestion request completed",
      );
      if (!result.duplicate && result.status === "completed") {
        try {
          await this.hooks.onAudioIngestionCompleted?.({
            keyIdentity: auth.identity,
            result,
          });
        } catch (error) {
          this.logger.error(
            {
              component: "api",
              event: "audio_ingest_delivery_failed",
              keyIdentity: auth.identity,
              ingestionId: result.ingestion_id,
              error,
            },
            "audio ingestion completed but delivery to message handling failed",
          );
        }
      }
      this.sendJson(response, result.duplicate ? 200 : 201, result);
    } catch (error) {
      const statusCode =
        error instanceof AudioIngestionError ? error.statusCode : 500;
      const errorCode =
        error instanceof AudioIngestionError
          ? error.errorCode
          : "internal_error";
      this.logger.error(
        {
          component: "api",
          event: "audio_ingest_failed",
          keyIdentity: auth.identity,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.data.length,
          statusCode,
          errorCode,
          error,
        },
        "audio ingestion request failed",
      );
      this.sendJson(response, statusCode, { error: errorCode });
    }
  }

  private async readMultipartForm(
    request: IncomingMessage,
    maxBytes: number,
  ): Promise<ParsedMultipartForm> {
    const contentType = firstHeaderValue(request.headers["content-type"]);
    const boundary = parseMultipartBoundary(contentType);
    if (!boundary)
      throw new AudioIngestionError(
        400,
        "invalid_multipart",
        "multipart/form-data boundary is required",
      );
    const body = await readBody(request, maxBytes);
    return parseMultipartBody(body, boundary);
  }

  private maxBodyBytes(): number {
    return Math.max(
      1,
      Math.floor(this.config.ingest.audioMaxMb * 1024 * 1024) +
        MULTIPART_OVERHEAD_BYTES,
    );
  }

  private sendJson(
    response: ServerResponse,
    statusCode: number,
    value: unknown,
  ): void {
    if (response.headersSent) return;
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(value)}\n`);
  }

  private sendHtml(
    response: ServerResponse,
    statusCode: number,
    value: string,
  ): void {
    if (response.headersSent) return;
    response.statusCode = statusCode;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(value);
  }

  private slackPublicBaseUrlFromRequest(request: IncomingMessage): string {
    const configured = this.config.slack.publicBaseUrl.trim();
    if (configured) return configured;
    return this.originFromRequest(request);
  }

  private adminPublicBaseUrlFromRequest(request: IncomingMessage): string {
    const configured = this.config.admin.publicBaseUrl.trim();
    if (configured) return configured;
    return this.originFromRequest(request);
  }

  private adminRoutePath(): string {
    return normalizeAdminPath(this.config.admin.routePath);
  }

  private isAdminRoutePath(pathname: string): boolean {
    const routePath = this.adminRoutePath();
    if (pathname === routePath) return true;
    if (routePath.endsWith("/")) return pathname === routePath.slice(0, -1);
    return pathname === `${routePath}/`;
  }

  private adminSignInPath(): string {
    const routePath = this.adminRoutePath().replace(/\/+$/, "");
    return `${routePath || ""}/auth/sign-in` || "/auth/sign-in";
  }

  private adminPublicUrlFromRequest(request: IncomingMessage): string {
    const base = this.adminPublicBaseUrlFromRequest(request);
    const url = new URL(this.adminRoutePath(), ensureTrailingSlash(base));
    return stripTrailingSlashExceptRoot(url.toString());
  }

  private adminSignInUrlFromRequest(request: IncomingMessage): URL {
    const base = this.adminPublicBaseUrlFromRequest(request);
    const fallback = new URL(this.adminSignInPath(), ensureTrailingSlash(base));
    const configured = this.config.clerkSignInUrl?.trim();
    if (!configured) return fallback;
    const configuredUrl = new URL(configured, ensureTrailingSlash(base));
    return isClerkHostedAccountUrl(configuredUrl) ||
      configuredUrl.origin !== fallback.origin
      ? fallback
      : configuredUrl;
  }

  private originFromRequest(request: IncomingMessage): string {
    const proto =
      firstHeaderValue(request.headers["x-forwarded-proto"]) || "https";
    const host =
      firstHeaderValue(request.headers["x-forwarded-host"]) ||
      firstHeaderValue(request.headers.host) ||
      this.config.api.host;
    return `${proto}://${host}`;
  }

  private hasSeenSlackEvent(eventId: string): boolean {
    this.pruneSeenSlackEvents();
    return this.seenSlackEventIds.has(eventId);
  }

  private rememberSlackEvent(eventId: string): void {
    this.pruneSeenSlackEvents();
    this.seenSlackEventIds.set(eventId, Date.now());
    while (this.seenSlackEventIds.size > MAX_SEEN_SLACK_EVENTS) {
      const oldest = this.seenSlackEventIds.keys().next().value as
        | string
        | undefined;
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

export function parseMultipartBoundary(
  contentType: string,
): string | undefined {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:("[^"]+")|([^;]+))/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return undefined;
  const boundary =
    raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw.trim();
  return boundary && boundary.length <= 200 ? boundary : undefined;
}

export async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes)
      throw new AudioIngestionError(
        413,
        "request_too_large",
        "request body too large",
      );
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function parseMultipartBody(
  body: Buffer,
  boundary: string,
): ParsedMultipartForm {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: MultipartFilePart[] = [];
  let cursor = body.indexOf(delimiter);
  if (cursor < 0)
    throw new AudioIngestionError(
      400,
      "invalid_multipart",
      "multipart boundary not found",
    );

  while (cursor >= 0) {
    let partStart = cursor + delimiter.length;
    const maybeEnd = body.subarray(partStart, partStart + 2).toString("latin1");
    if (maybeEnd === "--") break;
    if (maybeEnd !== "\r\n")
      throw new AudioIngestionError(
        400,
        "invalid_multipart",
        "malformed multipart boundary",
      );
    partStart += 2;
    const next = body.indexOf(delimiter, partStart);
    if (next < 0)
      throw new AudioIngestionError(
        400,
        "invalid_multipart",
        "unterminated multipart body",
      );
    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 13 && body[partEnd - 1] === 10)
      partEnd -= 2;
    const part = body.subarray(partStart, partEnd);
    const parsed = parseMultipartPart(part);
    if (parsed) {
      if (parsed.filename !== undefined)
        files.push(parsed as MultipartFilePart);
      else fields[parsed.fieldName] = parsed.data.toString("utf8");
    }
    cursor = next;
  }

  return { fields, files };
}

function parseMultipartPart(
  part: Buffer,
): (MultipartFilePart & { filename?: string }) | undefined {
  const separator = Buffer.from("\r\n\r\n");
  const headerEnd = part.indexOf(separator);
  if (headerEnd < 0)
    throw new AudioIngestionError(
      400,
      "invalid_multipart",
      "multipart part missing headers",
    );
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
    data,
  };
}

function parsePartHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line
      .slice(index + 1)
      .trim();
  }
  return headers;
}

function parseContentDisposition(value: string): {
  name?: string;
  filename?: string;
} {
  const out: { name?: string; filename?: string } = {};
  for (const part of value.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || rawValueParts.length === 0) continue;
    let rawValue = rawValueParts.join("=").trim();
    if (rawValue.startsWith('"') && rawValue.endsWith('"'))
      rawValue = rawValue.slice(1, -1);
    rawValue = rawValue.replace(/%22/g, '"');
    if (key === "name") out.name = rawValue;
    if (key === "filename") out.filename = rawValue;
  }
  return out;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const body = await readBody(request, maxBytes);
  const parsed = JSON.parse(body.toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("JSON body must be an object");
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function restartCommand(serviceName: string): string {
  return `systemctl --user restart ${serviceName} || sudo systemctl restart ${serviceName}`;
}

function externalUrlFromRequest(
  request: IncomingMessage,
  configuredBaseUrl: string,
): string {
  const url = new URL(
    request.url ?? "/",
    configuredBaseUrl || "http://127.0.0.1",
  );
  const proto = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const host =
    firstHeaderValue(request.headers["x-forwarded-host"]) ||
    firstHeaderValue(request.headers.host);
  if (host) url.host = host;
  if (proto) url.protocol = `${proto}:`;
  return url.toString();
}

function normalizeAdminPath(value: string): string {
  const path = value.trim() || "/admin/codex-chat/";
  return path.startsWith("/") ? path : `/${path}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripTrailingSlashExceptRoot(value: string): string {
  const url = new URL(value);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function safeAdminReturnUrl(
  candidate: string | null,
  fallback: string,
): string {
  if (!candidate) return fallback;
  try {
    const parsed = new URL(candidate);
    const expected = new URL(fallback);
    return parsed.origin === expected.origin ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function isClerkHostedAccountUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "accounts.dev" ||
    hostname.endsWith(".accounts.dev") ||
    hostname.endsWith(".accounts.clerk.dev")
  );
}

function renderAdminDeniedPage(
  error: string,
  signInUrl: string | undefined,
): string {
  const escapedError = error
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const link = signInUrl
    ? `<p><a href="${signInUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Sign in or switch Clerk account</a></p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>codex-chat admin denied</title><style>body{font:16px system-ui;margin:3rem;max-width:720px;background:#0f172a;color:#e5e7eb}.card{border:1px solid #334155;border-radius:16px;padding:24px;background:#111827}.bad{color:#f87171}a{color:#38bdf8}</style></head><body><section class="card"><h1>codex-chat admin access denied</h1><p class="bad">${escapedError}</p><p>Admin routes require Clerk auth and a non-empty server-side allowlist.</p>${link}</section></body></html>`;
}
