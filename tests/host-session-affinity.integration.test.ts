/**
 * Host-level session-affinity E2E.
 *
 * Unlike `pi-host-passthrough.integration.test.ts`, this loads the real
 * extension entry (`src/index.ts`) through pi's `DefaultResourceLoader` and
 * drives it with a real `AgentSession`, so the whole chain is exercised:
 *
 *   pi AgentSession -> public API provider -> pi-switch extension
 *     -> Router failover -> pi-ai transport -> upstream
 *     -> pi.appendEntry() -> session JSONL
 *   (fresh extension instance) -> SessionManager.open -> restoreSessionAffinity
 *
 * The "restart" is a fresh extension/Router instance reading a reopened
 * session file. It verifies the persisted Custom Entry is what restores the
 * route, not in-memory state. Live custom entries are only flushed once an
 * assistant message exists (SessionManager has no public flush), which a real
 * successful turn satisfies.
 *
 * The harness (why `bindExtensions` is required, and why a fresh extension
 * instance stands in for a process restart) is documented in ADR 0010.
 *
 * See docs/requirements/cost-aware-routing.md section 9 (items 11 and 16) and
 * docs/decisions/0010-host-level-extension-e2e-harness.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cleanups: Array<() => void | Promise<void>> = [];
const originalConfigDir = process.env.PI_SWITCH_CONFIG_DIR;

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (originalConfigDir === undefined) delete process.env.PI_SWITCH_CONFIG_DIR;
  else process.env.PI_SWITCH_CONFIG_DIR = originalConfigDir;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface RequestRecord {
  label: "primary" | "backup";
  url?: string;
}

interface MockUpstream {
  label: "primary" | "backup";
  url: string;
}

/** A mock OpenAI-compatible endpoint: primary fails before content, backup streams. */
async function listen(label: "primary" | "backup", status: number, requests: RequestRecord[]): Promise<MockUpstream> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requests.push({ label, url: req.url });
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `${label} unavailable` } }));
        return;
      }
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
  let closed = false;
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    if (closed) return resolve();
    closed = true;
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return { label, url: `http://127.0.0.1:${address.port}` };
}

/** Config dir with two failover lines: primary (broken) then backup (working). */
function writeConfig(primary: string, backup: string): string {
  const dir = tempDir("pi-switch-host-affinity-config-");
  process.env.PI_SWITCH_CONFIG_DIR = dir;
  writeFileSync(join(dir, "providers.json"), JSON.stringify({
    primary: { type: "openai", baseUrl: `${primary}/v1`, apiKey: "test", discoverModels: false },
    backup: { type: "openai", baseUrl: `${backup}/v1`, apiKey: "test", discoverModels: false },
  }));
  writeFileSync(join(dir, "models.json"), JSON.stringify({
    alias: {
      contextWindow: 128000,
      providers: [
        { id: "line-primary", provider: "primary", model: "gpt-test", priority: 1 },
        { id: "line-backup", provider: "backup", model: "gpt-test", priority: 2 },
      ],
    },
  }));
  writeFileSync(join(dir, "accounts.json"), "{}");
  writeFileSync(join(dir, "routing.json"), JSON.stringify({ strategy: "failover" }));
  return dir;
}

async function isolatedRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

interface BootOptions {
  cwd: string;
  agentDir: string;
  runtime: ModelRuntime;
  sessionManager: SessionManager;
}

/** Boot a fresh extension instance + agent session, then select the alias model. */
async function bootSession({ cwd, agentDir, runtime, sessionManager }: BootOptions) {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalExtensionPaths: [resolve("src/index.ts")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  // createAgentSession does not re-run discovery for a caller-provided loader;
  // reload here so the pi-switch extension registers its alias provider.
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.create(cwd, agentDir),
    noTools: "all",
  });
  // createAgentSession does not bind extensions; modes (print/TUI/RPC) do.
  // Binding here emits session_start so pi-switch restores session affinity.
  await session.bindExtensions({ mode: "print" });
  const model = runtime.getModel("pi-switch", "alias");
  if (!model) throw new Error("pi-switch alias model was not registered");
  await session.setModel(model);
  return session;
}

describe("host-level session affinity across a restart", () => {
  it("persists a post-failover route and restores it from a reopened session", async () => {
    const requests: RequestRecord[] = [];
    const primary = await listen("primary", 503, requests);
    const backup = await listen("backup", 200, requests);
    writeConfig(primary.url, backup.url);

    const cwd = tempDir("pi-switch-host-affinity-cwd-");
    const agentDir = tempDir("pi-switch-host-affinity-agent-");
    const sessionDir = join(tempDir("pi-switch-host-affinity-sessions-"), "sessions");
    const runtime = await isolatedRuntime(agentDir);

    const sessionManager = SessionManager.create(cwd, sessionDir);
    const session = await bootSession({ cwd, agentDir, runtime, sessionManager });
    await session.prompt("first");
    session.dispose();

    // Turn 1 starts on the primary, fails over, and sticks to the backup.
    expect(requests.map((request) => request.label)).toEqual(["primary", "backup"]);

    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile && existsSync(sessionFile)).toBe(true);
    const raw = readFileSync(sessionFile!, "utf-8");
    const entries = raw.trim().split("\n").map((line) => JSON.parse(line));
    const affinity = entries.find((entry) => entry.type === "custom" && entry.customType === "pi-switch-affinity");
    expect(affinity?.data?.lineId).toBe("line-backup");
    // The persisted entry must not expose pi's raw session id (only its hash).
    expect(affinity?.data?.sessionIdHash).not.toBe(sessionManager.getSessionId());
    expect(JSON.stringify(affinity?.data ?? {})).not.toContain(sessionManager.getSessionId());

    // "Restart": fresh SessionManager + fresh extension instance (fresh Router).
    const reopened = SessionManager.open(sessionFile!);
    expect(reopened.getSessionId()).toBe(sessionManager.getSessionId());
    expect(reopened.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-switch-affinity")).toBe(true);
    requests.length = 0;
    const restarted = await bootSession({ cwd, agentDir, runtime, sessionManager: reopened });
    await restarted.prompt("second");
    restarted.dispose();

    // Affinity restored from the persisted entry: the backup is used directly.
    expect(requests.map((request) => request.label)).toEqual(["backup"]);
  }, 120000);

  it("does not leak affinity into a new session", async () => {
    const requests: RequestRecord[] = [];
    const primary = await listen("primary", 503, requests);
    const backup = await listen("backup", 200, requests);
    writeConfig(primary.url, backup.url);

    const cwd = tempDir("pi-switch-host-affinity-new-cwd-");
    const agentDir = tempDir("pi-switch-host-affinity-new-agent-");
    const sessionDir = join(tempDir("pi-switch-host-affinity-new-sessions-"), "sessions");
    const runtime = await isolatedRuntime(agentDir);

    const first = SessionManager.create(cwd, sessionDir);
    const session = await bootSession({ cwd, agentDir, runtime, sessionManager: first });
    await session.prompt("first");
    session.dispose();
    expect(requests.map((request) => request.label)).toEqual(["primary", "backup"]);

    // A brand-new session id must start from the primary again.
    requests.length = 0;
    const second = SessionManager.create(cwd, sessionDir);
    const newSession = await bootSession({ cwd, agentDir, runtime, sessionManager: second });
    await newSession.prompt("new session");
    newSession.dispose();
    expect(requests.map((request) => request.label)).toEqual(["primary", "backup"]);
  }, 120000);
});
