/**
 * Phase 0 of cost-aware routing: the host half of the passthrough contract.
 *
 * `tests/alias-native-passthrough.integration.test.ts` calls the alias
 * `streamSimple` directly. This file instead drives the alias provider through
 * real pi machinery, so a future pi version that stops handing `sessionId` /
 * `cacheRetention` to extension providers fails here instead of silently
 * degrading prompt-cache hit rates.
 *
 * Chains under test:
 *   pi ModelRuntime  -> AliasProvider -> pi-ai transport -> upstream request
 *   pi AgentSession  -> AliasProvider (session id identity)
 *
 * See docs/requirements/cost-aware-routing.md sections 5.2 and 5.6.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config/store";
import { AliasProvider, ALIAS_PROVIDER } from "../src/provider/alias";
import { StatsManager } from "../src/stats/manager";

const SESSION_ID = "01994b7c-1f2e-7c3d-9a11-5f7b0c2d4e68";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** pi-switch config dir with one alias line pointing at `baseUrl`. */
function writeConfig(baseUrl: string): string {
  const dir = tempDir("pi-switch-host-config-");
  writeFileSync(join(dir, "providers.json"), JSON.stringify({
    upstream: { type: "openai", baseUrl: `${baseUrl}/v1`, apiKey: "test", discoverModels: false },
  }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    alias: {
      contextWindow: 128000,
      providers: [{
        id: "line-1",
        provider: "upstream",
        model: "gpt-test",
        // Both compat flags below are protocol-visible: pi-ai only emits the
        // long-retention cache key and the affinity headers when they are set.
        compat: { supportsLongCacheRetention: true, sendSessionAffinityHeaders: true },
      }],
    },
  }));
  return dir;
}

/** The provider config pi-switch hands to pi.registerProvider(). */
function registerAlias(configDir: string): any {
  let registered: any;
  const pi = {
    registerProvider: (_name: string, value: unknown) => { registered = value; },
    unregisterProvider: () => {},
  } as any;
  new AliasProvider(pi, new ConfigStore(configDir), new StatsManager(configDir)).register();
  if (!registered) throw new Error("alias provider did not register");
  return registered;
}

/** A pi ModelRuntime isolated from the developer's ~/.pi state. */
async function isolatedRuntime(): Promise<ModelRuntime> {
  const agentDir = tempDir("pi-switch-host-agent-");
  return ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

interface CapturedRequest {
  url?: string;
  headers: Record<string, string | undefined>;
  body: any;
}

async function listen(captured: CapturedRequest[]): Promise<string> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      captured.push({
        url: req.url,
        headers: req.headers as Record<string, string | undefined>,
        body: raw ? JSON.parse(raw) : undefined,
      });
      const base = { id: "chatcmpl-host", object: "chat.completion.chunk", created: 1, model: "gpt-test" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "host ok" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}

describe("pi host passthrough into pi-switch aliases", () => {
  it("keeps sessionId and cacheRetention across pi's provider composition", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(captured);
    const registered = registerAlias(writeConfig(baseUrl));
    expect(registered.streamSimple).toBeTypeOf("function");

    const runtime = await isolatedRuntime();
    runtime.registerProvider(ALIAS_PROVIDER, registered);
    const model = runtime.getModel(ALIAS_PROVIDER, "alias");
    expect(model).toBeDefined();

    const stream = runtime.streamSimple(
      model!,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
      { sessionId: SESSION_ID, cacheRetention: "long", maxTokens: 64 },
    );
    const events: any[] = [];
    for await (const event of stream) events.push(event);

    expect(events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(captured).toHaveLength(1);
    // pi-ai generated these from the host sessionId/cacheRetention, proving both
    // survived pi's runtime layer and pi-switch's alias forwarding.
    expect(captured[0].body.prompt_cache_key).toBe(SESSION_ID);
    expect(captured[0].body.prompt_cache_retention).toBe("24h");
  }, 30000);

  it("receives pi's own session id, so affinity can key on it", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(captured);
    const registered = registerAlias(writeConfig(baseUrl));

    const runtime = await isolatedRuntime();
    runtime.registerProvider(ALIAS_PROVIDER, registered);
    const model = runtime.getModel(ALIAS_PROVIDER, "alias");

    // Isolated cwd/agentDir so no user extension, setting or project file loads.
    const cwd = tempDir("pi-switch-host-cwd-");
    const agentDir = tempDir("pi-switch-host-session-agent-");
    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: runtime,
      model: model as never,
      sessionManager,
      settingsManager: SettingsManager.create(cwd, agentDir),
      noTools: "all",
    });
    await session.prompt("hello");

    expect(captured).toHaveLength(1);
    // pi passes sessionManager.getSessionId() as options.sessionId; pi-ai turns
    // it into affinity headers. Equality proves pi-switch forwards pi's own id
    // instead of substituting one of its own.
    expect(sessionManager.getSessionId()).not.toBe("");
    expect(captured[0].headers["x-session-affinity"]).toBe(sessionManager.getSessionId());
    expect(captured[0].headers["x-client-request-id"]).toBe(sessionManager.getSessionId());
  }, 60000);
});
