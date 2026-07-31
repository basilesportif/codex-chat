import { dirname, extname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { AppConfig, resolveConfigPath } from "./config.js";
import { StateStore } from "./state.js";
import { Attachment } from "./types.js";
import { ensureDir, isInsidePath, nowIso, sha256Buffer } from "./util.js";
import { audioIngestFileMetadata, audioIngestStoragePath, type AudioIngestMetadata } from "./audio-ingest.js";

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "application/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mp4": ".m4a",
  "audio/m4a": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt"
};

export class FileStore {
  readonly fileRoot: string;
  readonly artifactRoot: string;
  private allowedSendRoots: string[];

  constructor(
    private readonly config: AppConfig,
    private readonly state: StateStore
  ) {
    this.fileRoot = resolveConfigPath(config, config.files.dir);
    this.artifactRoot = resolveConfigPath(config, config.files.artifactDir);
    this.allowedSendRoots = config.files.allowedSendRoots.map((root) => resolveConfigPath(config, root));
  }

  async init(): Promise<void> {
    await ensureDir(this.fileRoot);
    await ensureDir(this.artifactRoot);
  }

  async storeTelegramFile(input: {
    buffer: Buffer;
    kind: Attachment["kind"];
    telegramFileId: string;
    telegramFileUniqueId: string;
    mimeType?: string;
    originalName?: string;
    receivedFromUserId?: number;
  }): Promise<Attachment> {
    const now = new Date();
    const yyyy = String(now.getUTCFullYear());
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const safeUnique = input.telegramFileUniqueId.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const ext = this.chooseExtension(input.mimeType, input.originalName);
    const dir = join(this.fileRoot, yyyy, mm, dd, safeUnique);
    await ensureDir(dir);
    const localPath = join(dir, `original${ext}`);
    await writeFile(localPath, input.buffer, { mode: 0o600 });
    const sha256 = sha256Buffer(input.buffer);
    const attachment: Attachment = {
      kind: input.kind,
      localPath,
      mimeType: input.mimeType,
      originalName: input.originalName,
      telegramFileId: input.telegramFileId,
      telegramFileUniqueId: input.telegramFileUniqueId,
      sizeBytes: input.buffer.length,
      sha256
    };
    await this.state.saveFileMetadata(safeUnique, {
      ...attachment,
      receivedFromUserId: input.receivedFromUserId,
      storedAt: nowIso()
    });
    return attachment;
  }

  async storeIngestedAudio(input: {
    ingestionId: string;
    buffer: Buffer;
    mimeType?: string;
    originalName?: string;
    keyIdentity: string;
    metadata: AudioIngestMetadata;
  }): Promise<Attachment & { ingestionId: string }> {
    const localPath = audioIngestStoragePath(this.fileRoot, input.ingestionId, input.originalName, input.mimeType);
    await ensureDir(dirname(localPath));
    await writeFile(localPath, input.buffer, { mode: 0o600 });
    const attachment = audioIngestFileMetadata({ ...input, localPath });
    await this.state.saveFileMetadata(input.ingestionId, {
      ...attachment,
      receivedVia: "audio_ingest",
      keyIdentity: input.keyIdentity,
      metadata: input.metadata,
      storedAt: nowIso()
    });
    return attachment;
  }


  validateSendPath(path: string): string {
    const resolved = resolve(path);
    if (!this.allowedSendRoots.some((root) => isInsidePath(resolved, root))) {
      throw new Error(`Refusing to send path outside allowed roots: ${path}`);
    }
    return resolved;
  }


  private chooseExtension(mimeType?: string, originalName?: string): string {
    if (originalName) {
      const ext = extname(originalName);
      if (ext && ext.length <= 16) return ext;
    }
    if (mimeType && mimeExtensions[mimeType]) return mimeExtensions[mimeType];
    return ".bin";
  }
}
