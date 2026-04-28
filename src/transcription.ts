import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { AppConfig, resolveConfigPath } from "./config.js";

export interface TranscriptionResult {
  text: string;
}

export interface Transcriber {
  transcribe(input: { path: string }): Promise<TranscriptionResult>;
}

export class OpenAITranscriber implements Transcriber {
  private readonly client: OpenAI;
  private readonly promptPath?: string;

  constructor(private readonly config: AppConfig) {
    if (!config.openaiApiKey) throw new Error(`${config.transcription.apiKeyEnv} is required for OpenAI transcription`);
    this.client = new OpenAI({ apiKey: config.openaiApiKey });
    const promptPath = config.transcription.promptPath.trim();
    this.promptPath = promptPath ? resolveConfigPath(config, promptPath) : undefined;
  }

  async transcribe(input: { path: string }): Promise<TranscriptionResult> {
    const request: Record<string, unknown> = {
      file: createReadStream(input.path) as never,
      model: this.config.transcription.model,
      language: this.config.transcription.language || undefined
    };
    const prompt = await this.readPrompt();
    if (prompt !== undefined) request.prompt = prompt;
    const response = await this.client.audio.transcriptions.create(request as never) as { text?: string };
    return { text: response.text ?? "" };
  }

  private async readPrompt(): Promise<string | undefined> {
    if (!this.promptPath) return undefined;
    try {
      const prompt = await readFile(this.promptPath, "utf8");
      return prompt.trim().length > 0 ? prompt : undefined;
    } catch {
      return undefined;
    }
  }
}

export class DisabledTranscriber implements Transcriber {
  async transcribe(): Promise<TranscriptionResult> {
    throw new Error("Voice transcription is not enabled");
  }
}
