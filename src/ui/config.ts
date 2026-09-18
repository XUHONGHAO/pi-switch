/**
 * /config command (Phase 8: TUI configuration UI)
 *
 *   /config                 main menu (Provider / aliases / accounts / strategy)
 *   /config providers       list & edit providers
 *   /config add-provider    guided provider wizard
 *   /config models          list & edit aliases + their lines
 *   /config accounts        list & edit key-pool accounts
 *   /config strategy <s>    set routing strategy (priority|failover|balance)
 *   /config reload          re-read config from disk (hot reload)
 *   /config help            show usage
 *
 * Edits accumulate in memory and are only persisted when the user confirms
 * "save & reload": saveSection() writes the JSON file, ConfigStore.reload()
 * re-reads it, and reloadAll() re-registers providers + alias provider so
 * the change takes effect without restarting pi.
 *
 * Non-TUI environments (print/rpc mode) cannot show dialogs: those fall back
 * to a console help message.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore, ConfigSection } from "../config/store";
import type {
  AccountConfig,
  ModelAliasConfig,
  ModelProviderBinding,
  PiSwitchConfig,
  ProviderConfig,
  RoutingStrategy,
} from "../config/loader";
import { validateConfig } from "../config/validate";

/** Re-registration callback wired up by index.ts after a config change. */
export interface ConfigCommandDeps {
  store: ConfigStore;
  reloadAll: () => Promise<void>;
}

export function registerConfigCommand(pi: ExtensionAPI, deps: ConfigCommandDeps): void {
  pi.registerCommand("config", {
    description: "配置 pi-switch 的 Provider、模型别名、账号和路由策略",
    handler: async (args, ctx) => {
      const arg = args?.trim() ?? "";

      if (arg === "help" || arg === "?") return showHelp(ctx);
      if (arg === "reload") return doReload(ctx, deps);
      if (arg.startsWith("strategy")) {
        const strategy = arg.slice("strategy".length).trim() as RoutingStrategy;
        if (isStrategy(strategy)) return setStrategy(ctx, deps, strategy);
        return showHelp(ctx);
      }
      if (arg === "providers") return providersMenu(ctx, deps);
      if (arg === "add-provider") return addProviderWizard(ctx, deps);
      if (arg === "models") return modelsMenu(ctx, deps);
      if (arg === "accounts") return accountsMenu(ctx, deps);
      if (arg) return showHelp(ctx);
      return mainMenu(ctx, deps);
    },
  });
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

async function askInput(ctx: ExtensionCommandContext, title: string, current?: string): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.input(title, current ?? "");
}

async function askSelect(ctx: ExtensionCommandContext, title: string, options: string[]): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.select(title, options);
}

async function askConfirm(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
  if (!ctx.hasUI) return false;
  // Use a selector instead of ui.confirm so the safe choice is selected by default.
  const choice = await askSelect(ctx, `${title}\n${message}`, ["否（取消）", "是（确认）"]);
  return choice === "是（确认）";
}

/** Mask an api key for display: sk-****last4 (or $ENV_VAR untouched). */
function maskKey(key: string | undefined): string {
  if (!key) return "(未设置)";
  const ref = key.match(/^\$[\w-]+$/);
  if (ref) return key;
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

function splitPatterns(value: string): string[] | undefined {
  const patterns = value.split(",").map((item) => item.trim()).filter(Boolean);
  return patterns.length > 0 ? patterns : undefined;
}

function isStrategy(s: string): s is RoutingStrategy {
  return s === "priority" || s === "failover" || s === "balance";
}

const STRATEGY_LABELS: Record<RoutingStrategy, string> = {
  priority: "priority（仅用最高优先级线路，失败不切换）",
  failover: "failover（失败时自动切换线路）",
  balance: "balance（默认会话级均衡；可配置逐请求轮询）",
};

function strategyFromLabel(label: string): RoutingStrategy | undefined {
  return (Object.entries(STRATEGY_LABELS) as Array<[RoutingStrategy, string]>)
    .find(([, value]) => value === label)?.[0];
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const CONTEXT_WINDOW_PRESETS = {
  default: "200K（200,000 Token，默认值）",
  large: "1M（1,000,000 Token）",
  custom: "自定义",
} as const;

function formatContextWindow(value: number | undefined): string {
  return value === undefined || value === DEFAULT_CONTEXT_WINDOW
    ? "200,000 Token（默认值）"
    : `${value.toLocaleString("en-US")} Token`;
}

async function editContextWindow(
  ctx: ExtensionCommandContext,
  alias: ModelAliasConfig,
): Promise<void> {
  const choice = await askSelect(ctx, "contextWindow（上下文窗口）", [
    CONTEXT_WINDOW_PRESETS.default,
    CONTEXT_WINDOW_PRESETS.large,
    CONTEXT_WINDOW_PRESETS.custom,
    "取消",
  ]);
  if (!choice || choice === "取消") return;
  if (choice === CONTEXT_WINDOW_PRESETS.default) {
    delete alias.contextWindow;
    return;
  }
  if (choice === CONTEXT_WINDOW_PRESETS.large) {
    alias.contextWindow = 1_000_000;
    return;
  }

  let current = alias.contextWindow ? String(alias.contextWindow) : String(DEFAULT_CONTEXT_WINDOW);
  // 输入错误时保留在自定义输入步骤，避免新增别名静默回退到默认值。
  while (true) {
    const input = (await askInput(
      ctx,
      "contextWindow（上下文窗口，单位 Token；请输入正整数）",
      current,
    ))?.trim();
    if (input === undefined) return;
    const value = Number(input);
    if (Number.isSafeInteger(value) && value > 0) {
      alias.contextWindow = value;
      return;
    }
    ctx.ui.notify("contextWindow（上下文窗口）必须是正整数，请重新输入", "warning");
    current = input;
  }
}

async function editThinkingLevelMap(
  ctx: ExtensionCommandContext,
  binding: ModelProviderBinding,
): Promise<void> {
  if (!ctx.hasUI) return;
  
  const choice = await askSelect(ctx, "思考级别映射配置", [
    "使用标准映射（推荐）",
    "清除映射",
    "取消",
  ]);
  
  if (!choice || choice === "取消") return;
  
  if (choice === "清除映射") {
    delete binding.thinkingLevelMap;
    ctx.ui.notify("已清除思考级别映射", "info");
    return;
  }
  
  if (choice === "使用标准映射（推荐）") {
    binding.thinkingLevelMap = {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "high",
    };
    ctx.ui.notify("已应用标准思考级别映射", "info");
    return;
  }
}

function sectionLabel(section: ConfigSection): string {
  return `${section}.json`;
}

async function askProviderKey(
  ctx: ExtensionCommandContext,
  providers: Record<string, ProviderConfig>,
  title = "选择线路 Provider",
): Promise<string | undefined> {
  const names = Object.keys(providers);
  if (names.length === 0) {
    ctx.ui.notify("尚未添加 Provider，请先在 Providers 管理中添加", "warning");
    return undefined;
  }
  return askSelect(ctx, title, names);
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

async function mainMenu(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  // Keep the command alive while navigating. A child menu returning means
  // "back to parent"; only cancelling this root selector exits /config.
  while (true) {
    const choice = await askSelect(ctx, "pi-switch 配置", [
      "Provider 管理",
      "模型别名",
      "账号（API Key 池）",
      "路由策略",
      "重载配置（reload）",
      "帮助",
    ]);
    if (!choice) return;
    switch (choice) {
      case "Provider 管理": await providersMenu(ctx, deps); break;
      case "模型别名": await modelsMenu(ctx, deps); break;
      case "账号（API Key 池）": await accountsMenu(ctx, deps); break;
      case "路由策略": await strategyMenu(ctx, deps); break;
      case "重载配置（reload）": await doReload(ctx, deps); break;
      case "帮助": showHelp(ctx); break;
    }
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function providersMenu(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  while (true) {
    const config = deps.store.get();
    const names = Object.keys(config.providers);
    const options = [...names, "新增 Provider", "返回"];
    const pick = await askSelect(ctx, `Provider（${names.length} 个）`, options);
    if (!pick || pick === "返回") return;
    if (pick === "新增 Provider") await addProviderWizard(ctx, deps);
    else await editProvider(ctx, deps, pick);
  }
}

async function editProvider(ctx: ExtensionCommandContext, deps: ConfigCommandDeps, name: string): Promise<void> {
  const config = deps.store.get();
  const provider: ProviderConfig = { ...(config.providers[name] ?? { type: "openai", baseUrl: "" }) };
  let dirty = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!ctx.hasUI) return showHelp(ctx);
    const options = [
      `接口协议: ${provider.api ?? provider.type}`,
      `接口地址（baseUrl）: ${provider.baseUrl || "(未设置)"}`,
      `API Key: ${maskKey(provider.apiKey)}`,
      ...(provider.apiKey ? ["清除 API Key"] : []),
      `是否启用: ${provider.enabled === false ? "否" : "是"}`,
      `自动发现模型: ${provider.discoverModels === false ? "关闭" : provider.discoverModels === true ? "开启" : "自动（仅 OpenAI Completions 默认开启）"}`,
      `包含模型规则: ${provider.modelInclude?.join(", ") || "(全部)"}`,
      `排除模型规则: ${provider.modelExclude?.join(", ") || "(无)"}`,
      "保存并重载",
      "删除此 Provider",
      "取消",
    ];
    const pick = await askSelect(ctx, `Provider: ${name}`, options);
    if (!pick || pick === "取消") return;

    if (pick.startsWith("接口协议")) {
      const value = await askSelect(ctx, "协议", ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
      if (value) {
        provider.api = value as ProviderConfig["api"];
        provider.type = value === "anthropic-messages" ? "anthropic" : value === "google-generative-ai" ? "gemini" : value;
        dirty = true;
      }
    } else if (pick.startsWith("接口地址")) {
      const value = await askInput(ctx, "baseUrl（含 /v1，如 https://api.openai.com/v1）", provider.baseUrl);
      if (value !== undefined) { provider.baseUrl = value.trim(); dirty = true; }
    } else if (pick.startsWith("API Key")) {
      const value = await askInput(ctx, "API Key、$环境变量 或 !命令（留空 = 不变）", "");
      if (value !== undefined && value.trim() !== "") {
        provider.apiKey = value.trim();
        dirty = true;
      }
    } else if (pick === "清除 API Key") {
      delete provider.apiKey;
      dirty = true;
    } else if (pick.startsWith("是否启用")) {
      const value = await askSelect(ctx, "是否启用此 Provider？", ["是", "否"]);
      if (value) { provider.enabled = value === "是" ? true : false; dirty = true; }
    } else if (pick.startsWith("自动发现模型")) {
      const value = await askSelect(ctx, "是否自动发现模型？", ["自动（默认，OpenAI 兼容接口会自动发现）", "开启", "关闭"]);
      if (value === "开启") { provider.discoverModels = true; dirty = true; }
      else if (value === "关闭") { provider.discoverModels = false; dirty = true; }
      else if (value?.startsWith("自动")) { delete provider.discoverModels; dirty = true; }
    } else if (pick.startsWith("包含模型规则")) {
      const value = await askInput(ctx, "包含模型的匹配规则（glob），多个规则用逗号分隔；留空 = 全部", provider.modelInclude?.join(", ") ?? "");
      if (value !== undefined) { provider.modelInclude = splitPatterns(value); dirty = true; }
    } else if (pick.startsWith("排除模型规则")) {
      const value = await askInput(ctx, "排除模型的匹配规则（glob），多个规则用逗号分隔", provider.modelExclude?.join(", ") ?? "");
      if (value !== undefined) { provider.modelExclude = splitPatterns(value); dirty = true; }
    } else if (pick === "删除此 Provider") {
      await deleteProvider(ctx, deps, name);
      return;
    } else if (pick === "保存并重载") {
      const next = { ...config.providers, [name]: provider };
      await saveAndReload(ctx, deps, "providers", next, `Provider "${name}" 已保存`);
      return;
    }
  }
}

async function addProviderWizard(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  const config = deps.store.get();

  const name = (await askInput(ctx, "Provider 标识（key，如 sub2api）"))?.trim();
  if (!name) return;
  if (config.providers[name]) {
    ctx.ui.notify(`Provider "${name}" 已存在`, "warning");
    return;
  }
  const baseUrl = (await askInput(ctx, "baseUrl（含 /v1）"))?.trim();
  if (!baseUrl) return;

  const apiPick = await askSelect(ctx, "协议", ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
  const api = (apiPick ?? "openai-completions") as NonNullable<ProviderConfig["api"]>;
  const type: ProviderConfig["type"] = api === "anthropic-messages" ? "anthropic" : api === "google-generative-ai" ? "gemini" : api;

  const apiKey = (await askInput(ctx, "API Key、$环境变量 或 !命令（可留空，之后可使用 /login）"))?.trim();
  const discoverPick = await askSelect(ctx, "是否自动发现模型？", ["自动（默认）", "开启", "关闭"]);

  const provider: ProviderConfig = { type, api, baseUrl, ...(apiKey ? { apiKey } : {}) };
  if (discoverPick === "开启") provider.discoverModels = true;
  else if (discoverPick === "关闭") provider.discoverModels = false;

  const next = { ...config.providers, [name]: provider };
  await saveAndReload(ctx, deps, "providers", next, `Provider "${name}" 已添加`);
}

// ---------------------------------------------------------------------------
// Models (aliases)
// ---------------------------------------------------------------------------

async function modelsMenu(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  while (true) {
    const config = deps.store.get();
    const aliases = Object.keys(config.models);
    const options = [...aliases.map((a) => `${a}${config.models[a]?.displayName ? ` (${config.models[a]!.displayName})` : ""}`), "新增别名", "返回"];
    const pick = await askSelect(ctx, `模型别名 (${aliases.length})`, options);
    if (!pick || pick === "返回") return;
    if (pick === "新增别名") {
      await addAliasWizard(ctx, deps);
      continue;
    }
    const alias = aliases.find((a) => pick === a || pick === `${a} (${config.models[a]?.displayName})`);
    if (alias) await editAlias(ctx, deps, alias);
  }
}

async function addAliasWizard(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  const config = deps.store.get();
  const name = (await askInput(ctx, "别名（如 gpt5）"))?.trim();
  if (!name) return;
  if (config.models[name]) {
    ctx.ui.notify(`别名 "${name}" 已存在`, "warning");
    return;
  }
  const displayName = (await askInput(ctx, "显示名称（如 GPT-5，可留空）"))?.trim();
  const providerKey = await askProviderKey(ctx, config.providers);
  if (!providerKey) return;
  const model = (await askInput(ctx, "模型 ID（发给该 Provider）"))?.trim();
  if (!model) return;

  const strategyPick = await askSelect(ctx, "路由策略", ["默认", ...Object.values(STRATEGY_LABELS)]);
  const strategy = strategyPick ? strategyFromLabel(strategyPick) : undefined;

  const reasoningPick = await askSelect(ctx, "是否支持思考（reasoning）？", ["否", "是"]);
  const reasoning = reasoningPick === "是" ? true : undefined;

  const alias: ModelAliasConfig = {
    ...(displayName ? { displayName } : {}),
    providers: [{ provider: providerKey, model }],
    ...(strategy ? { strategy } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
  await editContextWindow(ctx, alias);
  const next = { ...config.models, [name]: alias };
  await saveAndReload(ctx, deps, "models", next, `别名 "${name}" 已添加`);
}

async function editAlias(ctx: ExtensionCommandContext, deps: ConfigCommandDeps, alias: string): Promise<void> {
  const config = deps.store.get();
  const aliasCfg: ModelAliasConfig = { ...(config.models[alias] ?? {}), providers: [...(config.models[alias]?.providers ?? [])] };
  const providers = config.providers;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!ctx.hasUI) return showHelp(ctx);
    const lineOptions = (aliasCfg.providers ?? []).map(
      (b, i) => `${i + 1}. ${b.provider}/${b.model}${b.priority !== undefined ? ` (p${b.priority})` : ""}`,
    );
    const options = [
      ...lineOptions,
      "添加线路",
      `路由策略: ${aliasCfg.strategy ? STRATEGY_LABELS[aliasCfg.strategy] : "(默认)"}`,
      `显示名称: ${aliasCfg.displayName ?? "(无)"}`,
      `思考支持（reasoning）: ${aliasCfg.reasoning ? "是" : "否"}`,
      `contextWindow（上下文窗口）: ${formatContextWindow(aliasCfg.contextWindow)}`,
      "保存并重载",
      "删除此别名",
      "取消",
    ];
    const pick = await askSelect(ctx, `别名: ${alias}`, options);
    if (!pick || pick === "取消") return;

    const lineMatch = pick.match(/^(\d+)\. /);
    if (lineMatch) {
      await editLine(ctx, deps, aliasCfg, Number(lineMatch[1]) - 1);
    } else if (pick === "添加线路") {
      const providerKey = await askProviderKey(ctx, providers);
      if (!providerKey) continue;
      const model = (await askInput(ctx, "模型 ID"))?.trim();
      if (!model) continue;
      aliasCfg.providers ??= [];
      aliasCfg.providers.push({ provider: providerKey, model });
    } else if (pick.startsWith("路由策略")) {
      const value = await askSelect(ctx, "路由策略", ["(默认)", ...Object.values(STRATEGY_LABELS)]);
      if (value === "(默认)") delete aliasCfg.strategy;
      else if (value) {
        const strategy = strategyFromLabel(value);
        if (strategy) aliasCfg.strategy = strategy;
      }
    } else if (pick.startsWith("显示名称")) {
      const value = await askInput(ctx, "显示名称（留空 = 无）", aliasCfg.displayName ?? "");
      if (value !== undefined) {
        if (value.trim() === "") delete aliasCfg.displayName; else aliasCfg.displayName = value.trim();
      }
    } else if (pick.startsWith("思考支持")) {
      const value = await askSelect(ctx, "是否支持思考（reasoning）？", ["否", "是"]);
      if (value === "是") aliasCfg.reasoning = true;
      else delete aliasCfg.reasoning;
    } else if (pick.startsWith("contextWindow")) {
      await editContextWindow(ctx, aliasCfg);
    } else if (pick === "删除此别名") {
      const ok = await askConfirm(ctx, "删除别名", `确定删除 "${alias}"？`);
      if (ok) {
        const next = { ...config.models };
        delete next[alias];
        await saveAndReload(ctx, deps, "models", next, `别名 "${alias}" 已删除`);
        return;
      }
    } else if (pick === "保存并重载") {
      const next = { ...config.models, [alias]: aliasCfg };
      await saveAndReload(ctx, deps, "models", next, `别名 "${alias}" 已保存`);
      return;
    }
  }
}

async function editLine(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDeps,
  aliasCfg: ModelAliasConfig,
  index: number,
): Promise<void> {
  const binding = aliasCfg.providers?.[index];
  if (!binding) return;
  if (!ctx.hasUI) return showHelp(ctx);

  const options = [
    `所属 Provider: ${binding.provider}`,
    `模型 ID: ${binding.model}`,
    `线路优先级: ${binding.priority ?? "(默认)"}`,
    `账号范围: ${binding.accounts?.join(", ") ?? "Provider 全部账号"}`,
    `思考级别映射: ${binding.thinkingLevelMap ? "已配置" : "(未配置)"}`,
    "删除此线路",
    "返回",
  ];
  const pick = await askSelect(ctx, `线路: ${binding.provider}`, options);
  if (!pick || pick === "返回") return;
  if (pick.startsWith("所属 Provider")) {
    const value = await askProviderKey(ctx, deps.store.get().providers, "更换线路 Provider");
    if (value) binding.provider = value;
  } else if (pick.startsWith("模型 ID")) {
    const value = (await askInput(ctx, "模型 ID", binding.model))?.trim();
    if (value) binding.model = value;
  } else if (pick.startsWith("线路优先级")) {
    const value = (await askInput(ctx, "线路优先级（数字越小越优先；留空 = 默认）", binding.priority !== undefined ? String(binding.priority) : ""))?.trim();
    if (value === "") delete binding.priority;
    else if (value && !Number.isNaN(Number(value))) binding.priority = Number(value);
  } else if (pick.startsWith("账号范围")) {
    const current = binding.accounts?.join(", ") ?? "";
    const value = (await askInput(ctx, "账号范围（逗号分隔；留空 = Provider 全部账号）", current))?.trim();
    if (value === undefined) return;
    const names = splitPatterns(value);
    if (names) binding.accounts = names;
    else delete binding.accounts;
  } else if (pick.startsWith("思考级别映射")) {
    await editThinkingLevelMap(ctx, binding);
  } else if (pick === "删除此线路") {
    const ok = await askConfirm(ctx, "删除线路", `确定删除线路 "${binding.provider}/${binding.model}"？`);
    if (ok) aliasCfg.providers?.splice(index, 1);
  }
}

// ---------------------------------------------------------------------------
// Accounts (key pool)
// ---------------------------------------------------------------------------

async function accountsMenu(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  while (true) {
    const config = deps.store.get();
    const names = Object.keys(config.accounts);
    const options = [...names.map((n) => `${n} (${config.accounts[n].provider})`), "新增账号", "返回"];
    const pick = await askSelect(ctx, `账号 (${names.length})`, options);
    if (!pick || pick === "返回") return;
    if (pick === "新增账号") {
      await addAccountWizard(ctx, deps);
      continue;
    }
    const account = names.find((n) => pick === n || pick === `${n} (${config.accounts[n].provider})`);
    if (account) await editAccount(ctx, deps, account);
  }
}

async function addAccountWizard(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  const config = deps.store.get();
  const name = (await askInput(ctx, "账号名称（如 key_a）"))?.trim();
  if (!name) return;
  if (config.accounts[name]) {
    ctx.ui.notify(`账号 "${name}" 已存在`, "warning");
    return;
  }
  const providerKey = await askProviderKey(ctx, config.providers, "选择所属 Provider");
  if (!providerKey) return;
  const apiKey = (await askInput(ctx, "API Key、$环境变量 或 !命令"))?.trim();
  if (!apiKey) return;
  const priority = (await askInput(ctx, "账号优先级（数字越小越优先；留空 = 0）"))?.trim();

  const account: AccountConfig = { provider: providerKey, apiKey };
  if (priority && !Number.isNaN(Number(priority))) account.priority = Number(priority);

  const next = { ...config.accounts, [name]: account };
  await saveAndReload(ctx, deps, "accounts", next, `账号 "${name}" 已添加`);
}

async function editAccount(ctx: ExtensionCommandContext, deps: ConfigCommandDeps, name: string): Promise<void> {
  const config = deps.store.get();
  const account: AccountConfig = { ...(config.accounts[name] ?? { provider: "", apiKey: "" }) };
  let dirty = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!ctx.hasUI) return showHelp(ctx);
    const options = [
      `所属 Provider: ${account.provider}`,
      `API Key: ${maskKey(account.apiKey)}`,
      `账号优先级: ${account.priority ?? 0}`,
      `是否启用: ${account.enabled === false ? "否" : "是"}`,
      "保存并重载",
      "删除此账号",
      "取消",
    ];
    const pick = await askSelect(ctx, `账号: ${name}`, options);
    if (!pick || pick === "取消") return;

    if (pick.startsWith("所属 Provider")) {
      const value = await askProviderKey(ctx, config.providers, "更换所属 Provider");
      if (value) { account.provider = value; dirty = true; }
    } else if (pick.startsWith("API Key")) {
      const value = (await askInput(ctx, "API Key、$环境变量 或 !命令（留空 = 不变）", ""))?.trim();
      if (value) { account.apiKey = value; dirty = true; }
    } else if (pick.startsWith("账号优先级")) {
      const value = (await askInput(ctx, "账号优先级（数字越小越优先）", String(account.priority ?? 0)))?.trim();
      if (value && !Number.isNaN(Number(value))) { account.priority = Number(value); dirty = true; }
    } else if (pick.startsWith("是否启用")) {
      const value = await askSelect(ctx, "是否启用此账号？", ["是", "否"]);
      if (value) { account.enabled = value === "是" ? true : false; dirty = true; }
    } else if (pick === "删除此账号") {
      const ok = await askConfirm(ctx, "删除账号", `确定删除 "${name}"？`);
      if (ok) {
        const next = { ...config.accounts };
        delete next[name];
        await saveAndReload(ctx, deps, "accounts", next, `账号 "${name}" 已删除`);
        return;
      }
    } else if (pick === "保存并重载") {
      const next = { ...config.accounts, [name]: account };
      await saveAndReload(ctx, deps, "accounts", next, `账号 "${name}" 已保存`);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

async function strategyMenu(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  if (!ctx.hasUI) return showHelp(ctx);
  const current = deps.store.get().routing.strategy ?? "priority";
  const pick = await askSelect(ctx, `当前路由策略: ${STRATEGY_LABELS[current]}`, [...Object.values(STRATEGY_LABELS), "取消"]);
  if (!pick || pick === "取消") return;
  const strategy = strategyFromLabel(pick);
  if (strategy) await setStrategy(ctx, deps, strategy);
}

async function setStrategy(ctx: ExtensionCommandContext, deps: ConfigCommandDeps, strategy: RoutingStrategy): Promise<void> {
  // Merge into existing routing so failureThreshold / cooldownMs / rateLimitCooldownMs survive.
  const next = { ...deps.store.get().routing, strategy };
  await saveAndReload(ctx, deps, "routing", next, `路由策略已设为 ${STRATEGY_LABELS[strategy]}`);
}

/** Collect accounts / alias bindings that still reference a provider. */
export function providerDependents(config: PiSwitchConfig, name: string): {
  accounts: string[];
  aliases: Array<{ alias: string; bindings: number }>;
} {
  const accounts = Object.entries(config.accounts)
    .filter(([, account]) => account.provider === name)
    .map(([accountName]) => accountName);
  const aliases = Object.entries(config.models)
    .map(([alias, model]) => ({
      alias,
      bindings: (model.providers ?? []).filter((binding) => binding.provider === name).length,
    }))
    .filter((item) => item.bindings > 0);
  return { accounts, aliases };
}

/** Build the next config after cascading a provider deletion. */
export function cascadeDeleteProvider(config: PiSwitchConfig, name: string): {
  providers: Record<string, ProviderConfig>;
  accounts: Record<string, AccountConfig>;
  models: Record<string, ModelAliasConfig>;
} {
  const { accounts } = providerDependents(config, name);
  const providers = { ...config.providers };
  delete providers[name];

  const nextAccounts = { ...config.accounts };
  for (const account of accounts) delete nextAccounts[account];

  const models: Record<string, ModelAliasConfig> = {};
  for (const [alias, model] of Object.entries(config.models)) {
    const bindings = (model.providers ?? []).filter((binding) => binding.provider !== name);
    if (bindings.length === 0) continue; // drop aliases left with no bindings
    models[alias] = { ...model, providers: bindings };
  }
  return { providers, accounts: nextAccounts, models };
}

/** Delete a provider, optionally cascading dependent accounts / alias bindings. */
async function deleteProvider(ctx: ExtensionCommandContext, deps: ConfigCommandDeps, name: string): Promise<void> {
  const config = deps.store.get();
  const { accounts, aliases } = providerDependents(config, name);
  const dependencyLines = [
    ...accounts.map((account) => `账号 ${account}`),
    ...aliases.map((item) => `别名 ${item.alias}（${item.bindings} 条线路）`),
  ];

  if (dependencyLines.length === 0) {
    const ok = await askConfirm(ctx, "删除 Provider", `确定删除 "${name}"？`);
    if (!ok) return;
    const next = { ...config.providers };
    delete next[name];
    await saveAndReload(ctx, deps, "providers", next, `Provider "${name}" 已删除`);
    return;
  }

  const summary = dependencyLines.join("\n- ");
  const choice = await askSelect(ctx, `Provider "${name}" 仍被引用`, [
    "取消",
    "级联删除（一并清理引用）",
  ]);
  if (choice !== "级联删除（一并清理引用）") {
    ctx.ui.notify(`仍被以下配置引用，已取消删除:\n- ${summary}`, "warning");
    return;
  }

  const confirmed = await askConfirm(
    ctx,
    "级联删除 Provider",
    `将删除 "${name}" 并清理:\n- ${summary}\n\n确定继续？`,
  );
  if (!confirmed) return;

  const cascaded = cascadeDeleteProvider(config, name);
  const preview = {
    ...config,
    providers: cascaded.providers,
    accounts: cascaded.accounts,
    models: cascaded.models,
  };
  try {
    const validation = validateConfig(preview);
    if (validation.errors.length > 0) {
      throw new Error(`invalid configuration:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }
    // Clean dependents before removing the provider so each saveSection validates cleanly.
    await ctx.waitForIdle();
    deps.store.saveSection("accounts", cascaded.accounts);
    deps.store.saveSection("models", cascaded.models);
    deps.store.saveSection("providers", cascaded.providers);
    await deps.reloadAll();
    const message = `Provider "${name}" 已级联删除`;
    console.log(`[pi-switch] ${message}`);
    ctx.ui.notify(message, "info");
  } catch (err) {
    console.error(`[pi-switch] cascade delete failed: ${(err as Error).message}`);
    ctx.ui.notify(`删除失败: ${(err as Error).message}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Save / reload / help
// ---------------------------------------------------------------------------

async function saveAndReload(
  ctx: ExtensionCommandContext,
  deps: ConfigCommandDeps,
  section: ConfigSection,
  data: unknown,
  message: string,
): Promise<void> {
  try {
    await ctx.waitForIdle();
    deps.store.saveSection(section, data);
    await deps.reloadAll();
    console.log(`[pi-switch] ${message} (${sectionLabel(section)})`);
    ctx.ui.notify(`${message}`, "info");
  } catch (err) {
    console.error(`[pi-switch] save failed: ${(err as Error).message}`);
    ctx.ui.notify(`保存失败: ${(err as Error).message}`, "error");
  }
}

async function doReload(ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  try {
    await ctx.waitForIdle();
    await deps.reloadAll();
    console.log(`[pi-switch] config reloaded from ${deps.store.dir()}`);
    ctx.ui.notify("配置已重载", "info");
  } catch (err) {
    console.error(`[pi-switch] reload failed: ${(err as Error).message}`);
    ctx.ui.notify(`重载失败: ${(err as Error).message}`, "error");
  }
}

function showHelp(ctx: ExtensionCommandContext): void {
  const lines = [
    "[pi-switch] /config 用法:",
    "  /config                主菜单（TUI）",
    "  /config providers      管理 Provider",
    "  /config add-provider   向导式新增 Provider",
    "  /config models         管理模型别名与线路",
    "  /config accounts       管理账号（API Key 池）",
    "  /config strategy <s>   设置路由策略（priority / failover / balance）",
    "  /config reload         从磁盘重载配置",
    "  /config help           本帮助",
    `  配置文件目录: ~/.pi-switch（或 PI_SWITCH_CONFIG_DIR）`,
  ];
  console.log(lines.join("\n"));
  if (ctx.hasUI) {
    ctx.ui.notify("请使用 /config 主菜单（交互模式）", "info");
  }
}
