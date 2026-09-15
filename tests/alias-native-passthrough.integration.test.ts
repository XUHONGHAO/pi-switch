/**
 * Phase 0 of cost-aware routing: pin the pi-native passthrough contract.
 *
 * These are protocol-level regressions: they assert that the host stream
 * options pi hands to `AliasProvider.streamSimple` (`sessionId`,
 * `cacheRetention`) and the routed binding's `compat` survive the hop into
 * pi-ai's native transports, by inspecting the real upstream HTTP request.
 *
 * pi-switch must not build cache fields itself; every assertion below is about
 * what pi-ai generates once the options/compat arrive intact.
 *
 * See docs/requirements/cost-aware-routing.md section 5.6 and
 * docs/plans/cost-aware-routing-strategy.md phase 0.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { ConfigStore } from "../src/config/store";
import { AliasProvider } from "../src/provider/alias";
import { StatsManager } from "../src/stats/manager";

/** Stable, pi-shaped session id (uuidv7 length, under the OpenAI 64-char clamp). */
const SESSION_ID = "01994b7c-1f2e-7c3d-9a11-5f7b0c2d4e68";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface CapturedRequest {
  url?: string;
  headers: Record<string, string | undefined>;
  body: any;
}

/** Start an upstream that records one request and replays a canned SSE stream. */
async function listen(
  respond: (res: ServerResponse) => void,
  captured: CapturedRequest[],
): Promise<string> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      captured.push({
        url: req.url,
        headers: req.headers as Record<string, string | undefined>,
        body: raw ? JSON.parse(raw) : undefined,
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const item of events) {
    if (item.event) res.write(`event: ${item.event}\n`);
    res.write(`data: ${JSON.stringify(item.data)}\n\n`);
  }
  res.end();
}

function completionsStream(res: ServerResponse): void {
  const base = { id: "chatcmpl-passthrough", object: "chat.completion.chunk", created: 1, model: "gpt-test" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "passthrough ok" }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function responsesStream(res: ServerResponse): void {
  sse(res, [
    { data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } },
    { data: { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [], status: "in_progress" } } },
    { data: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "passthrough ok" } },
    { data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "passthrough ok", annotations: [] }] } } },
    { data: { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } },
  ]);
}

function messagesStream(res: ServerResponse): void {
  sse(res, [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "passthrough ok" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

/** Minimal pi-switch config dir with a single alias line. */
function writeConfig(
  provider: Record<string, unknown>,
  binding: Record<string, unknown>,
): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-switch-passthrough-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "providers.json"), JSON.stringify({ upstream: provider }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    alias: { contextWindow: 128000, providers: [{ id: "line-1", provider: "upstream", ...binding }] },
  }));
  return dir;
}

/** The alias model pi hands to streamSimple (virtual provider, no compat). */
function aliasModel(): Model<never> {
  return {
    id: "alias",
    name: "alias",
    provider: "pi-switch",
    api: "openai-completions",
    baseUrl: "http://pi-switch.local/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 1000,
  } as never;
}

/** Route one request through AliasProvider exactly like pi's runtime does. */
async function route(
  dir: string,
  options: Record<string, unknown>,
  registry?: unknown,
): Promise<{ events: any[]; provider: AliasProvider }> {
  let providerConfig: any;
  const pi = {
    registerProvider: (_name: string, value: unknown) => { providerConfig = value; },
    unregisterProvider: () => {},
  } as any;
  const aliasProvider = new AliasProvider(pi, new ConfigStore(dir), new StatsManager(dir));
  if (registry) aliasProvider.bindModelRegistry(registry as never);
  aliasProvider.register();
  const stream = providerConfig.streamSimple(
    aliasModel(),
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "local", maxTokens: 64, ...options },
  );
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return { events, provider: aliasProvider };
}

function assertNoError(events: any[]): void {
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""))
    .toContain("passthrough ok");
}

describe("AliasProvider pi-native passthrough contract", () => {
  it("forwards sessionId and long cacheRetention into OpenAI completions cache/affinity fields", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(completionsStream, captured);
    const dir = writeConfig(
      { type: "openai", baseUrl: `${baseUrl}/v1`, apiKey: "test", discoverModels: false },
      {
        model: "gpt-test",
        // compat must reach pi-ai: it decides whether affinity headers and the
        // long-retention prompt cache key are emitted at all.
        compat: {
          sendSessionAffinityHeaders: true,
          sessionAffinityFormat: "openai",
          supportsLongCacheRetention: true,
        },
      },
    );

    const { events } = await route(dir, { sessionId: SESSION_ID, cacheRetention: "long" });
    assertNoError(events);

    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request.url).toBe("/v1/chat/completions");
    // pi-ai derives the OpenAI prompt cache key from options.sessionId.
    expect(request.body.prompt_cache_key).toBe(SESSION_ID);
    expect(request.body.prompt_cache_retention).toBe("24h");
    // ...and the upstream session-affinity headers from the same value.
    expect(request.headers.session_id).toBe(SESSION_ID);
    expect(request.headers["x-client-request-id"]).toBe(SESSION_ID);
    expect(request.headers["x-session-affinity"]).toBe(SESSION_ID);
  });

  it("forwards cacheRetention \"none\" so no cache key or affinity header is emitted", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(completionsStream, captured);
    const dir = writeConfig(
      { type: "openai", baseUrl: `${baseUrl}/v1`, apiKey: "test", discoverModels: false },
      {
        model: "gpt-test",
        compat: {
          sendSessionAffinityHeaders: true,
          sessionAffinityFormat: "openai",
          supportsLongCacheRetention: true,
        },
      },
    );

    const { events } = await route(dir, { sessionId: SESSION_ID, cacheRetention: "none" });
    assertNoError(events);

    const [request] = captured;
    expect(request.body.prompt_cache_key).toBeUndefined();
    expect(request.body.prompt_cache_retention).toBeUndefined();
    expect(request.headers.session_id).toBeUndefined();
    expect(request.headers["x-session-affinity"]).toBeUndefined();
  });

  it("forwards sessionId into the OpenAI Responses prompt cache key", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(responsesStream, captured);
    const dir = writeConfig(
      {
        type: "openai-responses",
        api: "openai-responses",
        baseUrl: `${baseUrl}/v1`,
        apiKey: "test",
        discoverModels: false,
      },
      { model: "gpt-test", api: "openai-responses" },
    );

    const { events } = await route(dir, { sessionId: SESSION_ID });
    assertNoError(events);

    const [request] = captured;
    expect(request.url).toBe("/v1/responses");
    expect(request.body.prompt_cache_key).toBe(SESSION_ID);
  });

  it("forwards sessionId and cacheRetention into Anthropic cache_control and affinity header", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(messagesStream, captured);
    const dir = writeConfig(
      {
        type: "anthropic",
        baseUrl,
        apiKey: "test",
        discoverModels: false,
      },
      {
        model: "claude-test",
        compat: { sendSessionAffinityHeaders: true, supportsLongCacheRetention: true },
      },
    );

    const { events } = await route(dir, { sessionId: SESSION_ID, cacheRetention: "long" });
    assertNoError(events);

    const [request] = captured;
    expect(request.url).toBe("/v1/messages");
    expect(request.headers["x-session-affinity"]).toBe(SESSION_ID);
    // Anthropic caching is expressed as cache_control breakpoints, not a key.
    const lastMessage = request.body.messages.at(-1);
    const blocks = Array.isArray(lastMessage.content) ? lastMessage.content : [];
    expect(blocks.at(-1).cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("keeps the routed binding compat when the alias model carries none", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(completionsStream, captured);
    const dir = writeConfig(
      { type: "openai", baseUrl: `${baseUrl}/v1`, apiKey: "test", discoverModels: false },
      // maxTokensField is an unambiguous, protocol-visible compat effect.
      { model: "gpt-test", compat: { maxTokensField: "max_tokens" } },
    );

    const { events } = await route(dir, { sessionId: SESSION_ID });
    assertNoError(events);

    const [request] = captured;
    expect(request.body.max_tokens).toBe(64);
    expect(request.body.max_completion_tokens).toBeUndefined();
  });

  it("keeps the registered pi model compat when the binding declares none", async () => {
    const captured: CapturedRequest[] = [];
    const baseUrl = await listen(completionsStream, captured);
    const dir = writeConfig(
      { type: "openai", baseUrl: `${baseUrl}/v1`, apiKey: "test", discoverModels: false },
      { model: "gpt-test" },
    );

    // pi's registry can carry compat for the concrete model (models.json
    // overrides, provider catalog); routing must not drop it either.
    const registry = {
      find: (provider: string, id: string) =>
        provider === "upstream" && id === "gpt-test"
          ? {
              id,
              name: id,
              api: "openai-completions",
              provider,
              baseUrl: `${baseUrl}/v1`,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 1000,
              compat: { maxTokensField: "max_tokens" },
            }
          : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
    };

    const { events } = await route(dir, { sessionId: SESSION_ID }, registry);
    assertNoError(events);

    const [request] = captured;
    expect(request.body.max_tokens).toBe(64);
    expect(request.body.max_completion_tokens).toBeUndefined();
  });
});
