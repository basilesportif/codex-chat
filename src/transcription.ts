import { createReadStream } from "node:fs";
import OpenAI from "openai";
import { AppConfig } from "./config.js";

export interface TranscriptionInput {
  path: string;
  mimeType?: string;
  language?: string;
  prompt?: string;
}

export interface TranscriptionResult {
  text: string;
  durationSec?: number;
  provider: string;
  model: string;
  raw?: unknown;
}

export interface Transcriber {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    if (!config.openaiApiKey) throw new Error(`${config.transcription.apiKeyEnv} is required for OpenAI transcription`);
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(input.path) as never,
      model: this.config.transcription.model,
      language: input.language || this.config.transcription.language || undefined,
      prompt: input.prompt
    } as never) as { text?: string };
    return {
      text: response.text ?? "",
      provider: "openai",
      model: this.config.transcription.model,
      raw: response
    };
  }
}

export class DisabledTranscriber implements Transcriber {
  async transcribe(): Promise<TranscriptionResult> {
    throw new Error("Voice transcription is not enabled");
  }
}
