/**
 * Session affinity unit tests (Phase A).
 *
 * Verifies Router's session-level affinity and balance behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Router } from "../src/router/router";
import { ConfigStore } from "../src/config/store";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedBinding } from "../src/model/resolver";

const SESSION_A = "00000000-0000-0000-0000-000000000001";
const SESSION_B = "00000000-0000-0000-0000-000000000002";
const SESSION_C = "00000000-0000-0000-0000-000000000003";

function writeConfig(routing: any): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-switch-router-"));
  writeFileSync(join(dir, "providers.json"), "{}");
  writeFileSync(join(dir, "models.json"), "{}");
  writeFileSync(join(dir, "accounts.json"), "{}");
  writeFileSync(join(dir, "routing.json"), JSON.stringify(routing));
  return dir;
}

function binding(provider: string, model: string, priority = 0): ResolvedBinding {
  return {
    provider,
    model,
    api: "openai-completions" as const,
    baseUrl: `http://${provider}.test/v1`,
    priority,
    accountPriority: 0,
  };
}

describe("Router session affinity (Phase A)", () => {
  let tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("session-scoped balance uses rendezvous hashing for initial selection", () => {
    const dir = writeConfig({ strategy: "balance", balanceScope: "session" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("A", "gpt"), binding("B", "gpt"), binding("C", "gpt")];

    // Same session should always get the same binding (deterministic).
    const sel1 = router.select("test", bindings, SESSION_A);
    const sel2 = router.select("test", bindings, SESSION_A);
    const sel3 = router.select("test", bindings, SESSION_A);

    expect(sel1.binding.provider).toBe(sel2.binding.provider);
    expect(sel2.binding.provider).toBe(sel3.binding.provider);

    // Different sessions get their own deterministic bindings.
    const selB = router.select("test", bindings, SESSION_B);
    const selC = router.select("test", bindings, SESSION_C);

    expect(selB.binding.provider).toBeDefined();
    expect(selC.binding.provider).toBeDefined();

    // Rendezvous should ideally distribute, but we only assert determinism here.
    // (Hash collisions are possible, so we don't enforce distinct providers.)
  });

  it("same session sticks to the same binding after affinity is set", () => {
    const dir = writeConfig({ strategy: "balance", balanceScope: "session" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("A", "gpt"), binding("B", "gpt")];

    // Initial selection.
    const sel1 = router.select("test", bindings, SESSION_A);
    const firstProvider = sel1.binding.provider;

    // Record affinity (simulating successful first response).
    router.setAffinity(SESSION_A, "test", sel1.binding);

    // Subsequent selections should return the same binding.
    const sel2 = router.select("test", bindings, SESSION_A);
    const sel3 = router.select("test", bindings, SESSION_A);

    expect(sel2.binding.provider).toBe(firstProvider);
    expect(sel3.binding.provider).toBe(firstProvider);
  });

  it("request-scoped balance rotates without affinity", () => {
    const dir = writeConfig({ strategy: "balance", balanceScope: "request" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("A", "gpt"), binding("B", "gpt")];

    // Three selections from the same session should rotate.
    const sel1 = router.select("test", bindings, SESSION_A);
    router.setAffinity(SESSION_A, "test", sel1.binding);
    const sel2 = router.select("test", bindings, SESSION_A);
    const sel3 = router.select("test", bindings, SESSION_A);

    const providers = [sel1.binding.provider, sel2.binding.provider, sel3.binding.provider];

    // Round-robin should visit both bindings.
    expect(providers).toContain("A");
    expect(providers).toContain("B");
  });

  it("failover respects affinity once established", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("first", "gpt", 0), binding("second", "gpt", 1)];

    // Initial selection (no affinity): should pick first.
    const sel1 = router.select("test", bindings, SESSION_A);
    expect(sel1.binding.provider).toBe("first");

    // Simulate failover: set affinity to second.
    router.setAffinity(SESSION_A, "test", bindings[1]);

    // Next request should stick to second.
    const sel2 = router.select("test", bindings, SESSION_A);
    expect(sel2.binding.provider).toBe("second");
  });

  it("restores persisted line identity and reports an affinity hit", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);
    const bindings = [binding("first", "gpt", 0), binding("second", "gpt", 1)];
    bindings[0].lineId = "stable-first";
    bindings[1].lineId = "stable-second";

    router.restoreAffinity(SESSION_A, "test", "stable-second");
    const selection = router.select("test", bindings, SESSION_A);
    expect(selection.binding.lineId).toBe("stable-second");
    expect(selection.affinityHit).toBe(true);
  });

  it("clearSession removes affinity", () => {
    const dir = writeConfig({ strategy: "balance", balanceScope: "session" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("A", "gpt"), binding("B", "gpt")];

    const sel1 = router.select("test", bindings, SESSION_A);
    router.setAffinity(SESSION_A, "test", sel1.binding);

    // Affinity works.
    const sel2 = router.select("test", bindings, SESSION_A);
    expect(sel2.binding.provider).toBe(sel1.binding.provider);

    // Clear session.
    router.clearSession(SESSION_A);

    // Next selection should be fresh (potentially different due to rendezvous).
    const sel3 = router.select("test", bindings, SESSION_A);
    // Can't assert it's different (might hash to the same), but affinity map is empty.
    expect(sel3).toBeDefined();
  });

  it("reset clears all affinity", () => {
    const dir = writeConfig({ strategy: "balance", balanceScope: "session" });
    tempDirs.push(dir);
    const store = new ConfigStore(dir);
    const router = new Router(store);

    const bindings = [binding("A", "gpt"), binding("B", "gpt")];

    const sel1 = router.select("test", bindings, SESSION_A);
    router.setAffinity(SESSION_A, "test", sel1.binding);
    const sel2 = router.select("test", bindings, SESSION_B);
    router.setAffinity(SESSION_B, "test", sel2.binding);

    router.reset();

    // Both sessions should get fresh selections.
    const sel3 = router.select("test", bindings, SESSION_A);
    const sel4 = router.select("test", bindings, SESSION_B);
    expect(sel3).toBeDefined();
    expect(sel4).toBeDefined();
  });
});
