import type { FailureCostPolicy, PiSwitchConfig, RoutingStrategy, BalanceScope } from "./loader";
import { inferApi, isSupportedApi } from "../provider/transport";

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const STRATEGIES = new Set<RoutingStrategy>(["priority", "failover", "balance"]);
const BALANCE_SCOPES = new Set<BalanceScope>(["session", "request"]);
const FAILURE_COST_POLICIES = new Set<FailureCostPolicy>(["availability", "balanced", "economy"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const INPUT_MODALITIES = new Set(["text", "image"]);
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const BOOLEAN_COMPAT_FIELDS = new Set([
  "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
  "supportsFinishReason", "requiresToolResultName", "requiresAssistantAfterToolResult", "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages", "zaiToolStream", "supportsThinkingTokenBudget",
  "supportsOpenAIGrammarTools", "supportsStrictMode", "sendSessionAffinityHeaders", "supportsLongCacheRetention",
  "supportsToolSearch", "supportsExplicitPromptCacheMode", "supportsEagerToolInputStreaming",
  "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature",
  "supportsStrictTools", "supportsToolReferences",
]);

const COMPAT_FIELDS: Record<string, Set<string>> = {
  "openai-completions": new Set([
    "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort", "supportsUsageInStreaming",
    "supportsFinishReason", "maxTokensField", "requiresToolResultName", "requiresAssistantAfterToolResult",
    "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages", "thinkingFormat", "chatTemplateKwargs",
    "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting", "zaiToolStream", "supportsThinkingTokenBudget",
    "supportsOpenAIGrammarTools", "supportsStrictMode", "cacheControlFormat", "sendSessionAffinityHeaders",
    "deferredToolsMode", "sessionAffinityFormat", "supportsLongCacheRetention",
  ]),
  "openai-responses": new Set([
    "supportsDeveloperRole", "sessionAffinityFormat", "supportsLongCacheRetention", "supportsStrictMode",
    "supportsOpenAIGrammarTools", "supportsToolSearch", "supportsExplicitPromptCacheMode",
  ]),
  "anthropic-messages": new Set([
    "supportsEagerToolInputStreaming", "supportsLongCacheRetention", "sendSessionAffinityHeaders",
    "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature",
    "supportsStrictTools", "supportsToolReferences",
  ]),
  "google-generative-ai": new Set(),
};

function validateApi(value: unknown, path: string, errors: string[]): void {
  if (value !== undefined && (typeof value !== "string" || !isSupportedApi(value))) {
    errors.push(`${path}: expected openai-completions, openai-responses, anthropic-messages, or google-generative-ai`);
  }
}

function validateStringRecord(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object containing string values`);
    return;
  }
  const headerName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  for (const [key, item] of Object.entries(value)) {
    if (!headerName.test(key)) errors.push(`${path}.${key || "(empty)"}: expected a valid HTTP header name`);
    if (typeof item !== "string") errors.push(`${path}.${key || "(empty)"}: expected string`);
  }
}

function positiveSafeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateInput(value: unknown, path: string, errors: string[], warnings: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !INPUT_MODALITIES.has(item))) {
    errors.push(`${path}: expected a non-empty array containing only "text" and/or "image"`);
    return;
  }
  if (new Set(value).size !== value.length) warnings.push(`${path}: contains duplicate modalities`);
}

function validateCost(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object with input, output, cacheRead, and cacheWrite rates`);
    return;
  }
  for (const field of COST_FIELDS) {
    const rate = value[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      errors.push(`${path}.${field}: expected a non-negative finite number`);
    }
  }
}

function validateModelMetadata(
  value: Record<string, unknown>,
  path: string,
  errors: string[],
  warnings: string[],
): void {
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") {
    errors.push(`${path}.reasoning: expected boolean`);
  }
  validateInput(value.input, `${path}.input`, errors, warnings);
  validateCost(value.cost, `${path}.cost`, errors);
  for (const field of ["contextWindow", "maxTokens"] as const) {
    if (value[field] !== undefined && !positiveSafeInteger(value[field])) {
      errors.push(`${path}.${field}: expected a positive safe integer`);
    }
  }
  if (positiveSafeInteger(value.contextWindow) && positiveSafeInteger(value.maxTokens)
      && (value.maxTokens as number) > (value.contextWindow as number)) {
    warnings.push(`${path}.maxTokens: exceeds contextWindow`);
  }
}

function validateCompat(
  value: unknown,
  api: string | undefined,
  path: string,
  errors: string[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  const allowed = api ? COMPAT_FIELDS[api] : undefined;
  if (!allowed) return;
  for (const [field, item] of Object.entries(value)) {
    if (!allowed.has(field)) {
      warnings.push(`${path}.${field}: not recognized for ${api}`);
      continue;
    }
    if (BOOLEAN_COMPAT_FIELDS.has(field) && typeof item !== "boolean") {
      errors.push(`${path}.${field}: expected boolean`);
    }
  }
  const enums: Record<string, readonly string[]> = {
    maxTokensField: ["max_completion_tokens", "max_tokens"],
    thinkingFormat: ["openai", "openrouter", "deepseek", "together", "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking", "ant-ling"],
    cacheControlFormat: ["anthropic"],
    deferredToolsMode: ["kimi"],
    sessionAffinityFormat: ["openai", "openai-nosession", "openrouter"],
  };
  for (const [field, choices] of Object.entries(enums)) {
    const item = value[field];
    if (item !== undefined && (typeof item !== "string" || !choices.includes(item))) {
      errors.push(`${path}.${field}: expected one of ${choices.join(", ")}`);
    }
  }
  for (const field of ["chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting"] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) errors.push(`${path}.${field}: expected an object`);
  }
}

function validateThinkingLevelMap(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${path}: expected an object`);
    return;
  }
  for (const [level, mapped] of Object.entries(value)) {
    if (!THINKING_LEVELS.has(level) || (mapped !== null && (typeof mapped !== "string" || !mapped.trim()))) {
      errors.push(`${path}.${level}: expected a supported level mapped to a non-empty string or null`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate all configuration sections and their cross-references. */
export function validateConfig(config: PiSwitchConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const configuredProviders = isRecord(config.providers) ? config.providers : {};
  const providerEntries = isRecord(config.providers)
    ? Object.entries(config.providers)
    : (errors.push("providers.json: expected an object"), []);
  const accountEntries = isRecord(config.accounts)
    ? Object.entries(config.accounts)
    : (errors.push("accounts.json: expected an object"), []);
  const modelEntries = isRecord(config.models)
    ? Object.entries(config.models)
    : (errors.push("models.json: expected an object"), []);

  for (const [name, raw] of providerEntries) {
    const path = `providers.json:${name}`;
    if (!name.trim()) errors.push(`${path}: provider name must not be empty`);
    if (!isRecord(raw)) {
      errors.push(`${path}: expected an object`);
      continue;
    }
    if (raw.name !== undefined && (typeof raw.name !== "string" || !raw.name.trim())) errors.push(`${path}.name: expected a non-empty string`);
    if (typeof raw.type !== "string" || !raw.type.trim()) errors.push(`${path}.type: expected a non-empty string`);
    if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) {
      errors.push(`${path}.baseUrl: expected a non-empty URL`);
    } else {
      try {
        const url = new URL(raw.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
      } catch {
        errors.push(`${path}.baseUrl: expected an http(s) URL`);
      }
    }
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push(`${path}.enabled: expected boolean`);
    if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") errors.push(`${path}.apiKey: expected string`);
    validateApi(raw.api, `${path}.api`, errors);
    const inferredApi = typeof raw.type === "string" ? inferApi(raw.type, typeof raw.api === "string" ? raw.api as never : undefined) : undefined;
    if (inferredApi && !isSupportedApi(inferredApi)) errors.push(`${path}: unsupported protocol "${inferredApi}"`);
    if (raw.authHeader !== undefined && typeof raw.authHeader !== "boolean") errors.push(`${path}.authHeader: expected boolean`);
    if (raw.authProvider !== undefined && (typeof raw.authProvider !== "string" || !raw.authProvider.trim())) {
      errors.push(`${path}.authProvider: expected a non-empty string`);
    }
    validateCompat(raw.compat, inferredApi, `${path}.compat`, errors, warnings);
    if (raw.discoverModels !== undefined && typeof raw.discoverModels !== "boolean") {
      errors.push(`${path}.discoverModels: expected boolean`);
    }
    validateStringRecord(raw.headers, `${path}.headers`, errors);
    for (const field of ["modelInclude", "modelExclude"] as const) {
      const value = raw[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))) {
        errors.push(`${path}.${field}: expected an array of non-empty strings`);
      } else if (Array.isArray(value) && new Set(value).size !== value.length) {
        warnings.push(`${path}.${field}: contains duplicate patterns`);
      }
    }
    if (raw.modelDefaults !== undefined) {
      if (!isRecord(raw.modelDefaults)) errors.push(`${path}.modelDefaults: expected an object`);
      else validateModelMetadata(raw.modelDefaults, `${path}.modelDefaults`, errors, warnings);
    }
    if (raw.models !== undefined && !Array.isArray(raw.models)) errors.push(`${path}.models: expected an array`);
    if (Array.isArray(raw.models)) {
      const modelIds = new Set<string>();
      raw.models.forEach((model, index) => {
        const modelPath = `${path}.models[${index}]`;
        if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) {
          errors.push(`${modelPath}.id: expected a non-empty string`);
          return;
        }
        if (modelIds.has(model.id)) errors.push(`${modelPath}.id: duplicate model id "${model.id}"`);
        else modelIds.add(model.id);
        if (model.name !== undefined && (typeof model.name !== "string" || !model.name.trim())) {
          errors.push(`${modelPath}.name: expected a non-empty string`);
        }
        validateModelMetadata(model, modelPath, errors, warnings);
        validateApi(model.api, `${modelPath}.api`, errors);
        const modelApi = typeof model.api === "string" ? model.api : inferredApi;
        validateCompat(model.compat, modelApi, `${modelPath}.compat`, errors, warnings);
        validateThinkingLevelMap(model.thinkingLevelMap, `${modelPath}.thinkingLevelMap`, errors);
      });
    }
  }

  for (const [name, raw] of accountEntries) {
    const path = `accounts.json:${name}`;
    if (!name.trim()) errors.push(`${path}: account name must not be empty`);
    if (!isRecord(raw)) {
      errors.push(`${path}: expected an object`);
      continue;
    }
    if (typeof raw.provider !== "string" || !raw.provider.trim()) {
      errors.push(`${path}.provider: expected a non-empty string`);
    } else if (!configuredProviders[raw.provider]) {
      errors.push(`${path}.provider: provider "${raw.provider}" does not exist`);
    }
    if (typeof raw.apiKey !== "string" || !raw.apiKey.trim()) errors.push(`${path}.apiKey: expected a non-empty string`);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") errors.push(`${path}.enabled: expected boolean`);
    if (raw.priority !== undefined && !finiteNumber(raw.priority)) errors.push(`${path}.priority: expected a finite number`);
    if (raw.stats !== undefined && !isRecord(raw.stats)) errors.push(`${path}.stats: expected an object`);
  }

  const declaredLineIds = new Map<string, string>();
  for (const [alias, raw] of modelEntries) {
    const path = `models.json:${alias}`;
    if (!alias.trim()) errors.push(`${path}: alias name must not be empty`);
    if (!isRecord(raw)) {
      errors.push(`${path}: expected an object`);
      continue;
    }
    if (raw.displayName !== undefined && (typeof raw.displayName !== "string" || !raw.displayName.trim())) {
      errors.push(`${path}.displayName: expected a non-empty string`);
    }
    if (raw.strategy !== undefined && (typeof raw.strategy !== "string" || !STRATEGIES.has(raw.strategy as RoutingStrategy))) {
      errors.push(`${path}.strategy: expected priority, failover, or balance`);
    }
    validateModelMetadata(raw, path, errors, warnings);
    if (!Array.isArray(raw.providers) || raw.providers.length === 0) {
      errors.push(`${path}.providers: expected at least one provider binding`);
      continue;
    }
    const bindingSignatures = new Set<string>();
    raw.providers.forEach((binding, index) => {
      const bindingPath = `${path}.providers[${index}]`;
      if (!isRecord(binding)) {
        errors.push(`${bindingPath}: expected an object`);
        return;
      }
      if (binding.id !== undefined && (typeof binding.id !== "string" || !binding.id.trim())) {
        errors.push(`${bindingPath}.id: expected a non-empty string`);
      } else if (typeof binding.id === "string") {
        const previous = declaredLineIds.get(binding.id);
        if (previous) errors.push(`${bindingPath}.id: duplicate line id "${binding.id}" (already used by ${previous})`);
        else declaredLineIds.set(binding.id, bindingPath);
      }
      if (binding.authProvider !== undefined && (typeof binding.authProvider !== "string" || !binding.authProvider.trim())) {
        errors.push(`${bindingPath}.authProvider: expected a non-empty string`);
      }
      if (typeof binding.provider !== "string" || !binding.provider.trim()) {
        errors.push(`${bindingPath}.provider: expected a non-empty string`);
      } else {
        const provider = configuredProviders[binding.provider];
        if (!provider) {
          errors.push(`${bindingPath}.provider: provider "${binding.provider}" does not exist`);
        } else {
          const api = inferApi(provider.type, typeof binding.api === "string" ? binding.api as never : provider.api);
          if (!isSupportedApi(api)) errors.push(`${bindingPath}.api: unsupported protocol "${api}"`);
        }
      }
      if (typeof binding.model !== "string" || !binding.model.trim()) {
        errors.push(`${bindingPath}.model: expected a non-empty string`);
      }
      if (typeof binding.provider === "string" && typeof binding.model === "string") {
        const signature = `${binding.provider}\u0000${binding.model}\u0000${String(binding.api ?? "")}\u0000${String(binding.baseUrl ?? "")}`;
        if (bindingSignatures.has(signature)) warnings.push(`${bindingPath}: duplicates an earlier provider/model binding`);
        else bindingSignatures.add(signature);
      }
      validateApi(binding.api, `${bindingPath}.api`, errors);
      if (binding.baseUrl !== undefined) {
        if (typeof binding.baseUrl !== "string") errors.push(`${bindingPath}.baseUrl: expected an http(s) URL`);
        else {
          try {
            const url = new URL(binding.baseUrl);
            if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported");
          } catch { errors.push(`${bindingPath}.baseUrl: expected an http(s) URL`); }
        }
      }
      validateStringRecord(binding.headers, `${bindingPath}.headers`, errors);
      const provider = typeof binding.provider === "string" ? configuredProviders[binding.provider] : undefined;
      const effectiveApi = provider
        ? inferApi(provider.type, typeof binding.api === "string" ? binding.api as never : provider.api)
        : undefined;
      validateCompat(binding.compat, effectiveApi, `${bindingPath}.compat`, errors, warnings);
      validateThinkingLevelMap(binding.thinkingLevelMap, `${bindingPath}.thinkingLevelMap`, errors);
      if (binding.priority !== undefined && !finiteNumber(binding.priority)) {
        errors.push(`${bindingPath}.priority: expected a finite number`);
      }
    });
  }

  const routing = config.routing as unknown;
  if (!isRecord(routing)) {
    errors.push("routing.json: expected an object");
  } else {
    if (routing.strategy !== undefined && (typeof routing.strategy !== "string" || !STRATEGIES.has(routing.strategy as RoutingStrategy))) {
      errors.push("routing.json:strategy: expected priority, failover, or balance");
    }
    if (routing.balanceScope !== undefined && (typeof routing.balanceScope !== "string" || !BALANCE_SCOPES.has(routing.balanceScope as BalanceScope))) {
      errors.push("routing.json:balanceScope: expected session or request");
    }
    if (routing.failureCostPolicy !== undefined && (typeof routing.failureCostPolicy !== "string" || !FAILURE_COST_POLICIES.has(routing.failureCostPolicy as FailureCostPolicy))) {
      errors.push("routing.json:failureCostPolicy: expected availability, balanced, or economy");
    }
    for (const field of ["maxAttempts", "maxHighCostFailovers"] as const) {
      const value = routing[field];
      if (value !== undefined && !positiveSafeInteger(value)) {
        errors.push(`routing.json:${field}: expected a positive safe integer`);
      }
    }
    if (routing.failoverOnUnknown !== undefined && typeof routing.failoverOnUnknown !== "boolean") {
      errors.push("routing.json:failoverOnUnknown: expected boolean");
    }
    if (routing.failureThreshold !== undefined && !positiveSafeInteger(routing.failureThreshold)) {
      errors.push("routing.json:failureThreshold: expected a positive safe integer");
    }
    for (const field of ["cooldownMs", "rateLimitCooldownMs"] as const) {
      const value = routing[field];
      if (value !== undefined && !positiveSafeInteger(value)) {
        errors.push(`routing.json:${field}: expected a positive safe integer`);
      }
    }
  }

  return { errors, warnings };
}

export function reportValidation(result: ValidationResult): void {
  for (const error of result.errors) console.error(`[pi-switch] config error: ${error}`);
  for (const warning of result.warnings) console.warn(`[pi-switch] config warning: ${warning}`);
}
