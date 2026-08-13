/**
 * Account Manager (Phase 6)
 *
 * Manages multiple API keys per provider (accounts.json):
 *   - key pool: multiple keys per provider
 *   - priority: lower `priority` wins
 *   - disable: `enabled: false` accounts are skipped
 *   - stats: per-account usage stats surface (Phase 7 writes them)
 *
 * Accounts expand into per-request candidate lines at routing time
 * (see AliasProvider.expandCandidates): each enabled account becomes a
 * candidate with its own key, ordered by binding priority then account
 * priority. The Router's failover / balance machinery applies unchanged.
 */

import type { ConfigStore } from "../config/store";
import { resolveEnvRef } from "../provider/openai";

/** Snapshot of an account as seen by the router. */
export interface AccountInfo {
  /** Account key from accounts.json, e.g. "gpt5_main". */
  name: string;
  /** Provider key this account belongs to. */
  provider: string;
  /** Routing priority (lower = preferred). */
  priority: number;
  /** Whether the account is usable. */
  enabled: boolean;
  /** Resolved API key (literal or env interpolation). */
  apiKey: string;
  /** Per-account usage statistics, if recorded (Phase 7). */
  stats?: Record<string, unknown>;
}

export class AccountManager {
  constructor(private readonly store: ConfigStore) {}

  /** Enabled accounts for a provider, ordered by priority. */
  forProvider(provider: string): AccountInfo[] {
    const accounts: AccountInfo[] = [];
    for (const [name, account] of Object.entries(this.store.get().accounts)) {
      if (account.provider !== provider) continue;
      if (account.enabled === false) continue;
      // Leading !commands are resolved at request time, matching pi's secret semantics.
      const apiKey = account.apiKey.startsWith("!") ? account.apiKey : resolveEnvRef(account.apiKey);
      if (!apiKey) {
        console.warn(`[pi-switch] account "${name}": no resolvable apiKey, skipping`);
        continue;
      }
      accounts.push({
        name,
        provider,
        priority: account.priority ?? 0,
        enabled: true,
        apiKey,
        ...(account.stats && Object.keys(account.stats).length > 0 ? { stats: account.stats } : {}),
      });
    }
    return accounts.sort((a, b) => a.priority - b.priority);
  }

  /** Whether a provider has any configured accounts (enabled or not). */
  hasAccounts(provider: string): boolean {
    return Object.values(this.store.get().accounts).some((a) => a.provider === provider);
  }

  /** All accounts (including disabled), ordered by provider then priority. */
  list(): AccountInfo[] {
    const accounts: AccountInfo[] = [];
    for (const [name, account] of Object.entries(this.store.get().accounts)) {
      const apiKey = account.apiKey.startsWith("!") ? account.apiKey : resolveEnvRef(account.apiKey);
      accounts.push({
        name,
        provider: account.provider,
        priority: account.priority ?? 0,
        enabled: account.enabled !== false,
        apiKey: apiKey ?? "",
        ...(account.stats && Object.keys(account.stats).length > 0 ? { stats: account.stats } : {}),
      });
    }
    return accounts.sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority,
    );
  }
}
