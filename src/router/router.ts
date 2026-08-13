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
 *   balance:  round-robin across bindings, move to the next on failure
 *
 * Strategy resolution order: alias-level (`models.json` `strategy`)
 * -> global (`routing.json` `strategy`) -> "priority".
 */

import type { RoutingStrategy } from "../config/loader";
import type { ConfigStore } from "../config/store";
import type { ResolvedBinding } from "../model/resolver";

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
}

export class Router {
  /** Per-alias round-robin counters. */
  private readonly counters = new Map<string, number>();

  constructor(private readonly store: ConfigStore) {}

  /** Global default strategy from routing.json. */
  defaultStrategy(): RoutingStrategy {
    return this.store.get().routing.strategy ?? "priority";
  }

  /** Effective strategy for an alias (alias override wins over global). */
  strategyFor(alias: string): RoutingStrategy {
    return this.store.get().models[alias]?.strategy ?? this.defaultStrategy();
  }

  /**
   * Select a binding for `alias`.
   * `bindings` must be non-empty (callers resolve and validate first).
   */
  select(alias: string, bindings: ResolvedBinding[]): Selection {
    const strategy = this.strategyFor(alias);

    // Lower priority value wins; stable sort keeps declaration order for ties.
    // Accounts expand to per-key candidates, so order by binding priority
    // first, then account priority within the same binding.
    const attempts = [...bindings].sort(
      (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.accountPriority ?? 0) - (b.accountPriority ?? 0),
    );

    if (strategy === "balance" && attempts.length > 1) {
      const counter = this.counters.get(alias) ?? 0;
      const start = counter % attempts.length;
      // Rotate so the chosen binding leads; failover continues the rotation.
      const rotated = [...attempts.slice(start), ...attempts.slice(0, start)];
      this.counters.set(alias, counter + 1);
      return { binding: rotated[0], strategy, attempts: rotated, canFailover: true };
    }

    // priority / failover both start at the first candidate.
    return { binding: attempts[0], strategy, attempts, canFailover: strategy === "failover" };
  }

  /** Reset round-robin state (e.g. on config reload). */
  reset(): void {
    this.counters.clear();
  }
}
