/** Error categories used to decide whether a content-free request may fail over. */
export type ErrorCategory =
  | "aborted"
  | "context-overflow"
  | "auth"
  | "rate-limit"
  | "invalid-request"
  | "timeout"
  | "network"
  | "server"
  | "unknown";

export interface UpstreamFailure {
  status?: number;
  headers?: Record<string, string>;
}

function headersRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (value instanceof Headers) return Object.fromEntries(value.entries());
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" || typeof item === "number") result[key.toLowerCase()] = String(item);
  }
  return Object.keys(result).length ? result : undefined;
}

/** Extract status/headers exposed by common provider SDK error objects. */
export function extractUpstreamFailure(error: unknown, fallback?: UpstreamFailure): UpstreamFailure | undefined {
  if (!error || typeof error !== "object") return fallback;
  const value = error as Record<string, unknown>;
  const response = value.response && typeof value.response === "object"
    ? value.response as Record<string, unknown>
    : undefined;
  const statusValue = value.status ?? value.statusCode ?? response?.status;
  const status = typeof statusValue === "number" ? statusValue
    : typeof statusValue === "string" && /^\d{3}$/.test(statusValue) ? Number(statusValue)
    : fallback?.status;
  const headers = headersRecord(value.headers ?? response?.headers) ?? fallback?.headers;
  return status !== undefined || headers !== undefined ? { status, headers } : fallback;
}

/** Classify an upstream error, preferring structured HTTP status metadata. */
export function classifyError(message: string, aborted = false, failure?: UpstreamFailure): ErrorCategory {
  if (aborted) return "aborted";
  const status = failure?.status;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 408 || status === 504) return "timeout";
  if (status !== undefined && status >= 500) return "server";
  if (status !== undefined && status >= 400) return "invalid-request";

  const value = message.toLowerCase();
  if (/\babort(?:ed)?\b|cancelled|canceled/.test(value)) return "aborted";
  if (/context[_ -]?length|context window|maximum context|too many tokens|prompt is too long/.test(value)) {
    return "context-overflow";
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(value)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|quota exceeded/.test(value)) return "rate-limit";
  if (/\b408\b|\b504\b|timed? ?out|timeout/.test(value)) return "timeout";
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway error/.test(value)) return "server";
  if (/\b400\b|\b404\b|\b405\b|\b409\b|\b422\b|bad request|invalid (request|parameter|argument)/.test(value)) {
    return "invalid-request";
  }
  if (/\beconn|\benet|\behost|\beai_again|fetch failed|network|socket|dns|connection (?:reset|refused)/.test(value)) {
    return "network";
  }
  return "unknown";
}

/** Whether another configured line may help for this content-free failure. */
export function canFailoverFor(category: ErrorCategory): boolean {
  return category !== "aborted" && category !== "context-overflow" && category !== "invalid-request";
}
