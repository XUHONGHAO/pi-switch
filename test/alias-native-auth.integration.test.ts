import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/store";
import { AliasProvider } from "../src/provider/alias";
import { StatsManager } from "../src/stats/manager";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function listen(): Promise<string> {
  const server: Server = createServer((req, res) => {
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v1/responses");
    expect(req.headers.authorization).toBe("Bearer delegated-oauth");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = [
      { type: "response.created", response: { id: "resp_auth", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { id: "msg_auth", type: "message", role: "assistant", content: [], status: "in_progress" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "delegated auth ok" },
      { type: "response.output_item.done", output_index: 0, item: { id: "msg_auth", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "delegated auth ok", annotations: [] }] } },
      { type: "response.completed", response: { id: "resp_auth", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("AliasProvider native auth delegation", () => {
  it("uses delegated header-only auth while preserving the binding endpoint", async () => {
    const baseUrl = await listen();
    const dir = mkdtempSync(join(tmpdir(), "pi-switch-auth-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "providers.json"), JSON.stringify({
      custom_openai: {
        type: "openai-responses",
        api: "openai-responses",
        authProvider: "openai",
        baseUrl: "https://provider-default.invalid/v1",
        discoverModels: false,
      },
    }));
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      native: { providers: [{
        id: "native-responses-line",
        provider: "custom_openai",
        model: "gpt-test",
        api: "openai-responses",
        baseUrl,
      }] },
    }));

    let providerConfig: any;
    const pi = {
      registerProvider: (_name: string, value: unknown) => { providerConfig = value; },
      unregisterProvider: () => {},
    } as any;
    const requestedAuthProviders: string[] = [];
    const registry = {
      find: () => undefined,
      getApiKeyAndHeaders: async (model: { provider: string }) => {
        requestedAuthProviders.push(model.provider);
        return {
          ok: true,
          headers: { Authorization: "Bearer delegated-oauth" },
          // Must not replace the binding endpoint when authProvider differs.
          baseUrl: "https://auth-provider.invalid/v1",
        };
      },
    } as any;
    const stats = new StatsManager(dir);
    const aliasProvider = new AliasProvider(pi, new ConfigStore(dir), stats);
    aliasProvider.bindModelRegistry(registry);
    aliasProvider.register();

    const model = {
      id: "native", name: "native", provider: "pi-switch", api: "openai-completions",
      baseUrl: "http://pi-switch.local/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
    } as any;
    const events: any[] = [];
    const stream = providerConfig.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { apiKey: "local" },
    );
    for await (const event of stream) events.push(event);

    expect(requestedAuthProviders).toEqual(["openai"]);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""))
      .toContain("delegated auth ok");
    expect(aliasProvider.lastRouteInfo()).toMatchObject({
      lineId: "native-responses-line",
      provider: "custom_openai",
      ok: true,
    });
    expect(stats.lineAttempts("native-responses-line")).toMatchObject({ attempts: 1, successes: 1 });
  });
});
