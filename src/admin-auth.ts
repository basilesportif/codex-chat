import { createClerkClient, verifyToken } from "@clerk/backend";
import type { IncomingMessage } from "node:http";

export interface AdminAuthConfig {
  clerkPublishableKey?: string;
  clerkSecretKey?: string;
  clerkSignInUrl?: string;
  clerkAllowedEmails?: string;
}

export interface AuthorizedAdmin {
  userId: string;
  email: string;
}

export type AdminAuthResult =
  | { ok: true; admin: AuthorizedAdmin }
  | { ok: false; statusCode: 401 | 403 | 503; error: "unauthorized" | "forbidden" | "admin_auth_not_configured" | "admin_allowlist_empty" };

export type VerifyClerkToken = typeof verifyToken;
export type ClerkUserLookup = (userId: string) => Promise<unknown>;

export function normalizeAdminEmail(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function parseAdminAllowedEmails(rawValue: string | undefined): Set<string> {
  return new Set(
    String(rawValue ?? "")
      .split(/[\s,]+/)
      .map((value) => normalizeAdminEmail(value))
      .filter(Boolean)
  );
}

export function hasAdminAuthKeys(config: AdminAuthConfig): boolean {
  return Boolean(String(config.clerkPublishableKey ?? "").trim() && String(config.clerkSecretKey ?? "").trim());
}

export function isAdminAuthConfigured(config: AdminAuthConfig): boolean {
  return hasAdminAuthKeys(config) && parseAdminAllowedEmails(config.clerkAllowedEmails).size > 0;
}

export function bearerTokenFromRequest(request: IncomingMessage): string | undefined {
  const header = Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : request.headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim() || sessionCookieFromRequest(request) || undefined;
}

function sessionCookieFromRequest(request: IncomingMessage): string | undefined {
  const cookieHeader = Array.isArray(request.headers.cookie) ? request.headers.cookie.join("; ") : request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== "__session") continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export function readClerkPrimaryEmail(user: unknown): string {
  if (!user || typeof user !== "object") return "";
  const record = user as Record<string, unknown>;
  const emailAddresses = Array.isArray(record.emailAddresses) ? record.emailAddresses : [];
  const primaryEmailAddressId = String(record.primaryEmailAddressId ?? "");
  const primary = emailAddresses.find((candidate) => {
    return Boolean(candidate && typeof candidate === "object" && String((candidate as Record<string, unknown>).id ?? "") === primaryEmailAddressId);
  });
  const fallback = primary ?? emailAddresses[0] ?? record.primaryEmailAddress;
  if (!fallback || typeof fallback !== "object") return "";
  return normalizeAdminEmail(String((fallback as Record<string, unknown>).emailAddress ?? ""));
}

export async function authorizeAdminRequest(
  request: IncomingMessage,
  config: AdminAuthConfig,
  deps: {
    verifyTokenImpl?: VerifyClerkToken;
    getUser?: ClerkUserLookup;
  } = {}
): Promise<AdminAuthResult> {
  const allowedEmails = parseAdminAllowedEmails(config.clerkAllowedEmails);
  if (!hasAdminAuthKeys(config)) return { ok: false, statusCode: 503, error: "admin_auth_not_configured" };
  if (allowedEmails.size === 0) return { ok: false, statusCode: 403, error: "admin_allowlist_empty" };

  const token = bearerTokenFromRequest(request);
  if (!token) return { ok: false, statusCode: 401, error: "unauthorized" };

  let userId = "";
  try {
    const verified = await (deps.verifyTokenImpl ?? verifyToken)(token, { secretKey: config.clerkSecretKey });
    userId = String(verified.sub ?? "");
  } catch {
    return { ok: false, statusCode: 401, error: "unauthorized" };
  }
  if (!userId) return { ok: false, statusCode: 401, error: "unauthorized" };

  let user: unknown;
  try {
    if (deps.getUser) user = await deps.getUser(userId);
    else user = await createClerkClient({ secretKey: config.clerkSecretKey }).users.getUser(userId);
  } catch {
    return { ok: false, statusCode: 401, error: "unauthorized" };
  }

  const email = readClerkPrimaryEmail(user);
  if (!email) return { ok: false, statusCode: 401, error: "unauthorized" };
  if (!allowedEmails.has(email)) return { ok: false, statusCode: 403, error: "forbidden" };
  return { ok: true, admin: { userId, email } };
}
