/**
 * pi-switch config loader (Phase 1)
 *
 * Loads all pi-switch configuration files from the config directory:
 *
 *   ~/.pi-switch/
 *   ├── providers.json
 *   ├── accounts.json
 *   ├── models.json
 *   ├── routing.json
 *   └── stats.json
 *
 * The directory defaults to `~/.pi-switch` and can be overridden with the
 * `PI_SWITCH_CONFIG_DIR` environment variable (useful for tests / dev).
 *
 * Phase 1 consumes `providers.json` via the ProviderManager. The remaining
 * files are loaded now so later phases (2-7) consume them without
 * restructuring.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { join } from "node:path";

/** Config directory name inside the user's home directory. */
export const DEFAULT_CONFIG_DIR_NAME = ".pi-switch";

/** Protocol type of a provider. "openai" enables the OpenAI-compatible path. */
export type ProviderType = "openai" | "anthropic" | "gemini" | "azure" | (string & {});

/** Per-million-token cost rates. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A static model definition in providers.json (OpenAI-compatible path). */
export interface ConfiguredModel {
  /** Model id sent to the API. */
  id: string;
  /** Protocol override for this model. */
  api?: Api;
  /** Display name. Defaults to id. */
  name?: string;
  /** Whether the model supports extended thinking. */
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  compat?: Model<Api>["compat"];
}

/** Default metadata applied to discovered / configured models. */
export interface ModelDefaults {
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: ModelCost;
  contextWindow?: number;
  maxTokens?: number;
}

/** A single provider entry from providers.json. */
export interface ProviderConfig {
  /** Display name shown in UI. Defaults to the provider key. */
  name?: string;
  /** Legacy protocol type; used to infer api when api is omitted. */
  type: ProviderType;
  /** pi-ai protocol adapter. */
  api?: Api;
  /** Provider-level compatibility defaults. */
  compat?: Model<Api>["compat"];
  /** Add Authorization: Bearer for custom APIs. */
  authHeader?: boolean;
  /** Delegate credentials/OAuth resolution to this pi provider id. */
  authProvider?: string;
  /** API endpoint base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Whether this provider is usable. Defaults to true. */
  enabled?: boolean;
  /** API key literal or env reference ($ENV_VAR / ${ENV_VAR}). */
  apiKey?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Static model definitions. Always registered regardless of discovery.
   * (Phase 2: OpenAI-compatible providers; Phase 3 also attaches alias models.)
   */
  models?: ConfiguredModel[];
  /**
   * Discover models via GET {baseUrl}/models at startup.
   * Defaults to true for OpenAI-compatible providers.
   */
  discoverModels?: boolean;
  /** Default metadata applied to discovered / configured models. */
  modelDefaults?: ModelDefaults;
  /** Glob patterns included during remote model discovery. Empty means all. */
  modelInclude?: string[];
  /** Glob patterns excluded during remote model discovery. */
  modelExclude?: string[];
}

/** A single account (API key) entry from accounts.json. */
export interface AccountConfig {
  /** Provider key this account belongs to (must exist in providers.json). */
  provider: string;
  /** API key literal or env reference. */
  apiKey: string;
  /** Routing priority (lower = preferred). */
  priority?: number;
  /** Whether this account is usable. Defaults to true. */
  enabled?: boolean;
  /** Usage statistics (requests, failures, latency; Phase 7 writes). */
  stats?: Record<string, unknown>;
}

/** Provider/model binding inside a model alias. */
export interface ModelProviderBinding {
  /** Optional stable line id used by circuit breakers and attempt statistics. */
  id?: string;
  /** Provider key (must exist in providers.json). */
  provider: string;
  /** Actual model id sent to that provider. */
  model: string;
  /** Binding-level protocol override. */
  api?: Api;
  /** Binding-level credential/OAuth delegation override. */
  authProvider?: string;
  /** Binding-level endpoint and header overrides. */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Binding-level compatibility and thinking controls. */
  compat?: Model<Api>["compat"];
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** Routing priority (lower = preferred). Defaults to declaration order. */
  priority?: number;
}

/** A model alias entry from models.json, e.g. "gpt5". */
export interface ModelAliasConfig {
  /** Human-readable label, e.g. "GPT-5". */
  displayName?: string;
  /** Provider/model bindings for this alias. */
  providers?: ModelProviderBinding[];
  /** Routing strategy override for this alias. */
  strategy?: RoutingStrategy;
  /** Whether the model supports extended thinking. */
  reasoning?: boolean;
  /** Accepted input modalities (text / image). Defaults to text-only. */
  input?: ("text" | "image")[];
  /** Context window size in tokens. */
  contextWindow?: number;
  /** Maximum output tokens. */
  maxTokens?: number;
}

/** Routing strategies supported by routing.json. */
export type RoutingStrategy = "priority" | "failover" | "balance";

/** Balance scope: per-session (sticky) or per-request (round-robin). */
export type BalanceScope = "session" | "request";
export type FailureCostPolicy = "availability" | "balanced" | "economy";

/** Routing configuration from routing.json. */
export interface RoutingConfig {
  /** Default routing strategy. */
  strategy?: RoutingStrategy;
  /**
   * Balance scope: "session" (default) assigns one binding per session and sticks to it,
   * optimizing cache hit rates; "request" rotates per-request (legacy behavior).
   */
  balanceScope?: BalanceScope;
  failureCostPolicy?: FailureCostPolicy;
  maxAttempts?: number;
  maxHighCostFailovers?: number;
  failoverOnUnknown?: boolean;
  /** Consecutive transient failures before opening a circuit. */
  failureThreshold?: number;
  /** Circuit cooldown after transient failures. */
  cooldownMs?: number;
  /** Default cooldown for HTTP 429 when Retry-After is unavailable. */
  rateLimitCooldownMs?: number;
}

/** Fully loaded pi-switch configuration. */
export interface PiSwitchConfig {
  /** Absolute path to the config directory. */
  configDir: string;
  providers: Record<string, ProviderConfig>;
  accounts: Record<string, AccountConfig>;
  models: Record<string, ModelAliasConfig>;
  routing: RoutingConfig;
  stats: Record<string, unknown>;
}

/** Resolve the pi-switch config directory. */
export function resolveConfigDir(): string {
  const override = process.env.PI_SWITCH_CONFIG_DIR;
  return override ? join(override) : join(homedir(), DEFAULT_CONFIG_DIR_NAME);
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, "utf-8");
    if (!raw.trim()) return fallback;
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      console.error(
        `[pi-switch] ${file}: expected a JSON object, got ${Array.isArray(value) ? "array" : typeof value}`,
      );
      return fallback;
    }
    return value as T;
  } catch (err) {
    console.error(`[pi-switch] Failed to load ${file}: ${(err as Error).message}`);
    return fallback;
  }
}

/**
 * Load the full pi-switch configuration.
 * Creates the config directory when it does not exist.
 * Missing or malformed files fall back to their defaults.
 */
export function loadConfig(configDir?: string): PiSwitchConfig {
  const dir = configDir ?? resolveConfigDir();
  mkdirSync(dir, { recursive: true });

  return {
    configDir: dir,
    providers: readJsonFile<Record<string, ProviderConfig>>(join(dir, "providers.json"), {}),
    accounts: readJsonFile<Record<string, AccountConfig>>(join(dir, "accounts.json"), {}),
    models: readJsonFile<Record<string, ModelAliasConfig>>(join(dir, "models.json"), {}),
    routing: readJsonFile<RoutingConfig>(join(dir, "routing.json"), {}),
    stats: readJsonFile<Record<string, unknown>>(join(dir, "stats.json"), {}),
  };
}
