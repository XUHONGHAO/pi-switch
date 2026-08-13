/**
 * OpenAI-compatible provider support (Phase 1 + 2)
 *
 * Phase 1: provider type detection + api key resolution.
 * Phase 2: model discovery via GET {baseUrl}/models, env interpolation,
 *          static/discovered model merging, model definition mapping.
 * Phase 3: model alias registration reuses `buildModelDefinition`.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";
import type { ModelAliasConfig, ModelDefaults, ModelProviderBinding, ProviderConfig } from "../config/loader";

/** Provider types routed through the OpenAI-compatible API. */
const OPENAI_COMPATIBLE_TYPES = new Set([
  "openai",
  "openai-compatible",
  "openrouter",
  "sub2api",
  "deepseek",
  "ollama",
  "vllm",
  "azure",
]);

/** Default metadata for models discovered via GET /models. */
export const DEFAULT_MODEL_META: Required<ModelDefaults> = {
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 16384,
};

/** Whether a provider type speaks the OpenAI-compatible protocol. */
export function isOpenAICompatible(type: string): boolean {
  if (!type) return false;
  const lower = type.toLowerCase();
  return OPENAI_COMPATIBLE_TYPES.has(lower) || lower.startsWith("openai");
}

/** pi `api` identifier used when registering an OpenAI-compatible provider. */
export function apiForType(type: string): Api {
  if (isOpenAICompatible(type)) return "openai-completions";
  if (type === "anthropic") return "anthropic-messages";
  if (type === "gemini" || type === "google") return "google-generative-ai";
  return type;
}

/**
 * Resolve the apiKey for a provider.
 *
 * Priority:
 *   1. explicit `apiKey` in providers.json
 *   2. `$<NAME>_API_KEY` env convention, e.g. `openai_official` -> `$OPENAI_OFFICIAL_API_KEY`
 *
 * Returns undefined for non-OpenAI providers without an explicit key (they
 * can still be authed later via /login or `--api-key`).
 */
export function resolveApiKey(provider: ProviderConfig, providerName: string): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  if (isOpenAICompatible(provider.type)) {
    return `$${providerName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  }
  return undefined;
}

/**
 * Resolve environment interpolation in apiKey strings, matching pi semantics:
 *   `$VAR` / `${VAR}` -> env value (empty when unset)
 *   `$$` -> literal `$`, `$!` -> literal `!`
 *   anything else is kept verbatim
 */
export function resolveEnvRef(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === "$") {
      out += "$";
      i += 2;
    } else if (next === "!") {
      out += "!";
      i += 2;
    } else if (next === "{") {
      const end = raw.indexOf("}", i);
      if (end === -1) {
        out += raw.slice(i);
        break;
      }
      out += process.env[raw.slice(i + 2, end)] ?? "";
      i = end + 1;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1));
      if (match) {
        out += process.env[match[0]] ?? "";
        i += 1 + match[0].length;
      } else {
        out += "$";
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Effective api key for outbound discovery requests: prefer the resolved
 * credential pi passes into refreshModels, fall back to resolving the
 * configured key ourselves.
 */
export function resolveCredentialKey(
  credential: { type?: string; key?: string } | undefined,
  configuredApiKey: string | undefined,
): string | undefined {
  if (credential && typeof credential.key === "string" && credential.key) return credential.key;
  return resolveEnvRef(configuredApiKey);
}

/** Models endpoint for an OpenAI-compatible baseUrl. */
export function modelsEndpoint(baseUrl: string): string {
  return baseUrl.endsWith("/") ? `${baseUrl}models` : `${baseUrl}/models`;
}

/** Build a pi ProviderModelConfig from raw discovery data + defaults. */
export function buildDiscoveredModel(id: string, defaults: ModelDefaults = {}): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: defaults.reasoning ?? DEFAULT_MODEL_META.reasoning,
    input: defaults.input ?? DEFAULT_MODEL_META.input,
    cost: defaults.cost ?? DEFAULT_MODEL_META.cost,
    contextWindow: defaults.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
    maxTokens: defaults.maxTokens ?? DEFAULT_MODEL_META.maxTokens,
  };
}

/**
 * Build a pi ProviderModelConfig from a model alias binding (Phase 3).
 * `name` comes from the alias display name when available.
 */
export function buildModelDefinition(
  aliasName: string,
  alias: ModelAliasConfig,
  _binding: ModelProviderBinding,
): ProviderModelConfig {
  return {
    id: _binding.model,
    name: alias.displayName ?? aliasName,
    ...(_binding.api ? { api: _binding.api } : {}),
    reasoning: alias.reasoning ?? DEFAULT_MODEL_META.reasoning,
    input: alias.input ?? DEFAULT_MODEL_META.input,
    cost: DEFAULT_MODEL_META.cost,
    contextWindow: alias.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
    maxTokens: alias.maxTokens ?? DEFAULT_MODEL_META.maxTokens,
    ...(_binding.thinkingLevelMap ? { thinkingLevelMap: _binding.thinkingLevelMap } : {}),
    ...(_binding.compat ? { compat: _binding.compat } : {}),
  };
}

/**
 * Merge static and discovered models, deduped by id.
 * Static definitions win on id conflicts.
 */
export function mergeModels(staticModels: ProviderModelConfig[], discovered: ProviderModelConfig[]): ProviderModelConfig[] {
  const byId = new Map<string, ProviderModelConfig>();
  for (const m of staticModels) byId.set(m.id, m);
  for (const m of discovered) if (!byId.has(m.id)) byId.set(m.id, m);
  return [...byId.values()];
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/** Filter discovered models with simple `*` / `?` glob patterns. */
export function filterModels(
  models: ProviderModelConfig[],
  include: string[] = [],
  exclude: string[] = [],
): ProviderModelConfig[] {
  const includes = include.filter(Boolean).map(globRegex);
  const excludes = exclude.filter(Boolean).map(globRegex);
  return models.filter((model) => {
    if (includes.length > 0 && !includes.some((pattern) => pattern.test(model.id))) return false;
    return !excludes.some((pattern) => pattern.test(model.id));
  });
}

/**
 * Discover models from GET {baseUrl}/models (OpenAI-compatible).
 * Throws on non-OK responses or malformed payloads; callers decide how to degrade.
 */
export async function discoverOpenAIModels(
  baseUrl: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  defaults: ModelDefaults = {},
  include: string[] = [],
  exclude: string[] = [],
): Promise<ProviderModelConfig[]> {
  const endpoint = modelsEndpoint(baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(endpoint, { headers, signal });
  if (!response.ok) {
    throw new Error(`GET ${endpoint} failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; owned_by?: string }>;
  };
  if (!Array.isArray(payload.data)) {
    throw new Error(`GET ${endpoint} returned no data array`);
  }
  const models = payload.data
    .filter((m) => Boolean(m.id))
    .map((m) => buildDiscoveredModel(m.id as string, defaults));
  return filterModels(models, include, exclude);
}
