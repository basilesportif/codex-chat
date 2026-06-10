import { basename, extname, join } from "node:path";
import type { Logger } from "pino";
import type { FileStore } from "./file-store.js";
import type { StateStore } from "./state.js";
import type { Attachment } from "./types.js";
import type { Transcriber } from "./transcription.js";
import { makeId, nowIso, sha256Buffer } from "./util.js";

export const AUDIO_INGESTION_STATUSES = ["received", "transcribing", "completed", "failed", "queued"] as const;
export type AudioIngestionStatus = typeof AUDIO_INGESTION_STATUSES[number];

export interface AudioIngestMetadata {
  source?: string;
  device?: string;
  title?: string;
  recorded_at?: string;
  client_request_id?: string;
  notes?: string;
  prompt?: string;
}

export interface AudioIngestFileInput {
  filename?: string;
  contentType?: string;
  data: Buffer;
}

export interface AudioIngestionRecord {
  id: string;
  status: AudioIngestionStatus;
  createdAt: string;
  updatedAt: string;
  keyIdentity: string;
  metadata: AudioIngestMetadata;
  file?: Attachment & { ingestionId?: string };
  transcription?: {
    status: "queued" | "completed" | "failed";
    text?: string;
    error?: string;
    completedAt?: string;
  };
  error?: string;
}

export interface AudioIngestionResponse {
  ingestion_id: string;
  status: AudioIngestionStatus;
  duplicate?: boolean;
  metadata?: AudioIngestMetadata;
  file?: {
    filename?: string;
    content_type?: string;
    size_bytes?: number;
    sha256?: string;
  };
  transcription?: {
    status: "queued" | "completed" | "failed";
    text?: string;
    error?: string;
  };
}

export interface AudioIngestionServiceOptions {
  maxBytes: number;
}

export class AudioIngestionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message?: string
  ) {
    super(message ?? errorCode);
  }
}

const supportedAudioTypes: Record<string, { extensions: string[]; canonicalExtension: string; kind: Attachment["kind"] }> = {
  "audio/mpeg": { extensions: [".mp3"], canonicalExtension: ".mp3", kind: "audio" }
};

export class AudioIngestionService {
  constructor(
    private readonly state: StateStore,
    private readonly files: FileStore,
    private readonly transcriber: Transcriber,
    private readonly logger: Logger,
    private readonly options: AudioIngestionServiceOptions
  ) {}

  async ingest(input: {
    keyIdentity: string;
    metadata: AudioIngestMetadata;
    file: AudioIngestFileInput;
  }): Promise<AudioIngestionResponse> {
    const clientRequestId = input.metadata.client_request_id?.trim();
    if (clientRequestId) {
      const existingIngestionId = await this.state.findAudioIngestionByClientRequest(input.keyIdentity, clientRequestId);
      const existing = existingIngestionId ? await this.waitForAudioIngestion(existingIngestionId) : undefined;
      if (existing) {
        this.logger.info({
          component: "audio_ingest",
          event: "idempotent_duplicate",
          keyIdentity: input.keyIdentity,
          ingestionId: existing.id,
          status: existing.status
        }, "audio ingestion duplicate request returned existing record");
        return this.responseFromRecord(existing, true);
      }
    }

    this.validateFile(input.file);

    const ingestionId = makeId("ing");
    if (clientRequestId) {
      const claim = await this.state.claimAudioIngestionClientRequest(input.keyIdentity, clientRequestId, ingestionId);
      if (!claim.claimed) {
        const existing = await this.waitForAudioIngestion(claim.ingestionId);
        if (existing) {
          this.logger.info({
            component: "audio_ingest",
            event: "idempotent_duplicate",
            keyIdentity: input.keyIdentity,
            ingestionId: existing.id,
            status: existing.status
          }, "audio ingestion duplicate request returned existing record");
          return this.responseFromRecord(existing, true);
        }
        // Stale idempotency pointer: continue with this request rather than breaking the client.
        this.logger.warn({
          component: "audio_ingest",
          event: "idempotency_record_missing",
          keyIdentity: input.keyIdentity,
          ingestionId: claim.ingestionId
        }, "audio ingestion idempotency pointer had no record");
      }
    }

    const now = nowIso();
    let record: AudioIngestionRecord = {
      id: ingestionId,
      status: "received",
      createdAt: now,
      updatedAt: now,
      keyIdentity: input.keyIdentity,
      metadata: input.metadata
    };
    await this.state.saveAudioIngestion(record);

    try {
      const file = await this.files.storeIngestedAudio({
        ingestionId,
        buffer: input.file.data,
        mimeType: normalizedContentType(input.file.contentType),
        originalName: input.file.filename,
        keyIdentity: input.keyIdentity,
        metadata: input.metadata
      });
      record = {
        ...record,
        file: { ...file, ingestionId },
        status: "transcribing",
        transcription: { status: "queued" },
        updatedAt: nowIso()
      };
      await this.state.saveAudioIngestion(record);
      this.logger.info({
        component: "audio_ingest",
        event: "transcription_started",
        keyIdentity: input.keyIdentity,
        ingestionId,
        filename: safeFilename(input.file.filename),
        contentType: normalizedContentType(input.file.contentType),
        sizeBytes: input.file.data.length
      }, "audio ingestion transcription started");

      const transcript = await this.transcriber.transcribe({ path: file.localPath });
      record = {
        ...record,
        status: "completed",
        transcription: { status: "completed", text: transcript.text, completedAt: nowIso() },
        updatedAt: nowIso()
      };
      await this.state.saveAudioIngestion(record);
      this.logger.info({
        component: "audio_ingest",
        event: "transcription_completed",
        keyIdentity: input.keyIdentity,
        ingestionId,
        status: record.status,
        transcriptBytes: Buffer.byteLength(transcript.text, "utf8")
      }, "audio ingestion transcription completed");
      return this.responseFromRecord(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record = {
        ...record,
        status: "failed",
        transcription: { status: "failed", error: message },
        error: message,
        updatedAt: nowIso()
      };
      await this.state.saveAudioIngestion(record);
      this.logger.error({
        component: "audio_ingest",
        event: "transcription_failed",
        keyIdentity: input.keyIdentity,
        ingestionId,
        status: record.status,
        error
      }, "audio ingestion transcription failed");
      throw new AudioIngestionError(502, "transcription_failed", message);
    }
  }

  private async waitForAudioIngestion(ingestionId: string): Promise<AudioIngestionRecord | undefined> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const record = await this.state.readAudioIngestion(ingestionId);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return undefined;
  }

  validateFile(file: AudioIngestFileInput): void {
    if (!file.data || file.data.length === 0) throw new AudioIngestionError(400, "missing_file", "file is required");
    if (file.data.length > this.options.maxBytes) throw new AudioIngestionError(413, "file_too_large", "file exceeds maximum size");
    const contentType = normalizedContentType(file.contentType);
    const ext = extname(file.filename ?? "").toLowerCase();
    const allowed = supportedAudioTypes[contentType];
    if (!allowed || !allowed.extensions.includes(ext)) {
      throw new AudioIngestionError(400, "unsupported_file_type", "only MP3 audio/mpeg uploads with .mp3 extension are currently supported");
    }
  }

  responseFromRecord(record: AudioIngestionRecord, duplicate = false): AudioIngestionResponse {
    return {
      ingestion_id: record.id,
      status: record.status,
      duplicate: duplicate || undefined,
      metadata: record.metadata,
      file: record.file ? {
        filename: record.file.originalName,
        content_type: record.file.mimeType,
        size_bytes: record.file.sizeBytes,
        sha256: record.file.sha256
      } : undefined,
      transcription: record.transcription ? {
        status: record.transcription.status,
        text: record.transcription.text,
        error: record.transcription.error
      } : undefined
    };
  }
}

export function sanitizeAudioIngestMetadata(fields: Record<string, string>): AudioIngestMetadata {
  const metadata: AudioIngestMetadata = {};
  for (const key of ["source", "device", "title", "recorded_at", "client_request_id", "notes", "prompt"] as const) {
    const value = fields[key]?.trim();
    if (value) metadata[key] = value.slice(0, key === "notes" || key === "prompt" ? 10_000 : 512);
  }
  return metadata;
}

export function normalizedContentType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

export function audioIngestStoragePath(root: string, ingestionId: string, filename: string | undefined, contentType: string | undefined): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const ext = chooseAudioExtension(filename, contentType);
  return join(root, "audio-ingest", yyyy, mm, dd, ingestionId, `original${ext}`);
}

export function chooseAudioExtension(filename: string | undefined, contentType: string | undefined): string {
  const safeExt = extname(basename(filename ?? "")).toLowerCase();
  const normalized = normalizedContentType(contentType);
  const allowed = supportedAudioTypes[normalized];
  if (allowed?.extensions.includes(safeExt)) return safeExt;
  return allowed?.canonicalExtension ?? ".bin";
}

export function audioIngestFileMetadata(input: {
  ingestionId: string;
  localPath: string;
  buffer: Buffer;
  mimeType?: string;
  originalName?: string;
  keyIdentity: string;
  metadata: AudioIngestMetadata;
}): Attachment & { ingestionId: string } {
  return {
    kind: "audio",
    localPath: input.localPath,
    mimeType: normalizedContentType(input.mimeType),
    originalName: safeFilename(input.originalName),
    sizeBytes: input.buffer.length,
    sha256: sha256Buffer(input.buffer),
    ingestionId: input.ingestionId
  };
}

export function safeFilename(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const name = basename(value).replace(/[\r\n\t]/g, " ").trim();
  return name ? name.slice(0, 255) : undefined;
}
