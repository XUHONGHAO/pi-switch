/** Request and upstream-attempt statistics with multi-process-safe persistence. */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ErrorCategory } from "../errors/classify";
import { replaceFile } from "../utils/atomic-file";

export interface LineStats {
  requests: number;
  successes: number;
  failures: number;
  failovers: number;
  totalLatencyMs: number;
  lastLatencyMs?: number;
  lastRequestAt?: number;
  lastError?: string;
}

export interface AttemptStats {
  attempts: number;
  successes: number;
  failures: number;
  totalTtftMs: number;
  ttftSamples: number;
  totalDurationMs: number;
  lastAttemptAt?: number;
  lastError?: string;
  lastCategory?: ErrorCategory;
}

export interface StatsData {
  byAlias: Record<string, LineStats>;
  byProvider: Record<string, LineStats>;
  byAccount: Record<string, LineStats>;
  attemptsByLine: Record<string, AttemptStats>;
  updatedAt?: number;
}

export interface RecordEntry {
  alias: string;
  provider: string;
  account?: string;
  success: boolean;
  latencyMs?: number;
  failovers?: number;
  error?: string;
}

export interface AttemptEntry {
  alias: string;
  lineId?: string;
  provider: string;
  account?: string;
  success: boolean;
  ttftMs?: number;
  durationMs: number;
  category?: ErrorCategory;
  error?: string;
}

const FLUSH_DELAY_MS = 2000;
const LOCK_STALE_MS = 10_000;

function emptyLine(): LineStats {
  return { requests: 0, successes: 0, failures: 0, failovers: 0, totalLatencyMs: 0 };
}
function emptyAttempt(): AttemptStats {
  return { attempts: 0, successes: 0, failures: 0, totalTtftMs: 0, ttftSamples: 0, totalDurationMs: 0 };
}
function emptyData(): StatsData {
  return { byAlias: {}, byProvider: {}, byAccount: {}, attemptsByLine: {} };
}
function attemptKey(entry: Pick<AttemptEntry, "lineId" | "provider" | "account">): string {
  const line = entry.lineId ?? entry.provider;
  return entry.account ? `${line}|account:${entry.account}` : line;
}

export class StatsManager {
  private data: StatsData;
  private pending: StatsData = emptyData();
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;

  constructor(private readonly configDir: string) {
    this.data = this.load();
  }

  private statsPath(): string { return join(this.configDir, "stats.json"); }
  private lockPath(): string { return join(this.configDir, "stats.lock"); }

  private load(): StatsData {
    try {
      if (!existsSync(this.statsPath())) return emptyData();
      const raw = JSON.parse(readFileSync(this.statsPath(), "utf-8")) as Partial<StatsData>;
      return {
        byAlias: raw.byAlias ?? {}, byProvider: raw.byProvider ?? {}, byAccount: raw.byAccount ?? {},
        attemptsByLine: raw.attemptsByLine ?? {},
        ...(typeof raw.updatedAt === "number" ? { updatedAt: raw.updatedAt } : {}),
      };
    } catch (err) {
      console.error(`[pi-switch] Failed to load stats: ${(err as Error).message}`);
      return emptyData();
    }
  }

  record(entry: RecordEntry): void {
    const now = Date.now();
    for (const target of [this.data, this.pending]) {
      this.bumpLine(target.byAlias, entry.alias, entry, now);
      this.bumpLine(target.byProvider, entry.provider, entry, now);
      if (entry.account) this.bumpLine(target.byAccount, entry.account, entry, now);
      target.updatedAt = now;
    }
    this.markDirty();
  }

  recordAttempt(entry: AttemptEntry): void {
    const now = Date.now();
    const key = attemptKey(entry);
    for (const target of [this.data, this.pending]) {
      const stats = (target.attemptsByLine[key] ??= emptyAttempt());
      stats.attempts += 1;
      entry.success ? stats.successes += 1 : stats.failures += 1;
      if (entry.ttftMs !== undefined) { stats.totalTtftMs += entry.ttftMs; stats.ttftSamples += 1; }
      stats.totalDurationMs += entry.durationMs;
      stats.lastAttemptAt = now;
      if (entry.error) stats.lastError = entry.error;
      if (entry.category) stats.lastCategory = entry.category;
      target.updatedAt = now;
    }
    this.markDirty();
  }

  private bumpLine(map: Record<string, LineStats>, key: string, entry: RecordEntry, now: number): void {
    const stats = (map[key] ??= emptyLine());
    stats.requests += 1;
    entry.success ? stats.successes += 1 : stats.failures += 1;
    if (!entry.success && entry.error) stats.lastError = entry.error;
    if (entry.latencyMs !== undefined) { stats.totalLatencyMs += entry.latencyMs; stats.lastLatencyMs = entry.latencyMs; }
    stats.failovers += entry.failovers ?? 0;
    stats.lastRequestAt = now;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, FLUSH_DELAY_MS);
  }

  /** Merge this process' delta under a directory lock, then atomically replace stats.json. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) return;
    mkdirSync(this.configDir, { recursive: true });
    if (!this.acquireLock()) {
      console.warn("[pi-switch] stats flush deferred: another process holds the lock");
      this.markDirty();
      return;
    }
    const temp = `${this.statsPath()}.${process.pid}.${Date.now()}.tmp`;
    try {
      const disk = this.load();
      const merged = mergeStats(disk, this.pending);
      writeFileSync(temp, JSON.stringify(merged, null, 2) + "\n");
      replaceFile(temp, this.statsPath());
      this.data = merged;
      this.pending = emptyData();
      this.dirty = false;
    } catch (err) {
      console.error(`[pi-switch] Failed to write stats: ${(err as Error).message}`);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
      rmSync(this.lockPath(), { recursive: true, force: true });
    }
  }

  private acquireLock(): boolean {
    try {
      mkdirSync(this.lockPath());
      writeFileSync(join(this.lockPath(), "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return true;
    } catch {
      try {
        const marker = join(this.lockPath(), "owner.json");
        const createdAt = existsSync(marker)
          ? (JSON.parse(readFileSync(marker, "utf-8")) as { createdAt?: number }).createdAt
          : statSync(this.lockPath()).mtimeMs;
        if (createdAt && Date.now() - createdAt > LOCK_STALE_MS) {
          rmSync(this.lockPath(), { recursive: true, force: true });
        }
        mkdirSync(this.lockPath());
        writeFileSync(join(this.lockPath(), "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        return true;
      } catch { return false; }
    }
  }

  alias(alias: string): LineStats | undefined { return this.data.byAlias[alias]; }
  lineAttempts(line: string): AttemptStats | undefined { return this.data.attemptsByLine[line]; }
  attemptSummary(): Array<{ line: string; stats: AttemptStats }> {
    return Object.entries(this.data.attemptsByLine).map(([line, stats]) => ({ line, stats })).sort((a, b) => b.stats.attempts - a.stats.attempts);
  }
  aliasSummary(): Array<{ alias: string; stats: LineStats }> {
    return Object.entries(this.data.byAlias).map(([alias, stats]) => ({ alias, stats })).sort((a, b) => b.stats.requests - a.stats.requests);
  }
}

function mergeLine(target: Record<string, LineStats>, delta: Record<string, LineStats>): void {
  for (const [key, add] of Object.entries(delta)) {
    const out = (target[key] ??= emptyLine());
    out.requests += add.requests; out.successes += add.successes; out.failures += add.failures;
    out.failovers += add.failovers; out.totalLatencyMs += add.totalLatencyMs;
    if ((add.lastRequestAt ?? 0) >= (out.lastRequestAt ?? 0)) {
      out.lastRequestAt = add.lastRequestAt; out.lastLatencyMs = add.lastLatencyMs; out.lastError = add.lastError;
    }
  }
}
function mergeAttempt(target: Record<string, AttemptStats>, delta: Record<string, AttemptStats>): void {
  for (const [key, add] of Object.entries(delta)) {
    const out = (target[key] ??= emptyAttempt());
    out.attempts += add.attempts; out.successes += add.successes; out.failures += add.failures;
    out.totalTtftMs += add.totalTtftMs; out.ttftSamples += add.ttftSamples; out.totalDurationMs += add.totalDurationMs;
    if ((add.lastAttemptAt ?? 0) >= (out.lastAttemptAt ?? 0)) {
      out.lastAttemptAt = add.lastAttemptAt; out.lastError = add.lastError; out.lastCategory = add.lastCategory;
    }
  }
}
export function mergeStats(base: StatsData, delta: StatsData): StatsData {
  const result: StatsData = JSON.parse(JSON.stringify(base));
  result.byAlias ??= {}; result.byProvider ??= {}; result.byAccount ??= {}; result.attemptsByLine ??= {};
  mergeLine(result.byAlias, delta.byAlias); mergeLine(result.byProvider, delta.byProvider); mergeLine(result.byAccount, delta.byAccount);
  mergeAttempt(result.attemptsByLine, delta.attemptsByLine);
  result.updatedAt = Math.max(base.updatedAt ?? 0, delta.updatedAt ?? 0) || undefined;
  return result;
}

export function formatStats(stats: LineStats | undefined): string {
  if (!stats || stats.requests === 0) return "暂无请求记录";
  const successRate = Math.round((stats.successes / stats.requests) * 100);
  const avgLatency = Math.round(stats.totalLatencyMs / stats.requests);
  return `${stats.requests} 次请求 · 成功率 ${successRate}% · 平均延迟 ${avgLatency}ms${stats.failovers ? ` · ${stats.failovers} 次故障切换` : ""}`;
}
