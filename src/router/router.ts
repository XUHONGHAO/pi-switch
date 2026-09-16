/**
 * Router (Phase 4)
 *
 * Chooses the actual request line from a model alias's bindings using the
 * strategy from routing.json (with per-alias overrides in models.json):
 *
 *   priority | failover | balance
 *
 *   priority: always the highest-priority binding (no failover)
 *   failover: try bindings in priority order, move to the next on failure
 *   balance:  distribute sessions across bindings (session-scoped by default),
 *             or rotate per-request (legacy "request" scope)
 *
 * Strategy resolution order: alias-level (`models.json` `strategy`)
 * -> global (`routing.json` `strategy`) -> "priority".
 *
 * Session affinity (Phase A):
 *   Maintains in-memory affinity map: sessionId + alias -> binding.
 *   After a successful first response, the session sticks to that binding.
 *   New sessions participate in initial selection (rendezvous hash for balance).
 */

import type { RoutingStrategy } from "../config/loader";
import type { ConfigStore } from "../config/store";
import type { ResolvedBinding } from "../model/resolver";
import { createHash } from "node:crypto";

/** Router decision for one request. */
export interface Selection {
  /** Binding chosen first for this request. */
  binding: ResolvedBinding;
  /** Effective strategy applied. */
  strategy: RoutingStrategy;
  /** Ordered candidate list used for failover attempts. */
  attempts: ResolvedBinding[];
  /** Whether failover to the next candidate is allowed on failure. */
  canFailover: boolean;
  /** Whether the first binding came from an existing session affinity entry. */
  affinityHit: boolean;
}

interface AffinityTarget {
  lineId: string;
  accountName?: string;
}

export class Router {
  /** Per-alias round-robin counters (legacy request-scoped balance). */
  private readonly counters = new Map<string, number>();
  /** Session affinity map: "sessionId:alias" -> binding/account identity. */
  private readonly affinity = new Map<string, AffinityTarget>();

  constructor(private readonly store: ConfigStore) {}

  /** Global default strategy from routing.json. */
  defaultStrategy(): RoutingStrategy {
    return this.store.get().routing.strategy ?? "priority";
  }

  /** Effective strategy for an alias (alias override wins over global). */
  strategyFor(alias: string): RoutingStrategy {
    return this.store.get().models[alias]?.strategy ?? this.defaultStrategy();
  }

  /** Balance scope: session-sticky (default) or per-request rotation. */
  balanceScope(): "session" | "request" {
    return this.store.get().routing.balanceScope ?? "session";
  }

  /**
   * Compute a stable affinity key for a session + alias.
   * Uses binding identity (provider:model:baseUrl) to survive config reloads.
   */
  private affinityKey(sessionId: string, alias: string): string {
    return `${sessionId}:${alias}`;
  }

  /** Stable identity shared with health and attempt statistics. */
  private bindingIdentity(binding: ResolvedBinding): string {
    return binding.lineId || `${binding.provider}|${binding.api}|${binding.baseUrl}|${binding.model}`;
  }

  /**
   * Rendezvous (highest random weight) hashing: deterministic session -> binding.
   * Returns the binding with the highest hash(sessionId + alias + bindingId).
   */
  private rendezvousHash(sessionId: string, alias: string, candidates: ResolvedBinding[]): ResolvedBinding {
    let best: ResolvedBinding | null = null;
    let bestHash = "";
    for (const binding of candidates) {
      const identity = this.bindingIdentity(binding);
      const hash = createHash("sha256").update(`${sessionId}:${alias}:${identity}`).digest("hex");
      if (best === null || hash > bestHash) {
        best = binding;
        bestHash = hash;
      }
    }
    return best!;
  }

  /**
   * Check if this session has affinity to a specific binding.
   * Returns the bound binding if found in candidates, otherwise undefined.
   */
  getAffinity(sessionId: string | undefined, alias: string, candidates: ResolvedBinding[]): ResolvedBinding | undefined {
    if (!sessionId) return undefined;
    const key = this.affinityKey(sessionId, alias);
    const target = this.affinity.get(key);
    if (!target) return undefined;
    // Prefer an account-specific entry. Older persisted entries only contain
    // lineId, so retain a line-level fallback for backwards compatibility.
    const exact = candidates.find((b) => this.bindingIdentity(b) === target.lineId && b.accountName === target.accountName);
    if (exact) return exact;
    return candidates.find((b) => this.bindingIdentity(b) === target.lineId);
  }

  /**
   * Record affinity after a successful first response.
   * Should be called once the content is committed (not on transient failures).
   */
  setAffinity(sessionId: string | undefined, alias: string, binding: ResolvedBinding): boolean {
    if (!sessionId) return false;
    const key = this.affinityKey(sessionId, alias);
    const target: AffinityTarget = {
      lineId: this.bindingIdentity(binding),
      ...(binding.accountName ? { accountName: binding.accountName } : {}),
    };
    const previous = this.affinity.get(key);
    if (previous?.lineId === target.lineId && previous.accountName === target.accountName) return false;
    this.affinity.set(key, target);
    return true;
  }

  /** Restore a persisted affinity entry for a resumed session. */
  restoreAffinity(sessionId: string, alias: string, lineId: string, accountName?: string): void {
    this.affinity.set(
      this.affinityKey(sessionId, alias),
      { lineId, ...(accountName ? { accountName } : {}) },
    );
  }

  /**
   * Clear affinity for a specific session (called on session_shutdown).
   */
  clearSession(sessionId: string): void {
    for (const key of this.affinity.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        this.affinity.delete(key);
      }
    }
  }

  /**
   * Select a binding for `alias`.
   * `bindings` must be non-empty (callers resolve and validate first).
   * `sessionId` enables session affinity: if the session already has a binding,
   * return it directly (if still available); otherwise perform initial selection.
   */
  select(alias: string, bindings: ResolvedBinding[], sessionId?: string): Selection {
    const strategy = this.strategyFor(alias);

    // Lower priority value wins. Accounts are expanded to per-key candidates,
    // so keep binding groups together and apply account priority within each
    // binding; declaration order breaks equal-priority binding ties.
    const bindingPositions = new Map<string, number>();
    bindings.forEach((binding, index) => {
      const identity = this.bindingIdentity(binding);
      if (!bindingPositions.has(identity)) bindingPositions.set(identity, index);
    });
    const attempts = [...bindings].sort((a, b) => {
      const priority = (a.priority ?? 0) - (b.priority ?? 0);
      if (priority !== 0) return priority;
      const position = (bindingPositions.get(this.bindingIdentity(a)) ?? 0)
        - (bindingPositions.get(this.bindingIdentity(b)) ?? 0);
      if (position !== 0) return position;
      return (a.accountPriority ?? 0) - (b.accountPriority ?? 0);
    });

    // Check session affinity (only for session-scoped balance and failover).
    const scope = this.balanceScope();
    const useAffinity = strategy === "failover" || (strategy === "balance" && scope === "session");
    if (useAffinity) {
      const affinity = this.getAffinity(sessionId, alias, attempts);
      if (affinity) {
        // Move the affine binding to the front; failover continues from there.
        const filtered = [affinity, ...attempts.filter((b) => b !== affinity)];
        return {
          binding: affinity,
          strategy,
          attempts: filtered,
          canFailover: strategy === "failover" || strategy === "balance",
          affinityHit: true,
        };
      }
    }

    // Initial selection: no affinity yet.
    if (strategy === "balance" && attempts.length > 1) {
      if (scope === "session" && sessionId) {
        // Session-scoped balance: rendezvous hash (deterministic).
        const chosen = this.rendezvousHash(sessionId, alias, attempts);
        const rotated = [chosen, ...attempts.filter((b) => b !== chosen)];
        return { binding: chosen, strategy, attempts: rotated, canFailover: true, affinityHit: false };
      } else {
        // Request-scoped balance: round-robin (legacy behavior).
        const counter = this.counters.get(alias) ?? 0;
        const start = counter % attempts.length;
        const rotated = [...attempts.slice(start), ...attempts.slice(0, start)];
        this.counters.set(alias, counter + 1);
        return { binding: rotated[0], strategy, attempts: rotated, canFailover: true, affinityHit: false };
      }
    }

    // priority / failover both start at the first candidate.
    return {
      binding: attempts[0],
      strategy,
      attempts,
      canFailover: strategy === "failover",
      affinityHit: false,
    };
  }

  /** Reset round-robin state and affinity (e.g. on config reload). */
  reset(): void {
    this.counters.clear();
    this.affinity.clear();
  }
}
