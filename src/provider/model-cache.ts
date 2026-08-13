import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { replaceFile } from "../utils/atomic-file";

interface CacheFile {
  provider: string;
  updatedAt: number;
  models: ProviderModelConfig[];
}

function safeName(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class ModelCache {
  constructor(private readonly configDir: string) {}

  private path(provider: string): string {
    return join(this.configDir, "cache", "models", `${safeName(provider)}.json`);
  }

  load(provider: string): ProviderModelConfig[] {
    const file = this.path(provider);
    try {
      if (!existsSync(file)) return [];
      const value = JSON.parse(readFileSync(file, "utf-8")) as Partial<CacheFile>;
      return Array.isArray(value.models) ? value.models : [];
    } catch (err) {
      console.warn(`[pi-switch] model cache "${provider}" ignored: ${(err as Error).message}`);
      return [];
    }
  }

  save(provider: string, models: ProviderModelConfig[]): void {
    const file = this.path(provider);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    mkdirSync(join(this.configDir, "cache", "models"), { recursive: true });
    try {
      writeFileSync(temp, JSON.stringify({ provider, updatedAt: Date.now(), models } satisfies CacheFile, null, 2) + "\n");
      replaceFile(temp, file);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
