import type { Attachment, CodexEvent } from "./types.js";

export interface FactorThreadSpec {
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

export interface FactorThreadStartResult {
  backendThreadId: string;
}

export interface FactorThreadResumeInput extends FactorThreadSpec {
  backendThreadId: string;
}

export interface FactorTurnInput extends FactorThreadSpec {
  backendThreadId: string;
  text: string;
  attachments?: Attachment[];
  onTurnStarted?(turnId: string): void | Promise<void>;
}

export interface FactorRuntimeClient {
  startFactorThread(input: FactorThreadSpec): Promise<FactorThreadStartResult>;
  resumeFactorThread(input: FactorThreadResumeInput): Promise<void>;
  sendFactorTurn(input: FactorTurnInput): AsyncIterable<CodexEvent>;
}
