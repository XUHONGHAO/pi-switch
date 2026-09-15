/**
 * pi-switch — AI Agent Model Gateway & Provider Manager
 *
 * Phase 1 scope:
 *   - pi extension entry point
 *   - configuration loading (~/.pi-switch/*.json)
 *   - provider registration into pi's model registry
 *
 * Phase 2 scope:
 *   - OpenAI-compatible providers with startup model discovery
 *   - real request path (api: "openai-completions")
 *
 * Phase 3 scope:
 *   - model alias system (models.json): pi-switch/gpt5 -> sub2api/gpt-5
 *   - virtual alias provider with stream-time forwarding
 *
 * Phase 4 scope:
 *   - Router strategies: priority / failover / balance
 *   - transparent failover to the next line on content-free failure
 *
 * Phase 5 scope:
 *   - /switch command (picker, status, providers, test)
 *   - preset integration (provider: "pi-switch" in presets.json)
 *
 * Phase 6 scope:
 *   - multi-account key pool (accounts.json): priority, disable, stats
 *
 * Phase 7 scope:
 *   - request statistics: requests / success rate / latency / failovers
 *   - persisted to stats.json, surfaced in /switch status
 *
 * Phase 8 scope:
 *   - ConfigStore: live reloadable config (no restart after edits)
 *   - /config command: TUI wizard for providers / aliases / accounts / strategy
 *   - hot re-registration after save (registerProvider without restart)
 *
 * v0.3 scope:
 *   - native OpenAI Responses / Anthropic Messages / Google Generative AI transports
 *   - binding-level protocol, compat and thinking mappings
 *   - pi ModelRegistry auth delegation plus request-time !command secrets
 *
 * v0.3.1 stabilization:
 *   - binding-level health/stat identities and structured HTTP classification
 *   - explicit authProvider delegation and protocol-aware compat validation
 *   - native alias/auth integration coverage and release checks
 *
 * v0.3.2 correctness:
 *   - /config strategy merges existing routing thresholds
 *   - provider delete cascades dependent accounts / alias lines
 *   - model discovery resolves !command secrets
 *   - alias input modalities passthrough + consistent empty-key semantics
 *
 * Acceptance: starting pi shows "pi-switch loaded".
 *
 * Project structure (from pi-switch.md):
 *   src/
 *   ├── index.ts          <- this file (entry point)
 *   ├── config/loader.ts  <- configuration loading          (Phase 1)
 *   ├── provider/         <- provider manager + openai      (Phase 1/2)
 *   ├── account/          <- multi-account key pool         (Phase 6)
 *   ├── model/            <- model alias resolver           (Phase 3)
 *   ├── router/           <- routing strategies             (Phase 4)
 *   ├── preset/           <- pi preset integration          (Phase 5)
 *   └── ui/               <- /switch selector UI            (Phase 5)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "./config/store";
import { bindSetModel } from "./preset/preset";
import {
  AliasProvider,
  ALIAS_PROVIDER,
  type AliasRegistration,
  type ContextUsageSnapshot,
} from "./provider/alias";
import { ProviderManager, type RegisteredProvider } from "./provider/manager";
import { StatsManager } from "./stats/manager";
import { registerConfigCommand } from "./ui/config";
import { registerSwitchCommand } from "./ui/switch";

const VERSION = "0.3.2";

export default async function piSwitch(pi: ExtensionAPI): Promise<void> {
  // ---- Phase 1: live configuration store -----------------------------------
  // ConfigStore keeps the config reloadable so /config edits take effect
  // without restarting pi (reload() re-reads disk, consumers re-register).
  const store = new ConfigStore();

  // ---- Phase 1/2: provider registration + model discovery -----------------
  const providerManager = new ProviderManager(pi);
  let providers: RegisteredProvider[] = await providerManager.registerFromConfig(store.get());

  // ---- Phase 7: request statistics -----------------------------------------
  const stats = new StatsManager(store.dir());

  // ---- Phase 3: model alias provider (pi-switch/gpt5 etc.) -----------------
  const aliasProvider = new AliasProvider(pi, store, stats);
  let aliasRegistration: AliasRegistration | undefined = aliasProvider.register();

  // Re-register everything after a config change (hot reload, no restart).
  async function reloadAll(): Promise<void> {
    const config = store.reload();
    const [nextProviders, nextAliases] = await Promise.all([
      providerManager.reload(config),
      Promise.resolve(aliasProvider.reload()),
    ]);
    providers = nextProviders;
    aliasRegistration = nextAliases;
    if (activeContext && currentSessionId) {
      aliasProvider.restoreSessionAffinity(currentSessionId, activeContext.sessionManager.getBranch());
    }
    switchCommand.reload();
  }

  const parts: string[] = providers.map((p) => `${p.name} (${p.type}, ${p.modelCount} model(s))`);
  if (aliasRegistration) {
    parts.push(`${ALIAS_PROVIDER} (alias, ${aliasRegistration.modelCount} model(s))`);
  }

  const summary =
    parts.length === 0
      ? "no providers configured (edit ~/.pi-switch/providers.json)"
      : parts.join(", ");

  console.log(`[pi-switch] loaded v${VERSION} · providers: ${summary}`);

  // ---- Phase 5: commands + presets -----------------------------------------
  bindSetModel((model) => pi.setModel(model as never));
  const switchCommand = registerSwitchCommand(pi, store, aliasProvider, stats);

  // ---- Phase 8: /config UI -------------------------------------------------
  registerConfigCommand(pi, { store, reloadAll });

  // ---- Phase 1: startup notification --------------------------------------
  // session_start also fires after /reload and session switches, so the
  // message doubles as a live confirmation that the extension is active.
  let activeContext: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  const updateStatus = () => {
    if (!activeContext?.hasUI) return;
    const route = aliasProvider.lastRouteInfo();
    const health = aliasProvider.healthSummary();
    const routeLabel = route ? `${route.provider}${route.account ? `/${route.account}` : ""}` : "idle";
    const circuitLabel = health.open ? ` · ${health.open} open` : "";
    activeContext.ui.setStatus("pi-switch", activeContext.ui.theme.fg(health.open ? "warning" : "accent", `⇄ ${routeLabel}${circuitLabel}`));
  };

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    aliasProvider.bindModelRegistry(ctx.modelRegistry);
    aliasProvider.restoreSessionAffinity(currentSessionId, ctx.sessionManager.getBranch());
    updateStatus();
    ctx.ui.notify(
      `pi-switch loaded v${VERSION} · ${providers.length} provider(s)${aliasRegistration ? `, ${aliasRegistration.modelCount} alias(es)` : ""}`,
      "info",
    );
  });

  // Persist pending stats on shutdown / reload / session switch.
  pi.on("session_shutdown", () => {
    activeContext?.ui.setStatus("pi-switch", undefined);
    stats.flush();
    // Clear session affinity (Phase A).
    if (aliasProvider && currentSessionId) {
      aliasProvider.clearSession(currentSessionId);
    }
    activeContext = undefined;
    currentSessionId = undefined;
  });

  // ---- Phase 7: agent-level request stats ----------------------------------
  // pi auto-retries failed provider calls (each retry is a new turn), so
  // turn-level counting would over-count. Record once per agent run via
  // agent_start (snapshot alias) + agent_settled (final outcome, after all
  // retries/compaction settled).
  let agentAlias: string | undefined;
  pi.on("agent_start", (_event, ctx) => {
    agentAlias = ctx.model?.provider === ALIAS_PROVIDER ? ctx.model.id : undefined;
    const usage = ctx.getContextUsage();
    const contextUsage: ContextUsageSnapshot = usage
      ? {
          ...(usage.tokens !== null ? { tokens: usage.tokens } : {}),
          ...(usage.percent !== null ? { percent: usage.percent } : {}),
          contextWindow: usage.contextWindow,
          reliable: usage.tokens !== null,
        }
      : { reliable: false };
    aliasProvider.beginTurn(contextUsage);
  });
  pi.on("agent_settled", () => {
    updateStatus();
    if (!agentAlias) return;
    const route = aliasProvider.lastRouteInfo();
    if (!route || route.turnId !== aliasProvider.currentTurnId()) return;
    stats.record({
      alias: agentAlias,
      provider: route.provider,
      ...(route.account ? { account: route.account } : {}),
      success: route.ok,
      latencyMs: route.latency,
      failovers: aliasProvider.currentTurnFailovers(),
      ...(route.ok ? {} : { error: "request failed" }),
    });
    agentAlias = undefined;
  });
}
