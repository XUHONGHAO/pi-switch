/**
 * /switch command (Phase 5)
 *
 *   /switch            open the model picker
 *   /switch <alias>    switch directly, e.g. /switch gpt5
 *   /switch status     show current model + routed line + latency
 *   /switch providers  list all aliases and their lines/accounts
 *   /switch check      static config/key/circuit diagnostics
 *   /switch probe      actively probe provider model endpoints
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AccountManager } from "../account/manager";
import type { ConfigStore } from "../config/store";
import { ModelResolver } from "../model/resolver";
import { handlePresetCommand, setCurrentModel } from "../preset/preset";
import type { AliasProvider } from "../provider/alias";
import { probeProvider } from "../provider/probe";
import { formatAttemptDiagnostics, formatAttemptUsage, formatStats, StatsManager } from "../stats/manager";
import { showModelSelector, toSelectorItems } from "./selector";

/** Handle returned so /config can rebuild picker state after a reload. */
export interface SwitchCommandHandle {
  reload(): void;
}

export function registerSwitchCommand(
  pi: ExtensionAPI,
  store: ConfigStore,
  aliasProvider: AliasProvider,
  stats: StatsManager,
): SwitchCommandHandle {
  let resolver = new ModelResolver(store);
  let accounts = new AccountManager(store);
  pi.registerCommand("switch", {
    description: "通过 pi-switch 模型别名切换模型",
    handler: async (args, ctx) => {
      const arg = args?.trim();

      if (!arg) {
        await pickAndApply(ctx, resolver);
        return;
      }
      if (arg === "preset" || arg.startsWith("preset ")) {
        await handlePresetCommand(arg.slice("preset".length).trim(), ctx);
        return;
      }
      if (arg === "status") {
        await showStatus(ctx, aliasProvider, stats);
        return;
      }
      if (arg === "providers") {
        showProviders(ctx, resolver, accounts);
        return;
      }
      if (arg === "test" || arg === "check") {
        showCheck(ctx, store, resolver, accounts, aliasProvider);
        return;
      }
      if (arg === "probe") {
        await showProbe(ctx, store);
        return;
      }
      // Direct switch: /switch <alias>
      await applyAlias(ctx, resolver, arg);
    },
  });

  return {
    reload() {
      resolver = new ModelResolver(store);
      accounts = new AccountManager(store);
    },
  };
}

async function pickAndApply(ctx: ExtensionCommandContext, resolver: ModelResolver): Promise<void> {
  const items = toSelectorItems(resolver.listConfig());
  const alias = await showModelSelector(ctx, items);
  if (alias) await applyAlias(ctx, resolver, alias);
}

async function applyAlias(ctx: ExtensionCommandContext, resolver: ModelResolver, alias: string): Promise<void> {
  const model = ctx.modelRegistry.find("pi-switch", alias);
  if (!model) {
    const available = resolver.listAliases().join(", ") || "(无)";
    console.log(`[pi-switch] /switch ${alias}: 未知别名（可用: ${available}）`);
    ctx.ui.notify(`未知模型别名 "${alias}"。可用别名: ${available}`, "error");
    return;
  }
  const ok = await setCurrentModel(model);
  if (ok) {
    console.log(`[pi-switch] /switch ${alias}: 已切换到 pi-switch/${alias}`);
    ctx.ui.notify(`已切换到 pi-switch/${alias}`, "info");
  } else {
    console.log(`[pi-switch] /switch ${alias}: 没有可用的 API Key`);
    ctx.ui.notify(`pi-switch/${alias} 没有可用的 API Key`, "warning");
  }
}

async function showStatus(
  ctx: ExtensionCommandContext,
  aliasProvider: AliasProvider,
  stats: StatsManager,
): Promise<void> {
  const model = ctx.model;
  const route = aliasProvider.lastRouteInfo();

  const modelLabel = model ? `${model.provider}/${model.id}` : "(无)";
  const provider = route?.provider ?? "-";
  const account = route?.account ?? "-";
  const latency = route?.latency !== undefined ? `${route.latency}ms（首字延迟）` : "-";
  const statsLine = model ? formatStats(stats.alias(model.id)) : "-";
  const attemptStats = route ? stats.lineAttempts(route.lineId, route.account) : undefined;
  const usageLine = route ? formatAttemptUsage(attemptStats) : "暂无成本观测";
  const diagnosticsLine = route ? formatAttemptDiagnostics(attemptStats) : "暂无故障诊断";
  const health = aliasProvider.healthSummary();
  const healthLine = `熔断中: ${health.open}/${health.total}`;

  console.log(
    `[pi-switch] status: model=${modelLabel} provider=${provider} account=${account} latency=${latency} health=${healthLine} stats=${statsLine} usage=${usageLine} diagnostics=${diagnosticsLine}`,
  );
  ctx.ui.notify(
    `模型: ${modelLabel} · Provider: ${provider} · 账号: ${account} · 延迟: ${latency} · ${healthLine} · ${statsLine} · ${usageLine} · ${diagnosticsLine}`,
    "info",
  );
}

function showProviders(
  ctx: ExtensionCommandContext,
  resolver: ModelResolver,
  accounts: AccountManager,
): void {
  const aliases = resolver.listAliases();
  if (aliases.length === 0) {
    ctx.ui.notify("尚未配置模型别名，请使用 /config models 添加", "warning");
    return;
  }
  console.log("[pi-switch] providers:");
  for (const alias of aliases) {
    const bindings = resolver.resolve(alias);
    console.log(`  ${alias} (${resolver.get(alias)?.displayName ?? alias})`);
    for (const b of bindings) {
      const accs = accounts.forProvider(b.provider, b.accountNames);
      if (accs.length === 0) {
        console.log(`    -> ${b.provider}/${b.model}${b.apiKey ? " [key]" : " [NO KEY]"}`);
      } else {
        for (const acc of accs) {
          console.log(
            `    -> ${b.provider}/${acc.name}/${b.model}${acc.apiKey ? " [key]" : " [NO KEY]"}`,
          );
        }
      }
    }
  }
  ctx.ui.notify(`已列出 ${aliases.length} 个模型别名，请查看控制台输出`, "info");
}

function showCheck(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
  resolver: ModelResolver,
  accounts: AccountManager,
  aliasProvider: AliasProvider,
): void {
  const aliases = resolver.listAliases();
  let issues = 0;
  console.log("[pi-switch] check:");
  for (const alias of aliases) {
    const bindings = resolver.resolve(alias);
    let ready = 0;
    for (const binding of bindings) {
      const configuredPool = binding.accountNames !== undefined || accounts.hasAccounts(binding.provider);
      const usableAccounts = accounts.forProvider(binding.provider, binding.accountNames);
      if (configuredPool ? usableAccounts.length > 0 : Boolean(binding.apiKey)) ready += 1;
    }
    if (ready === 0) issues += 1;
    console.log(`  ${alias}: ${ready}/${bindings.length} usable binding(s)${ready ? "" : " [UNAVAILABLE]"}`);
  }
  for (const [name, provider] of Object.entries(store.get().providers)) {
    if (provider.enabled !== false && !provider.baseUrl) { issues += 1; console.log(`  provider ${name}: missing baseUrl`); }
  }
  for (const state of aliasProvider.healthSummary().lines) {
    const remaining = Math.max(0, (state.openUntil ?? 0) - Date.now());
    console.log(`  circuit ${state.key}: ${remaining > 0 ? `OPEN ${remaining}ms` : "closed"} · failures=${state.consecutiveFailures}`);
  }
  ctx.ui.notify(`检查完成：${aliases.length} 个别名，发现 ${issues} 个问题；详情请查看控制台`, issues ? "warning" : "info");
}

async function showProbe(ctx: ExtensionCommandContext, store: ConfigStore): Promise<void> {
  const providers = Object.entries(store.get().providers).filter(([, provider]) => provider.enabled !== false);
  if (providers.length === 0) {
    ctx.ui.notify("没有已启用、可供探测的 Provider", "warning");
    return;
  }
  ctx.ui.notify(`正在探测 ${providers.length} 个 Provider...`, "info");
  const results = await Promise.all(
    providers.map(([name, provider]) => probeProvider(name, provider, AbortSignal.timeout(10_000))),
  );
  console.log("[pi-switch] probe:");
  for (const result of results) {
    console.log(`  ${result.provider}: ${result.ok ? "OK" : "FAIL"} · ${result.latencyMs}ms${result.status ? ` · HTTP ${result.status}` : ""}${result.modelCount !== undefined ? ` · ${result.modelCount} models` : ""}${result.error ? ` · ${result.error}` : ""}`);
  }
  const ok = results.filter((result) => result.ok).length;
  ctx.ui.notify(`探测完成：${ok}/${results.length} 个 Provider 可访问；详情请查看控制台`, ok === results.length ? "info" : "warning");
}
