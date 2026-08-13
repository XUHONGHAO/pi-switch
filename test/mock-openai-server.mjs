/**
 * Mock OpenAI-compatible server for testing pi-switch Phase 2.
 *
 * Mirrors the docs' sub2api example: http://127.0.0.1:6780/v1
 *   GET  /v1/models          -> model list (for discovery)
 *   POST /v1/chat/completions-> SSE streaming chat completion
 *
 * Usage: node test/mock-openai-server.mjs [port]
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 6780);
const SERVER_ID = process.env.MOCK_ID ?? "mock";
// Comma-separated list of accepted bearer keys; empty = accept anything.
const ACCEPTED_KEYS = (process.env.MOCK_KEYS ?? "").split(",").filter(Boolean);

const MODELS = [
  { id: "gpt-mock", object: "model", owned_by: "mock", created: 1700000000 },
  { id: "claude-mock-sonnet", object: "model", owned_by: "mock", created: 1700000000 },
  { id: "embedding-mock", object: "model", owned_by: "mock", created: 1700000000 },
];

function authOk(req) {
  if (ACCEPTED_KEYS.length === 0) return true;
  const header = req.headers.authorization ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : header;
  return ACCEPTED_KEYS.includes(key);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendSseChunk(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    console.log(`[mock] GET /v1/models auth=${req.headers.authorization ?? "(none)"}`);
    sendJson(res, 200, { object: "list", data: MODELS });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!authOk(req)) {
      console.log(`[mock] POST /v1/chat/completions REJECTED auth=${req.headers.authorization ?? "(none)"}`);
      sendJson(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      console.log(
        `[mock] POST /v1/chat/completions model=${parsed.model} stream=${parsed.stream} auth=${req.headers.authorization ?? "(none)"} messages=${parsed.messages?.length ?? 0}`,
      );

      if (!authOk(req)) {
        console.log(`[mock] GET /v1/models REJECTED auth=${req.headers.authorization ?? "(none)"}`);
        sendJson(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
        return;
      }
      const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === "user");
      const content = lastUser?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((c) => c?.type === "text").map((c) => c.text).join(" ")
            : "(nothing)";
      const reply = `Hello from ${SERVER_ID} (${parsed.model})! You said: ${text}`;

      if (parsed.stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const base = {
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
        };
        sendSseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] });
        setTimeout(() => {
          sendSseChunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          res.write("data: [DONE]\n\n");
          res.end();
        }, 50);
        return;
      }

      sendJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: parsed.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      });
    });
    return;
  }

  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, () => {
  console.log(`[mock] OpenAI-compatible server "${SERVER_ID}" listening on http://127.0.0.1:${PORT}/v1`);
});
