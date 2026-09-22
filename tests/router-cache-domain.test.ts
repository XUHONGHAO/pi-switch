/**
 * cacheDomain candidate-ordering tests.
 *
 * A user-declared cacheDomain only reorders failover alternatives:
 *   same-binding accounts -> same cacheDomain -> remaining routes.
 * It never changes the initial selection for a fresh session.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../src/router/router";
import { ConfigStore } from "../src/config/store";
import type { ResolvedBinding } from "../src/model/resolver";

const SESSION = "00000000-0000-0000-0000-0000000000c1";

function writeConfig(routing: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-switch-cache-domain-"));
  writeFileSync(join(dir, "providers.json"), "{}");
  writeFileSync(join(dir, "models.json"), "{}");
  writeFileSync(join(dir, "accounts.json"), "{}");
  writeFileSync(join(dir, "routing.json"), JSON.stringify(routing));
  return dir;
}

function line(
  id: string,
  priority: number,
  options: { cacheDomain?: string; accountName?: string; accountPriority?: number } = {},
): ResolvedBinding {
  return {
    lineId: id,
    provider: id,
    model: "m",
    providerLabel: id,
    authProvider: id,
    type: "openai",
    api: "openai-completions",
    baseUrl: `https://${id}.example/v1`,
    priority,
    accountPriority: options.accountPriority ?? 0,
    ...(options.cacheDomain ? { cacheDomain: options.cacheDomain } : {}),
    ...(options.accountName ? { accountName: options.accountName } : {}),
  };
}

describe("Router cacheDomain ordering", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it("prefers a same-cacheDomain route over an unrelated higher-priority route", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const router = new Router(new ConfigStore(dir));

    const primary = line("a", 0, { cacheDomain: "shared" });
    const unrelated = line("c", 1);
    const sameDomain = line("b", 2, { cacheDomain: "shared" });

    const selection = router.select("gpt", [primary, unrelated, sameDomain], SESSION);
    expect(selection.binding.lineId).toBe("a");
    expect(selection.attempts.map((binding) => binding.lineId)).toEqual(["a", "b", "c"]);
  });

  it("keeps other accounts on the same binding before same-domain routes", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const router = new Router(new ConfigStore(dir));

    const primary = line("a", 0, { cacheDomain: "shared" });
    const backupAccount = line("a", 0, { cacheDomain: "shared", accountName: "backup", accountPriority: 1 });
    const unrelated = line("c", 1);
    const sameDomain = line("d", 1, { cacheDomain: "shared" });

    const selection = router.select("gpt", [primary, backupAccount, unrelated, sameDomain], SESSION);
    expect(selection.attempts.map((binding) => binding.accountName ?? binding.lineId)).toEqual(["a", "backup", "d", "c"]);
  });

  it("leaves ordering untouched when the active binding declares no cacheDomain", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const router = new Router(new ConfigStore(dir));

    const primary = line("a", 0);
    const second = line("c", 1);
    const third = line("b", 2, { cacheDomain: "shared" });

    const selection = router.select("gpt", [primary, second, third], SESSION);
    expect(selection.attempts.map((binding) => binding.lineId)).toEqual(["a", "c", "b"]);
  });

  it("applies cacheDomain ordering around an affinity hit", () => {
    const dir = writeConfig({ strategy: "failover" });
    tempDirs.push(dir);
    const router = new Router(new ConfigStore(dir));

    const first = line("a", 0);
    const sameDomain = line("d", 1, { cacheDomain: "shared" });
    const affine = line("b", 2, { cacheDomain: "shared" });

    router.setAffinity(SESSION, "gpt", affine);
    const selection = router.select("gpt", [first, sameDomain, affine], SESSION);

    expect(selection.affinityHit).toBe(true);
    expect(selection.binding.lineId).toBe("b");
    expect(selection.attempts.map((binding) => binding.lineId)).toEqual(["b", "d", "a"]);
  });
});
