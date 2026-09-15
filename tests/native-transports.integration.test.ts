import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamWithTransport } from "../src/provider/transport";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function sse(res: ServerResponse, events: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const item of events) {
    if (item.event) res.write(`event: ${item.event}\n`);
    res.write(`data: ${JSON.stringify(item.data)}\n\n`);
  }
  res.end();
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function model(api: Api, baseUrl: string): Model<Api> {
  return {
    id: "native-test",
    name: "native-test",
    api,
    provider: "native-test-provider",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 1024,
  };
}

async function collect(api: Api, baseUrl: string): Promise<any[]> {
  const stream = streamWithTransport(
    model(api, baseUrl),
    { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
    { apiKey: "test-key", maxTokens: 64 },
  );
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function assertCleanText(events: any[], expected: string): void {
  expect(events.filter((event) => event.type === "start")).toHaveLength(1);
  expect(events.filter((event) => event.type === "done")).toHaveLength(1);
  expect(events.filter((event) => event.type === "error")).toHaveLength(0);
  expect(events.filter((event) => event.type === "text_delta").map((event) => event.delta).join(""))
    .toContain(expected);
}

describe("v0.3 native protocol transports", () => {
  it("streams OpenAI Responses through the native adapter", async () => {
    const baseUrl = await listen((req, res) => {
      expect(req.url).toBe("/v1/responses");
      sse(res, [
        { data: { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } } },
        { data: { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [], status: "in_progress" } } },
        { data: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "responses ok" } },
        { data: { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "responses ok", annotations: [] }] } } },
        { data: { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } } },
      ]);
    });
    assertCleanText(await collect("openai-responses", `${baseUrl}/v1`), "responses ok");
  });

  it("streams Anthropic Messages through the native adapter", async () => {
    const baseUrl = await listen((req, res) => {
      expect(req.url).toBe("/v1/messages");
      sse(res, [
        { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "native-test", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "anthropic ok" } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } } },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    });
    assertCleanText(await collect("anthropic-messages", baseUrl), "anthropic ok");
  });

  it("streams Google Generative AI through the native adapter", async () => {
    const baseUrl = await listen((req, res) => {
      expect(req.url).toContain("/models/native-test:streamGenerateContent");
      sse(res, [{ data: {
        responseId: "gemini_1",
        candidates: [{ content: { role: "model", parts: [{ text: "gemini ok" }] }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      } }]);
    });
    assertCleanText(await collect("google-generative-ai", baseUrl), "gemini ok");
  });
});
