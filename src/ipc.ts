import { createConnection, createServer, type Server } from "node:net";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import type { Logger } from "pino";
import { pathExists } from "./util.js";
import type { JsonRecord } from "./types.js";

export type IpcMessage =
  | ({ type: "loop_run"; loopId: string; scheduledAt?: string } & IpcAuthFields)
  | ({ type: "subagent_steer"; jobId: string; text: string } & IpcAuthFields)
  | ({ type: "employee_start"; employeeId: string } & IpcAuthFields)
  | ({ type: "employee_stop"; employeeId: string } & IpcAuthFields)
  | ({ type: "employee_steer"; employeeId: string; text: string } & IpcAuthFields)
  | ({ type: "employee_status"; employeeId: string } & IpcAuthFields)
  | ({ type: "get_capability_registry" } & IpcAuthFields)
  | ({ type: "check_capability"; operation: string; action?: string; resource: JsonRecord; brainSubjectId: string; callerSubjectId?: string } & IpcAuthFields)
  | ({ type: "set_config"; entries: Record<string, string> } & IpcAuthFields)
  | ({ type: "ping" } & IpcAuthFields);

interface IpcAuthFields {
  /** Self-declared Brain subject for capability evaluation — not authentication. */
  brainSubjectId?: string;
  /** Startup-generated IPC token; required for mutating commands. */
  token?: string;
}

/**
 * Mutating commands require a valid IPC token (plan §6.7 auth caveat +
 * enforcement plan Phase 6 item 6: the socket path alone is not authorization).
 * `ping`, read-only `employee_status`, and registry metadata reads stay
 * token-ungated. Brain-attributed messages are still capability-checked by the
 * service handler.
 */
const AUTHENTICATED_IPC_TYPES = new Set<IpcMessage["type"]>([
  "loop_run",
  "subagent_steer",
  "employee_start",
  "employee_stop",
  "employee_steer",
  "set_config",
]);

export type IpcResponse = { ok: true; result?: unknown } | { ok: false; error: string; code?: string };

export class IpcRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** Path to the IPC token file, kept next to the socket at mode 0600. */
export function ipcTokenPath(socketPath: string): string {
  return join(dirname(socketPath), "ipc.token");
}

/** Read the IPC token if present; used by in-repo CLI callers (cron/loops). */
export async function readIpcToken(socketPath: string): Promise<string | undefined> {
  try {
    const token = (await readFile(ipcTokenPath(socketPath), "utf8")).trim();
    return token || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Load the IPC token, generating and persisting one (0600) if absent. */
export async function ensureIpcToken(socketPath: string): Promise<string> {
  const existing = await readIpcToken(socketPath);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  const tokenPath = ipcTokenPath(socketPath);
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return token;
}

export class LocalIpcServer {
  private server?: Server;
  private authToken?: string;

  constructor(
    private readonly socketPath: string,
    private readonly logger: Logger,
    private readonly handler: (message: IpcMessage) => Promise<unknown>
  ) {}

  async start(): Promise<void> {
    if (await pathExists(this.socketPath)) await unlink(this.socketPath);
    this.authToken = await ensureIpcToken(this.socketPath);
    this.server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            void this.handleLine(line)
              .then((response) => socket.write(`${JSON.stringify(response)}\n`))
              .catch((error) => {
                this.logger.error({ component: "ipc", event: "unhandled_message_failure", error }, "IPC message handling failed unexpectedly");
                if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, error: "invalid IPC message" } satisfies IpcResponse)}\n`);
              });
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve);
    });
    // Restrict the socket to the owning user; the token file is the actual
    // authorization, but a private socket avoids exposing it to other users.
    await chmod(this.socketPath, 0o600).catch(() => undefined);
    this.logger.info({ component: "ipc", event: "started", socketPath: this.socketPath }, "local IPC server started");
  }

  private tokenMatches(provided: string | undefined): boolean {
    if (!this.authToken || !provided) return false;
    const expected = Buffer.from(this.authToken);
    const candidate = Buffer.from(provided);
    return expected.length === candidate.length && timingSafeEqual(expected, candidate);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (await pathExists(this.socketPath)) await unlink(this.socketPath);
  }

  private async handleLine(line: string): Promise<IpcResponse> {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "invalid IPC message" };
      }
      const message = parsed as IpcMessage;
      const messageType = typeof message.type === "string" ? message.type : "unknown";
      if (AUTHENTICATED_IPC_TYPES.has(message.type) && !this.tokenMatches(message.token)) {
        this.logger.warn({ component: "ipc", event: "unauthorized", type: messageType }, "rejected IPC mutation without a valid token");
        return { ok: false, error: "unauthorized: valid IPC token required", code: "unauthorized" };
      }
      const result = await this.handler(message);
      return result === undefined ? { ok: true } : { ok: true, result };
    } catch (error) {
      let messageType = "unknown";
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as { type?: unknown }).type === "string") {
          messageType = (parsed as { type: string }).type;
        }
      } catch {
        // Never log the raw line: mutating commands (set_config) carry secrets.
        return { ok: false, error: "invalid IPC message" };
      }
      this.logger.error({ component: "ipc", event: "message_failed", error, type: messageType }, "IPC message failed");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof IpcRequestError ? error.code : undefined,
      };
    }
  }
}

export async function sendIpcMessage(socketPath: string, message: IpcMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("IPC request timed out"));
    }, 5000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.once("data", (chunk) => {
      clearTimeout(timer);
      socket.end();
      try {
        const response = JSON.parse(chunk.toString().trim()) as IpcResponse;
        if (!response.ok) reject(new Error(response.error));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}
