import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface IngestApiKey {
  identity: string;
  hash: string;
}

export interface IngestAuthResult {
  authorized: boolean;
  identity?: string;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseIngestApiKeys(raw: string | undefined): IngestApiKey[] {
  const entries = (raw ?? "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const keys: IngestApiKey[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = entry.match(/^([A-Za-z0-9_.-]{1,64}):(.*)$/s);
    const label = match ? match[1] : undefined;
    const key = (match ? match[2] : entry).trim();
    if (!key) continue;
    const hash = sha256Hex(key);
    if (seen.has(hash)) continue;
    seen.add(hash);
    keys.push({
      identity: label ?? `sha256:${hash.slice(0, 12)}`,
      hash
    });
  }
  return keys;
}

export function extractIngestKeyCandidates(request: Pick<IncomingMessage, "headers">): string[] {
  const candidates: string[] = [];
  const authHeader = firstHeaderValue(request.headers.authorization);
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) candidates.push(bearer);
  const ingestHeader = firstHeaderValue(request.headers["x-codexchat-ingest-key"]);
  if (ingestHeader?.trim()) candidates.push(ingestHeader.trim());
  return candidates;
}

export function authenticateIngestRequest(
  request: Pick<IncomingMessage, "headers">,
  expectedKeys: readonly IngestApiKey[]
): IngestAuthResult {
  if (expectedKeys.length === 0) return { authorized: false };
  const candidates = extractIngestKeyCandidates(request);
  for (const candidate of candidates) {
    const providedHash = Buffer.from(sha256Hex(candidate), "hex");
    for (const expected of expectedKeys) {
      const expectedHash = Buffer.from(expected.hash, "hex");
      if (providedHash.length === expectedHash.length && timingSafeEqual(providedHash, expectedHash)) {
        return { authorized: true, identity: expected.identity };
      }
    }
  }
  return { authorized: false };
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}
