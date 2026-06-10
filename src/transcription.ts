import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { AppConfig, resolveConfigPath } from "./config.js";

export const TRANSCRIPTION_MODES = ["regular", "diarize"] as const;
export type TranscriptionMode = typeof TRANSCRIPTION_MODES[number];

export interface TranscriptionSpeakerSegment {
  id?: string;
  type?: string;
  start: number;
  end: number;
  text: string;
  speaker: string;
}

export interface TranscriptionResult {
  text: string;
  mode?: TranscriptionMode;
  model?: string;
  speakerSegments?: TranscriptionSpeakerSegment[];
  rawDiarizedJson?: unknown;
}

export interface TranscribeInput {
  path: string;
  mode?: TranscriptionMode;
}

export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
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

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    const mode = input.mode ?? "regular";
    const model = mode === "diarize" ? this.config.transcription.diarizeModel : this.config.transcription.model;
    const request: Record<string, unknown> = {
      file: createReadStream(input.path) as never,
      model,
      language: this.config.transcription.language || undefined
    };
    if (mode === "diarize") {
      // Official OpenAI docs/API schema: gpt-4o-transcribe-diarize does not
      // support prompt/logprobs/timestamp_granularities, and diarized_json is
      // required to receive speaker annotations. chunking_strategy:auto is
      // recommended/required for longer diarization inputs.
      request.response_format = "diarized_json";
      request.chunking_strategy = "auto";
    } else {
      const prompt = await this.readPrompt();
      if (prompt !== undefined) request.prompt = prompt;
    }
    const response = await this.client.audio.transcriptions.create(request as never);
    return normalizeTranscriptionResponse(response, mode, model);
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

function normalizeTranscriptionResponse(response: unknown, mode: TranscriptionMode, model: string): TranscriptionResult {
  if (typeof response === "string") return { text: response, mode, model };
  const record = isRecord(response) ? response : {};
  const text = typeof record.text === "string" ? record.text : "";
  const speakerSegments = mode === "diarize" ? normalizeSpeakerSegments(record.segments) : undefined;
  return {
    text,
    mode,
    model,
    speakerSegments: speakerSegments && speakerSegments.length > 0 ? speakerSegments : undefined,
    rawDiarizedJson: mode === "diarize" ? response : undefined
  };
}

function normalizeSpeakerSegments(value: unknown): TranscriptionSpeakerSegment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const segments: TranscriptionSpeakerSegment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const start = typeof item.start === "number" ? item.start : undefined;
    const end = typeof item.end === "number" ? item.end : undefined;
    const text = typeof item.text === "string" ? item.text : undefined;
    const speaker = typeof item.speaker === "string" ? item.speaker : undefined;
    if (start === undefined || end === undefined || text === undefined || speaker === undefined) continue;
    segments.push({
      id: typeof item.id === "string" ? item.id : undefined,
      type: typeof item.type === "string" ? item.type : undefined,
      start,
      end,
      text,
      speaker
    });
  }
  return segments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
