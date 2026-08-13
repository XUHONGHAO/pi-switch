/**
 * Model Alias System (Phase 3)
 *
 * Resolves a unified alias (e.g. "gpt5") to concrete provider/model
 * bindings from models.json:
 *
 *   gpt5 -> [{ provider: "sub2api", model: "gpt-5" },
 *             { provider: "openai_official", model: "gpt-5" }]
 *
 * Bindings whose provider is missing, disabled, or misconfigured are
 * skipped with a warning so one broken binding never breaks the alias.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelAliasConfig } from "../config/loader";
import type { ConfigStore } from "../config/store";
import { resolveEnvRef, resolveApiKey } from "../provider/openai";
import { inferApi, isSupportedApi, type SupportedApi } from "../provider/transport";

/** A resolved binding with provider metadata needed for routing/streaming. */
export interface ResolvedBinding {
  /** Stable binding-level identity used by health and attempt statistics. */
  lineId: string;
  /** Provider key (must exist in providers.json). */
  provider: string;
  /** Actual model id sent to that provider. */
  model: string;
  /** Provider display label. */
  providerLabel: string;
  /** pi provider id whose credentials/OAuth should be used. */
  authProvider: string;
  /** Provider protocol type. */
  type: string;
  /** Effective pi-ai transport. */
  api: SupportedApi;
  /** Provider endpoint base URL. */
  baseUrl: string;
  /** Resolved API key (env interpolation applied), if any. */
  apiKey?: string;
  /** Provider/binding custom headers, if any. */
  headers?: Record<string, string>;
  /** Binding-level compatibility and thinking controls. */
  compat?: Model<Api>["compat"];
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  /** Routing priority (lower = preferred). */
  priority?: number;
  /** Account key name when routed through an accounts.json key pool. */
  accountName?: string;
  /** Account priority for ordering within a binding. */
  accountPriority?: number;
}

export class ModelResolver {
  constructor(private readonly store: ConfigStore) {}

  /** Alias -> concrete provider/model bindings (in declaration order). */
  resolve(alias: string): ResolvedBinding[] {
    const config = this.store.get();
    const aliasCfg = config.models[alias];
    if (!aliasCfg) return [];

    const bindings: ResolvedBinding[] = [];
    for (const binding of aliasCfg.providers ?? []) {
      const provider = config.providers[binding.provider];
      if (!provider) {
        console.warn(`[pi-switch] alias "${alias}": provider "${binding.provider}" not in providers.json, skipping`);
        continue;
      }
      if (provider.enabled === false) {
        console.warn(`[pi-switch] alias "${alias}": provider "${binding.provider}" is disabled, skipping`);
        continue;
      }
      if (!provider.baseUrl) {
        console.warn(`[pi-switch] alias "${alias}": provider "${binding.provider}" has no baseUrl, skipping`);
        continue;
      }
      const api = inferApi(provider.type, binding.api ?? provider.api);
      if (!isSupportedApi(api)) {
        console.warn(`[pi-switch] alias "${alias}": unsupported api "${api}", skipping`);
        continue;
      }
      const resolvedKey = provider.apiKey
        ? resolveEnvRef(provider.apiKey)
        : resolveEnvRef(resolveApiKey(provider, binding.provider));
      const effectiveBaseUrl = binding.baseUrl ?? provider.baseUrl;
      bindings.push({
        lineId: binding.id?.trim() || `${binding.provider}|${api}|${effectiveBaseUrl}|${binding.model}`,
        provider: binding.provider,
        model: binding.model,
        providerLabel: provider.name ?? binding.provider,
        authProvider: binding.authProvider ?? provider.authProvider ?? binding.provider,
        type: provider.type,
        api,
        baseUrl: effectiveBaseUrl,
        ...(binding.priority !== undefined ? { priority: binding.priority } : {}),
        ...(resolvedKey ? { apiKey: resolvedKey } : {}),
        ...((provider.headers || binding.headers) ? { headers: { ...(provider.headers ?? {}), ...(binding.headers ?? {}) } } : {}),
        ...(binding.compat ?? provider.compat ? { compat: { ...(provider.compat ?? {}), ...(binding.compat ?? {}) } as never } : {}),
        ...(binding.thinkingLevelMap ? { thinkingLevelMap: binding.thinkingLevelMap } : {}),
      });
    }
    return bindings;
  }

  /** Alias configuration, if defined. */
  get(alias: string): ModelAliasConfig | undefined {
    return this.store.get().models[alias];
  }

  /** All known aliases. */
  listAliases(): string[] {
    return Object.keys(this.store.get().models);
  }

  /** Full alias map (for pickers / status). */
  listConfig(): Record<string, ModelAliasConfig> {
    return this.store.get().models;
  }
}
