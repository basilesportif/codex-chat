export type BackendLimitErrorKind = "usage-limit" | "rate-limit" | "auth";

export function classifyBackendLimitError(text: string): BackendLimitErrorKind | null {
  const normalized = text.toLowerCase();
  if (/authentication_error|invalid_api_key|\bexpired\b/.test(normalized)) return "auth";
  if (/rate[_ -]?limit|\b429\b|too many requests|overloaded/.test(normalized)) return "rate-limit";
  if (/usagelimitexceeded|usage limit|limit reached|insufficient_quota|\bquota\b/.test(normalized)) return "usage-limit";
  return null;
}
