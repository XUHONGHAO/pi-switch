/**
 * Provider Manager (Phase 1 + 2)
 *
 * Registers providers from providers.json into pi's model registry via
 * `pi.registerProvider()`, so they appear in /model, --list-models, and
 * /login.
 *
 * Phase 1: provider *entries* (baseUrl / api / apiKey).
 * Phase 2: OpenAI-compatible providers additionally get
 *   - static `models` from providers.json
 *   - startup model discovery via GET {baseUrl}/models (`discoverModels`)
 *   - a `refreshModels` hook for later manual refreshes
 * Phase 3: model definitions resolved from model aliases are attached here.
 * Phase 6: account-level keys are applied here.
 */

import type { ExtensionAPI, ProviderConfig as PiProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { PiSwitchConfig, ProviderConfig } from "../config/loader";
import { resolveConfigValue } from "../config/secret";
import { ModelCache } from "./model-cache";
import {
  apiForType,
  discoverOpenAIModels,
  filterModels,
  mergeModels,
  resolveApiKey,
  DEFAULT_MODEL_META,
} from "./openai";
import { inferApi, isSupportedApi } from "./transport";

/** Timeout for startup model discovery per provider. */
const DISCOVER_TIMEOUT_MS = 5000;

/** Snapshot of a successfully registered provider. */
export interface RegisteredProvider {
  /** Provider key (id used in pi). */
  name: string;
  /** Display name. */
  label: string;
  /** Protocol type from providers.json. */
  type: string;
  /** Endpoint base URL. */
  baseUrl: string;
  /** pi `api` identifier. */
  api: string;
  /** Number of models registered. */
  modelCount: number;
}

export class ProviderManager {
  private readonly pi: ExtensionAPI;
  private readonly registered = new Map<string, RegisteredProvider>();
  private cache: ModelCache | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Register all enabled providers from the loaded config (concurrently). */
  async registerFromConfig(config: PiSwitchConfig): Promise<RegisteredProvider[]> {
    this.cache = new ModelCache(config.configDir);
    const tasks: Promise<RegisteredProvider | undefined>[] = [];
    for (const [name, provider] of Object.entries(config.providers)) {
      if (provider.enabled === false) {
        console.log(`[pi-switch] provider "${name}" disabled, skipping`);
        continue;
      }
      tasks.push(this.register(name, provider));
    }
    const results = await Promise.all(tasks);
    return results.filter((r): r is RegisteredProvider => r !== undefined);
  }

  /** Register a single provider into pi's model registry. */
  async register(name: string, provider: ProviderConfig): Promise<RegisteredProvider | undefined> {
    if (!provider.baseUrl) {
      console.error(`[pi-switch] provider "${name}" has no baseUrl, skipping`);
      return undefined;
    }
    const api = inferApi(provider.type, provider.api ?? apiForType(provider.type));
    if (!isSupportedApi(api)) {
      console.warn(`[pi-switch] provider "${name}" uses unsupported api "${api}", skipping`);
      return undefined;
    }
    const apiKey = resolveApiKey(provider, name);

    // --- Phase 2: model discovery ------------------------------------------
    const staticModels: ProviderModelConfig[] = (provider.models ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      ...(m.api ? { api: m.api } : {}),
      reasoning: m.reasoning ?? provider.modelDefaults?.reasoning ?? false,
      input: m.input ?? provider.modelDefaults?.input ?? ["text"],
      cost: m.cost ?? provider.modelDefaults?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow ?? provider.modelDefaults?.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
      maxTokens: m.maxTokens ?? provider.modelDefaults?.maxTokens ?? 16384,
      ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
      ...(m.compat ?? provider.compat ? { compat: { ...(provider.compat ?? {}), ...(m.compat ?? {}) } as never } : {}),
    }));

    const cachedModels = filterModels(
      this.cache?.load(name) ?? [],
      provider.modelInclude,
      provider.modelExclude,
    );
    let models = mergeModels(staticModels, cachedModels);
    const discover = provider.discoverModels ?? api === "openai-completions";
    if (discover) {
      try {
        // Same secret syntax as request path / probe: literal, $ENV, $!, !command.
        const key = await resolveConfigValue(apiKey);
        const discovered = await discoverOpenAIModels(
          provider.baseUrl,
          key,
          AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
          provider.modelDefaults,
          provider.modelInclude,
          provider.modelExclude,
        );
        models = mergeModels(staticModels, discovered);
        this.cache?.save(name, discovered);
        if (discovered.length > 0) {
          console.log(`[pi-switch] provider "${name}": discovered ${discovered.length} model(s)`);
        }
      } catch (err) {
        console.warn(
          `[pi-switch] provider "${name}": model discovery failed (${(err as Error).message}), using ${staticModels.length} static model(s)`,
        );
      }
    }

    const config: PiProviderConfig = {
      name: provider.name ?? name,
      baseUrl: provider.baseUrl,
      api,
      ...(apiKey ? { apiKey } : {}),
      ...(provider.authHeader !== undefined ? { authHeader: provider.authHeader } : {}),
      ...(provider.headers && Object.keys(provider.headers).length > 0 ? { headers: provider.headers } : {}),
      models,
    };

    // Phase 2: support later manual refreshes (e.g. /refresh-models).
    // pi calls refreshModels twice per refresh: first offline (cache restore),
    // then online when a credential resolves. Returning the current list keeps
    // models intact during the offline phase; only the online phase re-discovers.
    if (discover) {
      let currentModels = models;
      config.refreshModels = async (context) => {
        if (context.allowNetwork === false) return currentModels;
        // Prefer pi-resolved credential (login/OAuth); otherwise resolve configured secret.
        const credentialKey = context.credential && typeof context.credential.key === "string"
          ? context.credential.key
          : undefined;
        const key = credentialKey || await resolveConfigValue(provider.apiKey ?? apiKey);
        const discovered = await discoverOpenAIModels(
          provider.baseUrl,
          key,
          context.signal,
          provider.modelDefaults,
          provider.modelInclude,
          provider.modelExclude,
        );
        currentModels = mergeModels(staticModels, discovered);
        this.cache?.save(name, discovered);
        return currentModels;
      };
    }

    this.pi.registerProvider(name, config);

    const info: RegisteredProvider = {
      name,
      label: provider.name ?? name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      api,
      modelCount: models.length,
    };
    this.registered.set(name, info);
    return info;
  }

  /** Unregister a provider (used by later phases / teardown). */
  unregister(name: string): void {
    this.pi.unregisterProvider(name);
    this.registered.delete(name);
  }

  /**
   * Re-register everything from a (reloaded) config: unregister all current
   * providers first, then register the new set (used by /config save).
   */
  async reload(config: PiSwitchConfig): Promise<RegisteredProvider[]> {
    for (const name of [...this.registered.keys()]) {
      this.unregister(name);
    }
    return this.registerFromConfig(config);
  }

  /** All currently registered providers. */
  list(): RegisteredProvider[] {
    return [...this.registered.values()];
  }

  /** Look up a registered provider by key. */
  get(name: string): RegisteredProvider | undefined {
    return this.registered.get(name);
  }
}
