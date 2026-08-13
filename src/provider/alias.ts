/**
 * Model alias provider (Phase 3 + 4)
 *
 * Registers a virtual provider `pi-switch` whose models are the aliases from
 * models.json (e.g. "gpt5"). Requests are forwarded at stream time to the
 * concrete provider/model binding chosen by the Router:
 *
 *   pi selects pi-switch/gpt5
 *     -> Router.select("gpt5", ModelResolver.resolve("gpt5"))
 *     -> sub2api / gpt-5 (priority | failover | balance)
 *     -> openai-completions stream to the chosen baseUrl with its key
 *
 * Failover: when a binding fails before producing any content and the
 * strategy allows it, the request transparently retries on the next
 * candidate (failover / balance).
 */

import type { ExtensionAPI, ModelRegistry, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AccountManager } from "../account/manager";
import { resolveConfigValue, resolveHeaderValues } from "../config/secret";
import {
  canFailoverFor,
  classifyError,
  extractUpstreamFailure,
  type ErrorCategory,
  type UpstreamFailure,
} from "../errors/classify";
import type { ConfigStore } from "../config/store";
import { ModelResolver, type ResolvedBinding } from "../model/resolver";
import { HealthManager, parseRetryAfterHeader, parseRetryAfterMs } from "../router/health";
import { Router, type Selection } from "../router/router";
import { StatsManager } from "../stats/manager";
import { DEFAULT_MODEL_META } from "./openai";
import { streamWithTransport } from "./transport";

/** Virtual provider id exposed to pi. */
export const ALIAS_PROVIDER = "pi-switch";

/** Placeholder endpoint; never contacted (streamSimple forwards instead). */
const VIRTUAL_BASE_URL = "http://pi-switch.local/v1";

/** Placeholder key so pi treats the provider as configured. */
const VIRTUAL_API_KEY = "local";

export interface AliasRegistration {
  provider: string;
  modelCount: number;
}

/** Last routed request (for /switch status + turn-level stats). */
export interface RouteInfo {
  /** Alias used (pi model id). */
  alias: string;
  /** Stable binding-level line identity. */
  lineId: string;
  /** Provider key of the chosen line. */
  provider: string;
  /** Account name when routed through the key pool. */
  account?: string;
  /** Real model id sent to the provider. */
  model: string;
  /** Latency in ms to first content event. */
  latency?: number;
  /** Failovers that happened while settling this request. */
  failovers: number;
  /** Whether the line settled with a successful response. */
  ok: boolean;
  /** Turn this route belongs to (see beginTurn). */
  turnId: number;
  /** Completion timestamp. */
  timestamp: number;
}

function buildAliasModel(resolver: ModelResolver, alias: string): ProviderModelConfig {
  const cfg = resolver.get(alias);
  return {
    id: alias,
    name: cfg?.displayName ?? alias,
    reasoning: cfg?.reasoning ?? false,
    // Passthrough modalities so vision aliases are not forced text-only.
    input: cfg?.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg?.contextWindow ?? DEFAULT_MODEL_META.contextWindow,
    maxTokens: cfg?.maxTokens ?? DEFAULT_MODEL_META.maxTokens,
  };
}

function errorMessage(model: Model<Api>, message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export class AliasProvider {
  private resolver: ModelResolver;
  private router: Router;
  private accounts: AccountManager;
  private health: HealthManager;
  private modelRegistry: ModelRegistry | undefined;
  private lastRoute: RouteInfo | undefined;
  private turnId = 0;
  private turnFailovers = 0;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly store: ConfigStore,
    private readonly stats: StatsManager,
  ) {
    this.resolver = new ModelResolver(store);
    this.router = new Router(store);
    this.accounts = new AccountManager(store);
    this.health = new HealthManager(store.get().routing);
  }

  /** Bind pi's runtime registry so routed calls reuse /login, OAuth and !command auth. */
  bindModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /** Rebuild from the current store config and re-register the virtual provider. */
  reload(): AliasRegistration | undefined {
    this.resolver = new ModelResolver(this.store);
    this.router = new Router(this.store);
    this.accounts = new AccountManager(this.store);
    this.health = new HealthManager(this.store.get().routing);
    this.pi.unregisterProvider(ALIAS_PROVIDER);
    return this.register();
  }

  /** Register the virtual provider with one model per alias. */
  register(): AliasRegistration | undefined {
    const aliases = this.resolver.listAliases();
    if (aliases.length === 0) return undefined;

    const models = aliases.map((alias) => buildAliasModel(this.resolver, alias));
    this.pi.registerProvider(ALIAS_PROVIDER, {
      name: "pi-switch",
      baseUrl: VIRTUAL_BASE_URL,
      apiKey: VIRTUAL_API_KEY,
      api: "openai-completions",
      models,
      streamSimple: (model, context, options) => this.route(model, context, options),
    });
    return { provider: ALIAS_PROVIDER, modelCount: models.length };
  }

  /**
   * Route a request for pi-switch/<alias> through the Router, with
   * content-free failure failover where the strategy allows it.
   */
  private route(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const bindings = this.resolver.resolve(model.id);
    if (bindings.length === 0) {
      return this.fail(model, `alias "${model.id}" has no usable provider binding (check models.json / providers.json)`);
    }

    // Phase 6: expand each binding into per-account candidates (key pool).
    const candidates = this.expandCandidates(bindings);
    if (candidates.length === 0) {
      return this.fail(model, `alias "${model.id}": no usable provider line`);
    }

    const available = this.health.available(candidates);
    if (available.length === 0) {
      return this.fail(model, `alias "${model.id}": all provider lines are cooling down (see /switch check)`);
    }
    const selection: Selection = this.router.select(model.id, available);
    const stream = createAssistantMessageEventStream();

    void (async () => {
      // A route may intentionally have no config key: pi's ModelRegistry can
      // resolve stored /login credentials, OAuth, env values or !commands.
      const attempts = selection.attempts;
      let failovers = 0;
      let terminalSent = false;
      let lastError = `alias "${model.id}": all provider lines failed`;

      try {
        for (let i = 0; i < attempts.length; i++) {
          const target = attempts[i];
          const attemptStart = Date.now();
          let ttftAt: number | undefined;
          let committed = false;
          let pendingStart: AssistantMessageEvent | undefined;
          let shouldTryNext = false;
          let responseMeta: UpstreamFailure | undefined;
          let retryAfterMs: number | undefined;

          try {
            const registeredModel = this.modelRegistry?.find(target.provider, target.model)
              ?? this.modelRegistry?.find(target.authProvider, target.model);
            const targetModel: Model<Api> = {
              ...(registeredModel ?? model),
              id: target.model,
              name: registeredModel?.name ?? target.model,
              baseUrl: target.baseUrl,
              provider: target.provider,
              api: target.api,
              ...(target.thinkingLevelMap ? { thinkingLevelMap: target.thinkingLevelMap } : {}),
              ...(target.compat ? { compat: target.compat as never } : {}),
            };
            const authModel: Model<Api> = target.authProvider === target.provider
              ? targetModel
              : { ...targetModel, provider: target.authProvider };
            const runtimeAuth = !target.accountName && this.modelRegistry
              ? await this.modelRegistry.getApiKeyAndHeaders(authModel)
              : undefined;
            if (runtimeAuth && !runtimeAuth.ok) throw new Error(runtimeAuth.error);
            const apiKey = target.accountName
              ? await resolveConfigValue(target.apiKey)
              : runtimeAuth?.ok ? runtimeAuth.apiKey : await resolveConfigValue(target.apiKey);
            const configuredHeaders = await resolveHeaderValues(target.headers);
            const headers = {
              ...(model.headers ?? {}),
              ...(registeredModel?.headers ?? {}),
              ...(runtimeAuth?.ok ? runtimeAuth.headers ?? {} : {}),
              ...configuredHeaders,
            };
            // A delegated auth provider contributes credentials and dynamic headers,
            // but must not replace this binding's explicitly configured endpoint.
            if (target.authProvider === target.provider && runtimeAuth?.ok && runtimeAuth.baseUrl) {
              targetModel.baseUrl = runtimeAuth.baseUrl;
            }

            // Do not require a scalar apiKey here: OpenAI/Anthropic transports
            // also accept OAuth or gateway auth carried entirely by headers.
            // Each native transport performs its own protocol-specific check.
            const upstream = streamWithTransport(targetModel, context, {
              ...options,
              apiKey,
              headers,
              onResponse: async (response, responseModel) => {
                responseMeta = response;
                retryAfterMs = parseRetryAfterHeader(response.headers["retry-after"] ?? response.headers["Retry-After"]);
                await options?.onResponse?.(response, responseModel);
              },
            });

            for await (const event of upstream) {
              if (event.type === "start") {
                pendingStart = event;
                continue;
              }

              const isFirstDelta =
                event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta";
              const isContent =
                event.type === "text_start" ||
                event.type === "thinking_start" ||
                event.type === "toolcall_start" ||
                isFirstDelta;

              if (isFirstDelta && ttftAt === undefined) ttftAt = Date.now();
              if (isContent && !committed) {
                if (pendingStart) stream.push(pendingStart);
                committed = true;
              }

              if (event.type === "error" && !committed) {
                lastError = event.error.errorMessage ?? "unknown upstream error";
                const category = classifyError(lastError, options?.signal?.aborted || event.reason === "aborted", responseMeta);
                if (selection.canFailover && i < attempts.length - 1 && canFailoverFor(category)) {
                  this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs);
                  this.logFailover(model.id, target, attempts[i + 1], lastError, category);
                  failovers += 1;
                  this.turnFailovers += 1;
                  shouldTryNext = true;
                  break;
                }
                if (pendingStart) stream.push(pendingStart);
                stream.push(event);
                terminalSent = true;
                this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs);
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false);
                break;
              }

              if (!committed && (event.type === "done" || event.type === "error")) {
                if (pendingStart) stream.push(pendingStart);
                committed = true;
              }
              stream.push(event);

              if (event.type === "done") {
                terminalSent = true;
                this.settleAttempt(model.id, target, true, attemptStart, ttftAt);
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, true);
                break;
              }
              if (event.type === "error") {
                terminalSent = true;
                lastError = event.error.errorMessage ?? "unknown upstream error";
                const category = classifyError(lastError, options?.signal?.aborted || event.reason === "aborted", responseMeta);
                this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs);
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false);
                break;
              }
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            responseMeta = extractUpstreamFailure(err, responseMeta);
            retryAfterMs ??= parseRetryAfterHeader(responseMeta?.headers?.["retry-after"] ?? responseMeta?.headers?.["Retry-After"]);
            const category = classifyError(lastError, options?.signal?.aborted, responseMeta);
            if (!committed && selection.canFailover && i < attempts.length - 1 && canFailoverFor(category)) {
              this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs);
              this.logFailover(model.id, target, attempts[i + 1], lastError, category);
              failovers += 1;
              this.turnFailovers += 1;
              shouldTryNext = true;
            } else {
              if (!committed && pendingStart) stream.push(pendingStart);
              stream.push({
                type: "error",
                reason: options?.signal?.aborted ? "aborted" : "error",
                error: errorMessage(model, lastError),
              });
              terminalSent = true;
              this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs);
              this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false);
            }
          }

          if (terminalSent) break;
          if (shouldTryNext) continue;

          lastError = `provider stream ${this.describeCandidate(target)} ended without a terminal event`;
          if (!committed && selection.canFailover && i < attempts.length - 1) {
            this.settleAttempt(model.id, target, false, attemptStart, ttftAt, "unknown", lastError, retryAfterMs);
            this.logFailover(model.id, target, attempts[i + 1], lastError, "unknown");
            failovers += 1;
            this.turnFailovers += 1;
            continue;
          }
          this.settleAttempt(model.id, target, false, attemptStart, ttftAt, "unknown", lastError, retryAfterMs);
          break;
        }

        if (!terminalSent) {
          stream.push({
            type: "error",
            reason: options?.signal?.aborted ? "aborted" : "error",
            error: errorMessage(model, `pi-switch: ${lastError}`),
          });
        }
      } catch (err) {
        stream.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: errorMessage(model, `pi-switch: ${err instanceof Error ? err.message : String(err)}`),
        });
      } finally {
        stream.end();
      }
    })();

    return stream;
  }

  /** Current circuit-breaker state for status and diagnostics. */
  healthSummary() {
    return { ...this.health.summary(), lines: this.health.list() };
  }

  /** Last settled route (for /switch status + turn stats). */
  lastRouteInfo(): RouteInfo | undefined {
    return this.lastRoute;
  }

  /** Mark the start of a new agent turn (resets failover counter). */
  beginTurn(): void {
    this.turnId += 1;
    this.turnFailovers = 0;
  }

  /** Current turn id. */
  currentTurnId(): number {
    return this.turnId;
  }

  /** Failovers accumulated across retries in the current turn. */
  currentTurnFailovers(): number {
    return this.turnFailovers;
  }

  /**
   * Phase 6: expand bindings into per-account candidates (key pool).
   * A binding with configured accounts becomes one candidate per enabled
   * account (ordered by account priority); a binding without accounts stays
   * as-is and uses the provider-level key.
   */
  private expandCandidates(bindings: ResolvedBinding[]): ResolvedBinding[] {
    const candidates: ResolvedBinding[] = [];
    for (const binding of bindings) {
      const hasConfiguredAccounts = this.accounts.hasAccounts(binding.provider);
      const accounts = this.accounts.forProvider(binding.provider);
      if (!hasConfiguredAccounts) {
        candidates.push(binding);
        continue;
      }
      if (accounts.length === 0) {
        console.warn(
          `[pi-switch] provider "${binding.provider}": account pool is configured but has no enabled account with a resolvable key`,
        );
        continue;
      }
      for (const account of accounts) {
        candidates.push({
          ...binding,
          apiKey: account.apiKey,
          accountName: account.name,
          accountPriority: account.priority,
        });
      }
    }
    return candidates;
  }

  private settleAttempt(
    alias: string,
    target: ResolvedBinding,
    success: boolean,
    startedAt: number,
    ttftAt?: number,
    category?: ErrorCategory,
    error?: string,
    retryAfterMs?: number,
  ): void {
    if (success) this.health.recordSuccess(target);
    else this.health.recordFailure(
      target,
      category ?? "unknown",
      error ?? "unknown error",
      retryAfterMs ?? parseRetryAfterMs(error ?? ""),
    );
    this.stats.recordAttempt({
      alias,
      lineId: target.lineId,
      provider: target.provider,
      ...(target.accountName ? { account: target.accountName } : {}),
      success,
      ...(ttftAt !== undefined ? { ttftMs: ttftAt - startedAt } : {}),
      durationMs: Date.now() - startedAt,
      ...(category ? { category } : {}),
      ...(error ? { error } : {}),
    });
  }

  private recordRoute(
    alias: string,
    target: ResolvedBinding,
    ttftAt: number | undefined,
    attemptStart: number,
    failovers: number,
    ok: boolean,
  ): void {
    this.lastRoute = {
      alias,
      lineId: target.lineId,
      provider: target.provider,
      ...(target.accountName ? { account: target.accountName } : {}),
      model: target.model,
      latency: ttftAt !== undefined ? ttftAt - attemptStart : undefined,
      failovers,
      ok,
      turnId: this.turnId,
      timestamp: Date.now(),
    };
  }

  private logFailover(
    alias: string,
    from: ResolvedBinding,
    to: ResolvedBinding,
    message: string,
    category: string,
  ): void {
    console.log(
      `[pi-switch] alias "${alias}": ${this.describeCandidate(from)} failed [${category}] (${message}), failing over to ${this.describeCandidate(to)}`,
    );
  }

  /** Human-readable candidate label for logs (provider[/account]). */
  private describeCandidate(candidate: ResolvedBinding): string {
    return candidate.accountName
      ? `${candidate.provider}/${candidate.accountName}`
      : candidate.provider;
  }

  /** Immediate error stream (no routing possible). */
  private fail(model: Model<Api>, message: string): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "error", reason: "error", error: errorMessage(model, `pi-switch: ${message}`) });
    stream.end();
    return stream;
  }
}
