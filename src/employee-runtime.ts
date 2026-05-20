import type { Attachment, CodexEvent } from "./types.js";

export interface EmployeeThreadSpec {
  id: string;
  name: string;
  description?: string;
  directory: string;
  profile: string;
  model: string;
  effort: string;
  serviceName: string;
  baseInstructions: string;
  developerInstructions: string;
  persistRawLogs?: boolean;
}

export interface EmployeeThreadStartResult {
  backendThreadId: string;
}

export interface EmployeeThreadResumeInput extends EmployeeThreadSpec {
  backendThreadId: string;
}

export interface EmployeeTurnInput extends EmployeeThreadSpec {
  backendThreadId: string;
  text: string;
  attachments?: Attachment[];
  onTurnStarted?(turnId: string): void | Promise<void>;
}

export interface EmployeeRuntimeClient {
  startEmployeeThread(input: EmployeeThreadSpec): Promise<EmployeeThreadStartResult>;
  resumeEmployeeThread(input: EmployeeThreadResumeInput): Promise<void>;
  sendEmployeeTurn(input: EmployeeTurnInput): AsyncIterable<CodexEvent>;
}
