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

async function listen(mode: "fail" | "success"): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      if (mode === "fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "temporary 503 Service Unavailable" } }));
        return;
      }
      const request = JSON.parse(body) as { model: string };
      const base = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: request.model };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "fallback ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function writeConfig(dir: string, first: string, second: string): void {
  writeFileSync(join(dir, "providers.json"), JSON.stringify({
    first: { type: "openai", baseUrl: first, apiKey: "test", discoverModels: false },
    second: { type: "openai", baseUrl: second, apiKey: "test", discoverModels: false },
  }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    gpt: { strategy: "failover", providers: [
      { provider: "first", model: "gpt-test", priority: 1 },
      { provider: "second", model: "gpt-test", priority: 2 },
    ] },
  }));
}

describe("AliasProvider streaming failover", () => {
  it("suppresses the failed attempt stream and emits one clean successful sequence", async () => {
    const failed = await listen("fail");
    const successful = await listen("success");
    const dir = mkdtempSync(join(tmpdir(), "pi-switch-integration-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeConfig(dir, failed.baseUrl, successful.baseUrl);

    let providerConfig: any;
    const pi = {
      registerProvider: (_name: string, config: unknown) => { providerConfig = config; },
      unregisterProvider: () => {},
    } as any;
    const stats = new StatsManager(dir);
    const aliasProvider = new AliasProvider(pi, new ConfigStore(dir), stats);
    aliasProvider.beginTurn();
    aliasProvider.register();

    const model = {
      id: "gpt", name: "gpt", provider: "pi-switch", api: "openai-completions",
      baseUrl: "http://pi-switch.local/v1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000,
    } as any;
    const stream = providerConfig.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] }, { apiKey: "local" });
    const events: any[] = [];
    for await (const event of stream) events.push(event);

    expect(events.filter((event) => event.type === "start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""))
      .toContain("fallback ok");
    expect(aliasProvider.lastRouteInfo()).toMatchObject({ provider: "second", ok: true, failovers: 1 });
    expect(aliasProvider.currentTurnFailovers()).toBe(1);
    expect(stats.attemptSummary().find(({ line }) => line.startsWith("first|"))?.stats)
      .toMatchObject({ attempts: 1, failures: 1 });
    expect(stats.attemptSummary().find(({ line }) => line.startsWith("second|"))?.stats)
      .toMatchObject({ attempts: 1, successes: 1 });
  });
});
