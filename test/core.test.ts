import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyError, canFailoverFor, extractUpstreamFailure } from "../src/errors/classify";
import type { PiSwitchConfig } from "../src/config/loader";
import { validateConfig } from "../src/config/validate";
import { ConfigStore } from "../src/config/store";
import { resolveConfigValue } from "../src/config/secret";
import { ModelResolver } from "../src/model/resolver";
import { Router } from "../src/router/router";
import { HealthManager, lineKey, parseRetryAfterHeader, parseRetryAfterMs } from "../src/router/health";
import { buildModelDefinition, filterModels } from "../src/provider/openai";
import { mergeStats, type StatsData } from "../src/stats/manager";
import type { ResolvedBinding } from "../src/model/resolver";
import { inferApi, isSupportedApi } from "../src/provider/transport";
import { cascadeDeleteProvider, providerDependents } from "../src/ui/config";

function config(overrides: Partial<PiSwitchConfig> = {}): PiSwitchConfig {
  return {
    configDir: "/tmp/pi-switch-test",
    providers: {},
    accounts: {},
    models: {},
    routing: {},
    stats: {},
    ...overrides,
  };
}

function binding(provider: string, priority = 0, accountPriority = 0): ResolvedBinding {
  return {
    lineId: `${provider}-line`,
    provider,
    model: "model",
    providerLabel: provider,
    authProvider: provider,
    type: "openai",
    api: "openai-completions",
    baseUrl: `https://${provider}.example/v1`,
    apiKey: "test",
    priority,
    accountPriority,
  };
}

describe("error classification", () => {
  it.each([
    ["request aborted", "aborted"],
    ["context_length_exceeded", "context-overflow"],
    ["HTTP 401 Unauthorized", "auth"],
    ["429 Too Many Requests", "rate-limit"],
    ["request timed out", "timeout"],
    ["503 Service Unavailable", "server"],
    ["400 Bad Request", "invalid-request"],
    ["ECONNREFUSED", "network"],
  ] as const)("classifies %s", (message, category) => {
    expect(classifyError(message)).toBe(category);
  });

  it("prefers structured HTTP metadata and extracts SDK status", () => {
    expect(classifyError("opaque provider failure", false, { status: 429 })).toBe("rate-limit");
    expect(classifyError("opaque provider failure", false, { status: 401 })).toBe("auth");
    expect(extractUpstreamFailure({ status: 503, headers: { "retry-after": "2" } }))
      .toEqual({ status: 503, headers: { "retry-after": "2" } });
  });

  it("does not fail over abort, overflow, or invalid requests", () => {
    expect(canFailoverFor("aborted")).toBe(false);
    expect(canFailoverFor("context-overflow")).toBe(false);
    expect(canFailoverFor("invalid-request")).toBe(false);
    expect(canFailoverFor("rate-limit")).toBe(true);
  });
});

describe("Router", () => {
  it("orders candidates by binding then account priority", () => {
    const store = { get: () => config({ routing: { strategy: "failover" } }) } as never;
    const selection = new Router(store).select("gpt", [
      binding("second", 2),
      binding("account-b", 1, 2),
      binding("account-a", 1, 1),
    ]);
    expect(selection.attempts.map((item) => item.provider)).toEqual(["account-a", "account-b", "second"]);
    expect(selection.canFailover).toBe(true);
  });

  it("rotates balance candidates", () => {
    const store = { get: () => config({ routing: { strategy: "balance" } }) } as never;
    const router = new Router(store);
    const candidates = [binding("a"), binding("b")];
    expect(router.select("gpt", candidates).binding.provider).toBe("a");
    expect(router.select("gpt", candidates).binding.provider).toBe("b");
  });
});

describe("v0.2 health routing", () => {
  it("opens a transient-failure circuit and restores it after cooldown", () => {
    const health = new HealthManager({ failureThreshold: 2, cooldownMs: 1000 });
    const line = binding("unstable");
    health.recordFailure(line, "server", "503");
    expect(health.available([line], 100)).toEqual([line]);
    health.recordFailure(line, "server", "503");
    const openUntil = health.state(line).openUntil!;
    expect(health.available([line], openUntil - 1)).toEqual([]);
    expect(health.available([line], openUntil)).toEqual([line]);
    health.recordSuccess(line);
    expect(health.state(line).consecutiveFailures).toBe(0);
  });

  it("applies Retry-After cooldowns", () => {
    expect(parseRetryAfterMs("429 retry-after: 1.5 seconds")).toBe(1500);
    expect(parseRetryAfterMs("retry-after=250ms")).toBe(250);
    expect(parseRetryAfterHeader("1.5")).toBe(1500);
    expect(parseRetryAfterHeader("Wed, 21 Oct 2015 07:28:00 GMT", Date.parse("Wed, 21 Oct 2015 07:27:58 GMT"))).toBe(2000);
    const health = new HealthManager();
    const line = binding("limited");
    health.recordFailure(line, "rate-limit", "429", 5000);
    expect((health.state(line).openUntil ?? 0) - Date.now()).toBeGreaterThan(4900);
  });

  it("isolates bindings from the same provider by line id", () => {
    const health = new HealthManager({ failureThreshold: 1, cooldownMs: 1000 });
    const first = binding("shared");
    first.lineId = "line-a";
    const second = { ...first, lineId: "line-b", model: "other" };
    health.recordFailure(first, "server", "503");
    expect(health.available([first, second])).toEqual([second]);
    expect(lineKey(first)).not.toBe(lineKey(second));
  });
});

describe("v0.2 model discovery", () => {
  it("filters models using include and exclude globs", () => {
    const models = ["gpt-4o", "gpt-4o-mini", "text-embedding-3"].map((id) => ({ id, name: id } as never));
    expect(filterModels(models, ["gpt-*"], ["*-mini"]).map((model) => model.id)).toEqual(["gpt-4o"]);
  });
});

describe("v0.2 stats merging", () => {
  it("merges process deltas without replacing existing counters", () => {
    const base: StatsData = {
      byAlias: { gpt: { requests: 2, successes: 2, failures: 0, failovers: 0, totalLatencyMs: 20 } },
      byProvider: {}, byAccount: {}, attemptsByLine: {}, updatedAt: 1,
    };
    const delta: StatsData = {
      byAlias: { gpt: { requests: 1, successes: 0, failures: 1, failovers: 1, totalLatencyMs: 5 } },
      byProvider: {}, byAccount: {},
      attemptsByLine: { p: { attempts: 1, successes: 0, failures: 1, totalTtftMs: 0, ttftSamples: 0, totalDurationMs: 10 } },
      updatedAt: 2,
    };
    const merged = mergeStats(base, delta);
    expect(merged.byAlias.gpt).toMatchObject({ requests: 3, successes: 2, failures: 1, failovers: 1, totalLatencyMs: 25 });
    expect(merged.attemptsByLine.p.attempts).toBe(1);
  });
});

describe("configuration validation", () => {
  it("reports broken references and invalid strategies", () => {
    const result = validateConfig(config({
      models: {
        gpt: {
          strategy: "random" as never,
          providers: [{ provider: "missing", model: "gpt" }],
        },
      },
    }));
    expect(result.errors.some((error) => error.includes("strategy"))).toBe(true);
    expect(result.errors.some((error) => error.includes('provider "missing" does not exist'))).toBe(true);
  });

  it("validates important model metadata and provider defaults", () => {
    const result = validateConfig(config({
      providers: {
        p: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          modelDefaults: {
            reasoning: "yes" as never,
            input: [] as never,
            contextWindow: 0,
            maxTokens: 1.5,
            cost: { input: -1, output: Number.NaN, cacheRead: 0, cacheWrite: 0 },
          },
          models: [
            { id: "same", contextWindow: 200_000, maxTokens: 16_384 },
            { id: "same", name: "", input: ["audio"] as never },
          ],
        },
      },
      models: {
        bad: {
          displayName: "",
          reasoning: "true" as never,
          input: [] as never,
          contextWindow: "1M" as never,
          maxTokens: -1,
          providers: [{ provider: "p", model: "same" }],
        },
      },
    }));

    expect(result.errors.some((error) => error.includes("modelDefaults.reasoning"))).toBe(true);
    expect(result.errors.some((error) => error.includes("modelDefaults.input"))).toBe(true);
    expect(result.errors.some((error) => error.includes("modelDefaults.contextWindow"))).toBe(true);
    expect(result.errors.some((error) => error.includes("modelDefaults.maxTokens"))).toBe(true);
    expect(result.errors.some((error) => error.includes("modelDefaults.cost.input"))).toBe(true);
    expect(result.errors.some((error) => error.includes('duplicate model id "same"'))).toBe(true);
    expect(result.errors.some((error) => error.includes("models.json:bad.displayName"))).toBe(true);
    expect(result.errors.some((error) => error.includes("models.json:bad.contextWindow"))).toBe(true);
  });

  it("validates routing, headers, patterns, compat values, and thinking maps", () => {
    const result = validateConfig(config({
      providers: {
        p: {
          type: "openai",
          baseUrl: "https://example.com/v1",
          headers: { "": "empty", valid: 123 as never },
          modelInclude: ["", "gpt-*"],
          compat: {
            supportsStore: "yes",
            maxTokensField: "max_output_tokens",
            thinkingFormat: "unknown",
          } as never,
        },
      },
      models: {
        bad: {
          providers: [{
            provider: "p",
            model: "m",
            headers: { test: false as never },
            thinkingLevelMap: { high: "" },
          }],
        },
      },
      routing: { failureThreshold: 1.5, cooldownMs: Number.POSITIVE_INFINITY },
    }));

    expect(result.errors.some((error) => error.includes("expected a valid HTTP header name"))).toBe(true);
    expect(result.errors.some((error) => error.includes("headers.valid"))).toBe(true);
    expect(result.errors.some((error) => error.includes("modelInclude"))).toBe(true);
    expect(result.errors.some((error) => error.includes("compat.supportsStore"))).toBe(true);
    expect(result.errors.some((error) => error.includes("compat.maxTokensField"))).toBe(true);
    expect(result.errors.some((error) => error.includes("thinkingLevelMap.high"))).toBe(true);
    expect(result.errors.some((error) => error.includes("failureThreshold"))).toBe(true);
    expect(result.errors.some((error) => error.includes("cooldownMs"))).toBe(true);
  });

  it("rejects malformed top-level sections", () => {
    const result = validateConfig(config({
      providers: [] as never,
      accounts: "bad" as never,
      models: null as never,
    }));
    expect(result.errors).toContain("providers.json: expected an object");
    expect(result.errors).toContain("accounts.json: expected an object");
    expect(result.errors).toContain("models.json: expected an object");
  });

  it("accepts complete valid metadata", () => {
    const result = validateConfig(config({
      providers: {
        p: {
          name: "Primary",
          type: "openai",
          baseUrl: "https://example.com/v1",
          headers: { "X-Test": "$TEST_HEADER" },
          modelInclude: ["gpt-*"],
          modelDefaults: {
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1_000_000,
            maxTokens: 65_536,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
          },
          models: [{ id: "gpt", name: "GPT", contextWindow: 200_000, maxTokens: 16_384 }],
          compat: { supportsStore: false, maxTokensField: "max_completion_tokens" },
        },
      },
      accounts: { main: { provider: "p", apiKey: "$KEY", priority: -1, stats: {} } },
      models: {
        gpt: {
          displayName: "GPT",
          reasoning: true,
          input: ["text"],
          contextWindow: 200_000,
          maxTokens: 16_384,
          providers: [{ provider: "p", model: "gpt", priority: -1 }],
        },
      },
      routing: { strategy: "failover", failureThreshold: 3, cooldownMs: 30_000, rateLimitCooldownMs: 60_000 },
    }));
    expect(result.errors).toEqual([]);
  });

  it("accepts native protocols and rejects unsupported adapters", () => {
    const valid = validateConfig(config({
      providers: {
        claude: { type: "anthropic", baseUrl: "https://api.anthropic.com" },
      },
      models: {
        claude: { providers: [{ provider: "claude", model: "claude-sonnet", api: "anthropic-messages" }] },
      },
    }));
    expect(valid.errors).toEqual([]);

    const warning = validateConfig(config({
      providers: {
        claude: {
          type: "anthropic",
          baseUrl: "https://api.anthropic.com",
          compat: { supportsDeveloperRole: false } as never,
        },
      },
    }));
    expect(warning.warnings.some((item) => item.includes("not recognized for anthropic-messages"))).toBe(true);

    const invalid = validateConfig(config({
      providers: { custom: { type: "custom-protocol", baseUrl: "https://example.com" } },
    }));
    expect(invalid.errors.some((error) => error.includes("unsupported protocol"))).toBe(true);
  });
});

describe("v0.3 native transports", () => {
  it("infers all supported native APIs", () => {
    expect(inferApi("openai")).toBe("openai-completions");
    expect(inferApi("openai-responses")).toBe("openai-responses");
    expect(inferApi("anthropic")).toBe("anthropic-messages");
    expect(inferApi("gemini")).toBe("google-generative-ai");
    expect(isSupportedApi("anthropic-messages")).toBe(true);
    expect(isSupportedApi("bedrock-converse-stream")).toBe(false);
  });

  it("applies binding-level api, endpoint, headers, compat, and thinking map", () => {
    const cfg = config({
      providers: {
        gateway: {
          type: "openai",
          authProvider: "anthropic",
          api: "openai-completions",
          baseUrl: "https://provider.example/v1",
          headers: { "x-provider": "yes" },
        },
      },
      models: {
        routed: {
          providers: [{
            id: "routed-anthropic",
            provider: "gateway",
            model: "claude-test",
            api: "anthropic-messages",
            baseUrl: "https://binding.example",
            headers: { "x-binding": "yes" },
            compat: { supportsTemperature: false } as never,
            thinkingLevelMap: { high: "high", xhigh: null, max: "max" },
          }],
        },
      },
    });
    const store = { get: () => cfg } as ConfigStore;
    const resolved = new ModelResolver(store).resolve("routed")[0];
    expect(resolved).toMatchObject({
      lineId: "routed-anthropic",
      authProvider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://binding.example",
      headers: { "x-provider": "yes", "x-binding": "yes" },
      thinkingLevelMap: { high: "high", xhigh: null, max: "max" },
    });
  });

  it("resolves literal, environment, escape, and !command secret values", async () => {
    process.env.PI_SWITCH_TEST_SECRET = "from-env";
    expect(await resolveConfigValue("literal")).toBe("literal");
    expect(await resolveConfigValue("$PI_SWITCH_TEST_SECRET")).toBe("from-env");
    expect(await resolveConfigValue("$!literal-bang")).toBe("!literal-bang");
    expect(await resolveConfigValue(`!\"${process.execPath}\" -e \"process.stdout.write('from-command')\"`)).toBe("from-command");
    delete process.env.PI_SWITCH_TEST_SECRET;
  });
});

describe("v0.3.2 correctness", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("merges routing strategy without wiping thresholds", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-switch-strategy-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "routing.json"), JSON.stringify({
      strategy: "priority",
      failureThreshold: 5,
      cooldownMs: 12000,
      rateLimitCooldownMs: 45000,
    }, null, 2));
    const store = new ConfigStore(dir);
    store.saveSection("routing", { ...store.get().routing, strategy: "failover" });
    const routing = JSON.parse(readFileSync(join(dir, "routing.json"), "utf-8"));
    expect(routing).toEqual({
      strategy: "failover",
      failureThreshold: 5,
      cooldownMs: 12000,
      rateLimitCooldownMs: 45000,
    });
  });

  it("cascades provider deletion across accounts and alias bindings", () => {
    const cfg = config({
      providers: {
        keep: { type: "openai", baseUrl: "https://keep.example/v1" },
        drop: { type: "openai", baseUrl: "https://drop.example/v1" },
      },
      accounts: {
        drop_key: { provider: "drop", apiKey: "sk-drop" },
        keep_key: { provider: "keep", apiKey: "sk-keep" },
      },
      models: {
        multi: {
          providers: [
            { provider: "keep", model: "a" },
            { provider: "drop", model: "b" },
          ],
        },
        only_drop: {
          providers: [{ provider: "drop", model: "c" }],
        },
      },
    });

    expect(providerDependents(cfg, "drop")).toEqual({
      accounts: ["drop_key"],
      aliases: [
        { alias: "multi", bindings: 1 },
        { alias: "only_drop", bindings: 1 },
      ],
    });

    const cascaded = cascadeDeleteProvider(cfg, "drop");
    expect(Object.keys(cascaded.providers)).toEqual(["keep"]);
    expect(Object.keys(cascaded.accounts)).toEqual(["keep_key"]);
    expect(cascaded.models).toEqual({
      multi: { providers: [{ provider: "keep", model: "a" }] },
    });
    expect(validateConfig({ ...cfg, ...cascaded }).errors).toEqual([]);
  });

  it("passes alias input modalities through model definitions", () => {
    const model = buildModelDefinition(
      "vision",
      {
        displayName: "Vision",
        input: ["text", "image"],
        reasoning: true,
        providers: [{ provider: "p", model: "v1" }],
      },
      { provider: "p", model: "v1" },
    );
    expect(model.input).toEqual(["text", "image"]);
    expect(model.reasoning).toBe(true);
  });

  it("rejects invalid alias input modalities", () => {
    const result = validateConfig(config({
      providers: { p: { type: "openai", baseUrl: "https://example.com/v1" } },
      models: {
        bad: {
          input: ["audio"] as never,
          providers: [{ provider: "p", model: "m" }],
        },
      },
    }));
    expect(result.errors.some((error) => error.includes("input"))).toBe(true);
  });
});
