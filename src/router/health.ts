import type { ErrorCategory } from "../errors/classify";
import type { ResolvedBinding } from "../model/resolver";

export interface HealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  rateLimitCooldownMs?: number;
}

export interface LineHealth {
  key: string;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  openUntil?: number;
  lastCategory?: ErrorCategory;
  lastError?: string;
  lastAttemptAt?: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_RATE_LIMIT_MS = 60_000;

export function lineKey(binding: Pick<ResolvedBinding, "lineId" | "accountName">): string {
  return binding.accountName ? `${binding.lineId}|account:${binding.accountName}` : binding.lineId;
}

/** In-process line health and circuit-breaker state. */
export class HealthManager {
  private readonly lines = new Map<string, LineHealth>();

  constructor(private readonly options: HealthOptions = {}) {}

  state(binding: Pick<ResolvedBinding, "lineId" | "accountName">): LineHealth {
    const key = lineKey(binding);
    let state = this.lines.get(key);
    if (!state) {
      state = { key, consecutiveFailures: 0, successes: 0, failures: 0 };
      this.lines.set(key, state);
    }
    return state;
  }

  /** Return candidates whose circuit is closed or whose cooldown has expired. */
  available(candidates: ResolvedBinding[], now = Date.now()): ResolvedBinding[] {
    return candidates.filter((candidate) => (this.state(candidate).openUntil ?? 0) <= now);
  }

  recordSuccess(binding: ResolvedBinding): void {
    const state = this.state(binding);
    state.successes += 1;
    state.consecutiveFailures = 0;
    state.openUntil = undefined;
    state.lastError = undefined;
    state.lastAttemptAt = Date.now();
  }

  recordFailure(
    binding: ResolvedBinding,
    category: ErrorCategory,
    error: string,
    retryAfterMs?: number,
  ): void {
    const state = this.state(binding);
    const now = Date.now();
    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastCategory = category;
    state.lastError = error;
    state.lastAttemptAt = now;

    if (category === "rate-limit") {
      state.openUntil = now + (retryAfterMs ?? this.options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_MS);
      return;
    }
    if (category === "auth") {
      state.openUntil = now + Math.max(this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS, 5 * 60_000);
      return;
    }
    if (
      (category === "network" || category === "timeout" || category === "server" || category === "unknown") &&
      state.consecutiveFailures >= (this.options.failureThreshold ?? DEFAULT_THRESHOLD)
    ) {
      state.openUntil = now + (this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    }
  }

  list(): LineHealth[] {
    return [...this.lines.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  summary(now = Date.now()): { total: number; open: number } {
    const values = this.list();
    return { total: values.length, open: values.filter((state) => (state.openUntil ?? 0) > now).length };
  }
}

export function parseRetryAfterHeader(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Best-effort fallback extraction from common upstream error messages. */
export function parseRetryAfterMs(message: string): number | undefined {
  const milliseconds = /retry[- ]after\s*[:=]?\s*(\d+)\s*ms/i.exec(message);
  if (milliseconds) return Math.max(0, Number(milliseconds[1]));
  const seconds = /retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|seconds?)?\b/i.exec(message);
  return seconds ? Math.max(0, Math.round(Number(seconds[1]) * 1000)) : undefined;
}
