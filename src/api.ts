import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { StateStore, ApiMessageAcceptedResponse } from "./state.js";
import type { MessageChannel, StoredConversationMessage, UserEvent } from "./types.js";
import { originForChannel } from "./origin.js";
import { makeId, nowIso } from "./util.js";

const API_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const MAX_API_IDEMPOTENCY = 10_000;

const webChannelSchema = z.enum(["web", "api"]);

interface ApiCallbacks {
  onUserEvent(event: UserEvent): Promise<void>;
}

export interface ApiMessageResponse extends ApiMessageAcceptedResponse {
  duplicate?: boolean;
}

export function isLoopbackApiHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

export class ApiGateway {
  private server?: Server;

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore,
    private readonly logger: Logger,
    private readonly callbacks: ApiCallbacks
  ) {}

  async start(): Promise<void> {
    if (!this.config.api.enabled) return;
    if (!isLoopbackApiHost(this.config.api.host) && !this.config.api.allowNonLocalhost) {
      throw new Error(`Refusing to bind codex-chat API to non-loopback host ${this.config.api.host}. Set api.allowNonLocalhost=true only behind private networking and server-to-server auth.`);
    }
    if (!this.config.apiToken) {
      throw new Error(`${this.config.api.tokenEnv} is required when api.enabled=true`);
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
    this.logger.info({ component: "api", event: "started", host: this.config.api.host, port: address?.port ?? this.config.api.port }, "local HTTP API started");
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
    if (!this.isAuthorized(request)) {
      this.sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? this.config.api.host}`);
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      await this.handlePostMessage(request, response);
      return;
    }

    const match = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
    if (request.method === "GET" && match?.[1]) {
      await this.handleGetMessages(response, decodeURIComponent(match[1]), url);
      return;
    }

    this.sendJson(response, 404, { error: "not_found" });
  }

  private async handlePostMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rawBody = "";
    try {
      rawBody = await this.readBody(request);
    } catch (error) {
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? (error as { statusCode: number }).statusCode : 400;
      this.sendJson(response, statusCode, { error: statusCode === 413 ? "request_too_large" : "invalid_request" });
      return;
    }
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      this.sendJson(response, 400, { error: "invalid_json" });
      return;
    }

    const schema = z.object({
      text: z.string().min(1),
      conversationKey: z.string().min(1).max(256).optional(),
      clientMessageId: z.string().min(1).max(256).optional(),
      logicalUserId: z.string().min(1).optional(),
      channel: webChannelSchema.optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }).strict();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      this.sendJson(response, 400, { error: "invalid_request", detail: parsed.error.issues.map((issue) => issue.message).join("; ") });
      return;
    }
    if (Buffer.byteLength(parsed.data.text, "utf8") > this.config.api.maxTextBytes) {
      this.sendJson(response, 413, { error: "text_too_large" });
      return;
    }

    const logicalUserId = parsed.data.logicalUserId ?? this.config.api.logicalUserId;
    if (logicalUserId !== this.config.api.logicalUserId) {
      this.sendJson(response, 403, { error: "logical_user_not_allowed" });
      return;
    }
    const conversationKey = parsed.data.conversationKey ?? this.config.api.defaultConversationKey;
    const channel: Exclude<MessageChannel, "telegram"> = parsed.data.channel ?? (conversationKey.startsWith("api:") ? "api" : "web");
    const messageId = makeId("msg");
    const accepted: ApiMessageAcceptedResponse = { accepted: true, messageId, conversationKey, status: "queued" };
    const idempotencyKey = this.idempotencyKey(request, parsed.data.clientMessageId, conversationKey);
    if (idempotencyKey) {
      const claim = await this.state.claimApiIdempotencyKey(idempotencyKey, accepted, {
        ttlMs: API_IDEMPOTENCY_TTL_MS,
        maxEntries: MAX_API_IDEMPOTENCY
      });
      if (!claim.claimed) {
        this.sendJson(response, 200, { ...claim.response, duplicate: true } satisfies ApiMessageResponse);
        return;
      }
    }

    const receivedAt = nowIso();
    const origin = originForChannel({
      channel,
      conversationKey,
      logicalUserId,
      messageId,
      metadata: {
        ...parsed.data.metadata,
        clientMessageId: parsed.data.clientMessageId
      }
    });
    const stored: StoredConversationMessage = {
      id: messageId,
      direction: "inbound",
      channel,
      logicalUserId,
      conversationKey,
      channelMessageId: parsed.data.clientMessageId,
      text: parsed.data.text,
      attachments: [],
      receivedAt,
      metadata: parsed.data.metadata
    };
    await this.state.recordChannelMessage(stored);
    await this.callbacks.onUserEvent({
      source: channel,
      origin,
      text: parsed.data.text,
      attachments: [],
      receivedAt,
      metadata: {
        ...parsed.data.metadata,
        apiMessageId: messageId,
        clientMessageId: parsed.data.clientMessageId
      }
    });
    this.sendJson(response, 202, accepted satisfies ApiMessageResponse);
  }

  private async handleGetMessages(response: ServerResponse, conversationKey: string, url: URL): Promise<void> {
    const after = url.searchParams.get("after") ?? undefined;
    const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const messages = await this.state.listConversationMessages(conversationKey, {
      after,
      limit: Number.isFinite(rawLimit) ? rawLimit : 100
    });
    const nextCursor = messages.at(-1)?.id ?? after;
    this.sendJson(response, 200, { conversationKey, messages, nextCursor });
  }

  private idempotencyKey(request: IncomingMessage, clientMessageId: string | undefined, conversationKey: string): string | undefined {
    const header = request.headers["idempotency-key"];
    const raw = Array.isArray(header) ? header[0] : header;
    const value = (raw || clientMessageId || "").trim();
    return value ? `${conversationKey}:${value}` : undefined;
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += buffer.length;
      if (size > this.config.api.maxBodyBytes) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const token = this.config.apiToken;
    if (!token) return false;
    const header = request.headers.authorization ?? "";
    const raw = Array.isArray(header) ? header[0] ?? "" : header;
    const match = raw.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return false;
    const provided = Buffer.from(match[1]);
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  private sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
    if (response.headersSent) return;
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(`${JSON.stringify(value)}\n`);
  }
}
