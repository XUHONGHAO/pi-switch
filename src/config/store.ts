/**
 * ConfigStore (Phase 8: /config UI)
 *
 * Holds the pi-switch configuration as a live, reloadable object instead of
 * a startup snapshot:
 *
 *   - `get()`        : current in-memory config (all consumers read through it)
 *   - `reload()`     : re-read all sections from disk (after external edits)
 *   - `saveSection()`: write one section back to its JSON file + reload
 *
 * Consumers (ModelResolver / Router / AccountManager / AliasProvider) take
 * the store in their constructor and call `store.get()` on every access, so
 * a config change made through the /config UI is visible immediately without
 * restarting pi.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type PiSwitchConfig } from "./loader";
import { reportValidation, validateConfig } from "./validate";
import { replaceFile } from "../utils/atomic-file";

/** Config file sections that can be edited and persisted. */
export type ConfigSection = "providers" | "accounts" | "models" | "routing";

export class ConfigStore {
  private config: PiSwitchConfig;

  constructor(configDir?: string) {
    this.config = loadConfig(configDir);
    reportValidation(validateConfig(this.config));
  }

  /** Current in-memory configuration. */
  get(): PiSwitchConfig {
    return this.config;
  }

  /** Absolute path to the config directory. */
  dir(): string {
    return this.config.configDir;
  }

  /** Absolute path to a section's JSON file. */
  pathFor(section: ConfigSection): string {
    return join(this.config.configDir, `${section}.json`);
  }

  /** Re-read all sections from disk. */
  reload(): PiSwitchConfig {
    this.config = loadConfig(this.config.configDir);
    reportValidation(validateConfig(this.config));
    return this.config;
  }

  /**
   * Persist one section to disk and reload. Returns the new config.
   * Throws on write failure so the caller can surface the error.
   */
  saveSection(section: ConfigSection, data: unknown): PiSwitchConfig {
    const next = { ...this.config, [section]: data ?? {} } as PiSwitchConfig;
    const validation = validateConfig(next);
    if (validation.errors.length > 0) {
      throw new Error(`invalid configuration:\n${validation.errors.map((error) => `- ${error}`).join("\n")}`);
    }
    reportValidation(validation);

    const file = this.pathFor(section);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const backup = `${file}.bak`;
    mkdirSync(this.config.configDir, { recursive: true });
    try {
      writeFileSync(temp, JSON.stringify(data ?? {}, null, 2) + "\n", "utf-8");
      if (existsSync(file)) copyFileSync(file, backup);
      replaceFile(temp, file);
      return this.reload();
    } catch (err) {
      if (existsSync(backup)) copyFileSync(backup, file);
      throw err;
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
