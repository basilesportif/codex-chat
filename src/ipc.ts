import { createConnection, createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import type { Logger } from "pino";
import { pathExists } from "./util.js";

export type IpcMessage =
  | ({ type: "loop_run"; loopId: string; scheduledAt?: string } & IpcAuthFields)
  | ({ type: "subagent_steer"; jobId: string; text: string } & IpcAuthFields)
  | ({ type: "employee_start"; employeeId: string } & IpcAuthFields)
  | ({ type: "employee_stop"; employeeId: string } & IpcAuthFields)
  | ({ type: "employee_steer"; employeeId: string; text: string } & IpcAuthFields)
  | ({ type: "employee_status"; employeeId: string } & IpcAuthFields)
  | ({ type: "ping" } & IpcAuthFields);

interface IpcAuthFields {
  brainSubjectId?: string;
}

export type IpcResponse = { ok: true; result?: unknown } | { ok: false; error: string };

export class LocalIpcServer {
  private server?: Server;

  constructor(
    private readonly socketPath: string,
    private readonly logger: Logger,
    private readonly handler: (message: IpcMessage) => Promise<unknown>
  ) {}

  async start(): Promise<void> {
    if (await pathExists(this.socketPath)) await unlink(this.socketPath);
    this.server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            void this.handleLine(line).then((response) => socket.write(`${JSON.stringify(response)}\n`));
          }
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.socketPath, resolve);
    });
    this.logger.info({ component: "ipc", event: "started", socketPath: this.socketPath }, "local IPC server started");
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    if (await pathExists(this.socketPath)) await unlink(this.socketPath);
  }

  private async handleLine(line: string): Promise<IpcResponse> {
    try {
      const result = await this.handler(JSON.parse(line) as IpcMessage);
      return result === undefined ? { ok: true } : { ok: true, result };
    } catch (error) {
      this.logger.error({ component: "ipc", event: "message_failed", error, line }, "IPC message failed");
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
