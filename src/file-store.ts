import { extname, join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { AppConfig, resolveConfigPath } from "./config.js";
import { StateStore } from "./state.js";
import { Attachment } from "./types.js";
import { atomicWriteText, ensureDir, fileSize, isInsidePath, nowIso, sha256Buffer } from "./util.js";

const mimeExtensions: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/opus": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
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

  async writeArtifact(rel: string, content: string): Promise<string> {
    const destination = join(this.artifactRoot, rel);
    await atomicWriteText(destination, content);
    return destination;
  }

  validateSendPath(path: string): string {
    const resolved = resolve(path);
    if (!this.allowedSendRoots.some((root) => isInsidePath(resolved, root))) {
      throw new Error(`Refusing to send path outside allowed roots: ${path}`);
    }
    return resolved;
  }

  async fileInfo(path: string): Promise<{ path: string; sizeBytes: number }> {
    const resolved = this.validateSendPath(path);
    return { path: resolved, sizeBytes: await fileSize(resolved) };
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
