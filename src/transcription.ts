import { createReadStream } from "node:fs";
import OpenAI from "openai";
import { AppConfig } from "./config.js";

export interface TranscriptionResult {
  text: string;
}

export interface Transcriber {
  transcribe(input: { path: string }): Promise<TranscriptionResult>;
}

export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;

  constructor(private readonly config: AppConfig) {
    if (!config.openaiApiKey) throw new Error(`${config.transcription.apiKeyEnv} is required for OpenAI transcription`);
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
  }

  async transcribe(input: { path: string }): Promise<TranscriptionResult> {
    const response = await this.client.audio.transcriptions.create({
      file: createReadStream(input.path) as never,
      model: this.config.transcription.model,
      language: this.config.transcription.language || undefined
    } as never) as { text?: string };
    return { text: response.text ?? "" };
  }
}

export class DisabledTranscriber implements Transcriber {
  async transcribe(): Promise<TranscriptionResult> {
    throw new Error("Voice transcription is not enabled");
  }
}
