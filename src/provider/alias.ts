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
  Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { AccountManager } from "../account/manager";
import { resolveConfigValue, resolveHeaderValues } from "../config/secret";
import {
  classifyError,
  extractUpstreamFailure,
  type ErrorCategory,
  type UpstreamFailure,
} from "../errors/classify";
import {
  decideFailure,
  DEFAULT_FAILOVER_ON_UNKNOWN,
  DEFAULT_FAILURE_COST_POLICY,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_HIGH_COST_FAILOVERS,
  type AttemptPhase,
  type FailureDecision,
} from "../errors/decision";
import type { FailureCostPolicy } from "../config/loader";
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

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

export interface AliasRegistration {
  provider: string;
  modelCount: number;
}

export const AFFINITY_ENTRY_TYPE = "pi-switch-affinity";

export interface ContextUsageSnapshot {
  tokens?: number;
  percent?: number;
  contextWindow?: number;
  reliable: boolean;
}

interface AffinityEntryData {
  version: 1;
  sessionIdHash: string;
  alias: string;
  lineId: string;
  accountName?: string;
}

interface AttemptTelemetry {
  contextUsage: ContextUsageSnapshot;
  affinityHit: boolean;
  usage?: Usage;
  phase: AttemptPhase;
  decision?: FailureDecision;
  attemptNumber: number;
  maxAttempts: number;
  budgetRemaining: number;
  highCostFailoversUsed: number;
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
  /** Whether this request started on a persisted session-affine line. */
  affinityHit: boolean;
  /** Context usage snapshot captured before this request. */
  contextTokens?: number;
  contextPercent?: number;
  /** Usage reported by the final settled upstream attempt. */
  usage?: Usage;
  /** Last structured failure decision, when this request encountered one. */
  decision?: FailureDecision;
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
  private contextUsage: ContextUsageSnapshot = { reliable: false };

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

  /** Clear session affinity (called on session_shutdown). */
  clearSession(sessionId: string): void {
    this.router.clearSession(sessionId);
  }

  /** Restore only entries belonging to this exact pi session. */
  restoreSessionAffinity(sessionId: string, entries: readonly unknown[]): void {
    const sessionIdHash = hashSessionId(sessionId);
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry.type !== "custom" || entry.customType !== AFFINITY_ENTRY_TYPE) continue;
      const data = entry.data as Partial<AffinityEntryData> | undefined;
      if (
        data?.version !== 1 ||
        data.sessionIdHash !== sessionIdHash ||
        typeof data.alias !== "string" ||
        typeof data.lineId !== "string" ||
        data.alias.length === 0 ||
        data.lineId.length === 0
      ) continue;
      this.router.restoreAffinity(sessionId, data.alias, data.lineId, typeof data.accountName === "string" ? data.accountName : undefined);
    }
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
    const sessionId = options?.sessionId as string | undefined;
    const selection: Selection = this.router.select(model.id, available, sessionId);
    const contextUsage = this.contextUsage;
    const routing = this.store.get().routing;
    const policy = routing.failureCostPolicy ?? DEFAULT_FAILURE_COST_POLICY;
    const maxAttempts = routing.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const maxHighCostFailovers = routing.maxHighCostFailovers ?? DEFAULT_MAX_HIGH_COST_FAILOVERS;
    const failoverOnUnknown = routing.failoverOnUnknown ?? DEFAULT_FAILOVER_ON_UNKNOWN;
    const stream = createAssistantMessageEventStream();

    void (async () => {
      // A route may intentionally have no config key: pi's ModelRegistry can
      // resolve stored /login credentials, OAuth, env values or !commands.
      const attempts = selection.attempts;
      let failovers = 0;
      let terminalSent = false;
      let lastError = `alias "${model.id}": all provider lines failed`;
      let affinityRecorded = false;
      let attemptsUsed = 0;
      let highCostFailoversUsed = 0;
      let lastDecision: FailureDecision | undefined;

      try {
        for (let i = 0; i < attempts.length && attemptsUsed < maxAttempts; i++) {
          const target = attempts[i];
          attemptsUsed += 1;
          const attemptStart = Date.now();
          let ttftAt: number | undefined;
          let committed = false;
          let phase: AttemptPhase = "resolving-auth";
          let decision: FailureDecision | undefined;
          let pendingStart: AssistantMessageEvent | undefined;
          let shouldTryNext = false;
          let responseMeta: UpstreamFailure | undefined;
          let retryAfterMs: number | undefined;
          let usage: Usage | undefined;
          const telemetry = (): AttemptTelemetry => ({
            contextUsage,
            affinityHit: i === 0 && selection.affinityHit,
            ...(usage ? { usage } : {}),
            phase,
            ...(decision ? { decision } : {}),
            attemptNumber: attemptsUsed,
            maxAttempts,
            budgetRemaining: Math.max(0, maxAttempts - attemptsUsed),
            highCostFailoversUsed,
          });

          const chooseNextIndex = (action: FailureDecision["action"]): number | undefined => {
            if (action === "switch-account") {
              return attempts.findIndex((candidate, index) => index > i && candidate.lineId === target.lineId && candidate.accountName !== target.accountName);
            }
            if (action === "switch-route") {
              return attempts.findIndex((candidate, index) => index > i && candidate.lineId !== target.lineId);
            }
            return undefined;
          };

          const decide = (category: ErrorCategory): number | undefined => {
            const hasAlternativeAccount = attempts.some((candidate, index) => index > i && candidate.lineId === target.lineId && candidate.accountName !== target.accountName);
            const hasAlternativeRoute = attempts.some((candidate, index) => index > i && candidate.lineId !== target.lineId);
            decision = decideFailure({
              category,
              contextTokens: contextUsage.tokens,
              contextRatio: contextUsage.percent,
              contextUsageReliable: contextUsage.reliable,
              status: responseMeta?.status,
              retryAfterMs,
              phase,
              contentCommitted: committed,
              aborted: Boolean(options?.signal?.aborted),
              canFailover: selection.canFailover,
              hasAlternativeAccount,
              hasAlternativeRoute,
              attemptsUsed,
              maxAttempts,
              highCostFailoversUsed,
              maxHighCostFailovers,
              policy: policy as FailureCostPolicy,
              failoverOnUnknown,
            });
            lastDecision = decision;
            const nextIndex = chooseNextIndex(decision.action);
            if (nextIndex !== undefined && decision.costRisk === "high") highCostFailoversUsed += 1;
            return nextIndex;
          };

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
            phase = "connecting";
            const upstream = streamWithTransport(targetModel, context, {
              ...options,
              apiKey,
              headers,
              onResponse: async (response, responseModel) => {
                responseMeta = response;
                phase = "awaiting-response";
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
                phase = "streaming";
                // Record session affinity after first content event (Phase A).
                if (!affinityRecorded) {
                  const changed = this.router.setAffinity(sessionId, model.id, target);
                  if (changed) this.persistAffinity(sessionId, model.id, target.lineId, target.accountName);
                  affinityRecorded = true;
                }
              }

              if (event.type === "error" && !committed) {
                usage = event.error.usage;
                lastError = event.error.errorMessage ?? "unknown upstream error";
                const category = classifyError(lastError, options?.signal?.aborted || event.reason === "aborted", responseMeta);
                const nextIndex = decide(category);
                if (nextIndex !== undefined) {
                  this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs, telemetry());
                  this.logFailover(model.id, target, attempts[nextIndex], lastError, `${category}; ${decision?.reasonCode}; ${decision?.costRisk}`);
                  failovers += 1;
                  this.turnFailovers += 1;
                  shouldTryNext = true;
                  i = nextIndex - 1;
                  break;
                }
                if (pendingStart) stream.push(pendingStart);
                stream.push(event);
                terminalSent = true;
                this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs, telemetry());
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false, telemetry(), selection.affinityHit, lastDecision);
                break;
              }

              if (!committed && (event.type === "done" || event.type === "error")) {
                if (pendingStart) stream.push(pendingStart);
                committed = true;
              }
              stream.push(event);

              if (event.type === "done") {
                usage = event.message.usage;
                terminalSent = true;
                this.settleAttempt(model.id, target, true, attemptStart, ttftAt, undefined, undefined, undefined, telemetry());
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, true, telemetry(), selection.affinityHit, lastDecision);
                break;
              }
              if (event.type === "error") {
                usage = event.error.usage;
                terminalSent = true;
                lastError = event.error.errorMessage ?? "unknown upstream error";
                const category = classifyError(lastError, options?.signal?.aborted || event.reason === "aborted", responseMeta);
                decide(category);
                this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs, telemetry());
                this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false, telemetry(), selection.affinityHit, lastDecision);
                break;
              }
            }
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            responseMeta = extractUpstreamFailure(err, responseMeta);
            retryAfterMs ??= parseRetryAfterHeader(responseMeta?.headers?.["retry-after"] ?? responseMeta?.headers?.["Retry-After"]);
            const category = classifyError(lastError, options?.signal?.aborted, responseMeta);
            const nextIndex = decide(category);
            if (nextIndex !== undefined) {
              this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs, telemetry());
              this.logFailover(model.id, target, attempts[nextIndex], lastError, `${category}; ${decision?.reasonCode}; ${decision?.costRisk}`);
              failovers += 1;
              this.turnFailovers += 1;
              shouldTryNext = true;
              i = nextIndex - 1;
            } else {
              if (!committed && pendingStart) stream.push(pendingStart);
              stream.push({
                type: "error",
                reason: options?.signal?.aborted ? "aborted" : "error",
                error: errorMessage(model, lastError),
              });
              terminalSent = true;
              this.settleAttempt(model.id, target, false, attemptStart, ttftAt, category, lastError, retryAfterMs, telemetry());
              this.recordRoute(model.id, target, ttftAt, attemptStart, failovers, false, telemetry(), selection.affinityHit, lastDecision);
            }
          }

          if (terminalSent) break;
          if (shouldTryNext) continue;

          lastError = `provider stream ${this.describeCandidate(target)} ended without a terminal event`;
          const nextIndex = decide("unknown");
          if (nextIndex !== undefined) {
            this.settleAttempt(model.id, target, false, attemptStart, ttftAt, "unknown", lastError, retryAfterMs, telemetry());
            this.logFailover(model.id, target, attempts[nextIndex], lastError, `unknown; ${decision?.reasonCode}; ${decision?.costRisk}`);
            failovers += 1;
            this.turnFailovers += 1;
            i = nextIndex - 1;
            continue;
          }
          this.settleAttempt(model.id, target, false, attemptStart, ttftAt, "unknown", lastError, retryAfterMs, telemetry());
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
  beginTurn(contextUsage: ContextUsageSnapshot = { reliable: false }): void {
    this.turnId += 1;
    this.turnFailovers = 0;
    this.contextUsage = contextUsage;
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
      const hasConfiguredAccounts = binding.accountNames !== undefined || this.accounts.hasAccounts(binding.provider);
      const accounts = this.accounts.forProvider(binding.provider, binding.accountNames);
      if (!hasConfiguredAccounts) {
        candidates.push(binding);
        continue;
      }
      if (accounts.length === 0) {
        console.warn(
          `[pi-switch] line "${binding.lineId}": account scope is configured but has no enabled account with a resolvable key`,
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
    telemetry?: AttemptTelemetry,
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
      ...(telemetry ? {
        contextTokens: telemetry.contextUsage.tokens,
        contextPercent: telemetry.contextUsage.percent,
        contextUsageReliable: telemetry.contextUsage.reliable,
        affinityHit: telemetry.affinityHit,
        phase: telemetry.phase,
        ...(telemetry.decision ? { decision: telemetry.decision } : {}),
        attemptNumber: telemetry.attemptNumber,
        maxAttempts: telemetry.maxAttempts,
        budgetRemaining: telemetry.budgetRemaining,
        highCostFailoversUsed: telemetry.highCostFailoversUsed,
        ...(telemetry.usage ? { usage: telemetry.usage } : {}),
      } : {}),
    });
  }

  private recordRoute(
    alias: string,
    target: ResolvedBinding,
    ttftAt: number | undefined,
    attemptStart: number,
    failovers: number,
    ok: boolean,
    telemetry: AttemptTelemetry,
    affinityHit: boolean,
    decision?: FailureDecision,
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
      affinityHit,
      ...(telemetry.contextUsage.tokens !== undefined ? { contextTokens: telemetry.contextUsage.tokens } : {}),
      ...(telemetry.contextUsage.percent !== undefined ? { contextPercent: telemetry.contextUsage.percent } : {}),
      ...(telemetry.usage ? { usage: telemetry.usage } : {}),
      ...((decision ?? telemetry.decision) ? { decision: decision ?? telemetry.decision } : {}),
      turnId: this.turnId,
      timestamp: Date.now(),
    };
  }

  private persistAffinity(sessionId: string | undefined, alias: string, lineId: string, accountName?: string): void {
    if (!sessionId || typeof this.pi.appendEntry !== "function") return;
    const data: AffinityEntryData = {
      version: 1,
      sessionIdHash: hashSessionId(sessionId),
      alias,
      lineId,
      ...(accountName ? { accountName } : {}),
    };
    this.pi.appendEntry(AFFINITY_ENTRY_TYPE, data);
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
