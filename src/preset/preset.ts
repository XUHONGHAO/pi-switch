/**
 * Preset system (Phase 5)
 *
 * Compatible with pi's native preset format (~/.pi/agent/presets.json and
 * <cwd>/.pi/presets.json). A preset with `"provider": "pi-switch"` routes
 * through the alias system: its `model` is an alias (e.g. "gpt5") resolved
 * via the virtual pi-switch provider.
 *
 * Exposes a handler for the `preset` subcommand dispatched by `/switch`.
 * Commands with spaces are not registered because pi parses only the first
 * token as the extension command name.
 *
 * Pi-switch presets also work transparently through the native preset
 * extension: when it calls pi.setModel("pi-switch", "gpt5"), the alias
 * provider handles routing automatically.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** A pi preset that routes through pi-switch. */
export interface PiSwitchPreset {
  provider: "pi-switch";
  /** Model alias, e.g. "gpt5". */
  model: string;
  /** Instructions appended to the system prompt. */
  instructions?: string;
}

/** Load pi-switch presets from global and project preset files (merged). */
export function loadPiSwitchPresets(cwd: string): Record<string, PiSwitchPreset> {
  const paths = [join(getAgentDir(), "presets.json"), join(cwd, CONFIG_DIR_NAME, "presets.json")];
  const presets: Record<string, PiSwitchPreset> = {};

  for (const file of paths) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      for (const [name, value] of Object.entries(parsed)) {
        const preset = value as Partial<PiSwitchPreset>;
        if (preset.provider === "pi-switch" && preset.model) {
          presets[name] = { provider: "pi-switch", model: preset.model, ...(preset.instructions ? { instructions: preset.instructions } : {}) };
        }
      }
    } catch (err) {
      console.error(`[pi-switch] Failed to load presets from ${file}: ${(err as Error).message}`);
    }
  }
  return presets;
}

/** Handle the `preset [name]` subcommand dispatched by `/switch`. */
export async function handlePresetCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const presets = loadPiSwitchPresets(ctx.cwd);
  const names = Object.keys(presets);

  if (names.length === 0) {
    ctx.ui.notify(
      `尚未配置 pi-switch 预设。请在 ${join(getAgentDir(), "presets.json")} 中添加 { provider: "pi-switch", model: "gpt5" }`,
      "warning",
    );
    return;
  }

  const name = args.trim();
  if (name) {
    const preset = presets[name];
    if (!preset) {
      console.log(`[pi-switch] /switch preset ${name}: unknown preset (available: ${names.join(", ")})`);
      ctx.ui.notify(`未知预设 "${name}"。可用预设: ${names.join(", ")}`, "error");
      return;
    }
    await applyPreset(name, preset, ctx);
    return;
  }

  const choice = await ctx.ui.select("选择预设", names);
  if (!choice) return;
  const preset = presets[choice];
  if (preset) await applyPreset(choice, preset, ctx);
}

async function applyPreset(name: string, preset: PiSwitchPreset, ctx: ExtensionCommandContext): Promise<void> {
  const model = ctx.modelRegistry.find("pi-switch", preset.model);
  if (!model) {
    console.log(`[pi-switch] /switch preset ${name}: alias "${preset.model}" not found`);
    ctx.ui.notify(`预设 "${name}" 引用的别名 "${preset.model}" 不存在，请检查 models.json`, "warning");
    return;
  }
  const ok = await setCurrentModel(model);
  if (ok) {
    console.log(`[pi-switch] /switch preset ${name}: activated pi-switch/${preset.model}`);
    const instructionsNote = preset.instructions ? "（附加指令需使用 pi 原生 /preset 命令才会生效）" : "";
    ctx.ui.notify(`预设 "${name}" 已启用: pi-switch/${preset.model}${instructionsNote}`, "info");
  } else {
    console.log(`[pi-switch] /switch preset ${name}: no API key for pi-switch/${preset.model}`);
    ctx.ui.notify(`预设 "${name}" 对应的 pi-switch/${preset.model} 没有可用的 API Key`, "warning");
  }
}

// pi.setModel is only available on the ExtensionAPI; commands receive ctx.
// Bridge via the model registry + extension API passed at registration time.
let setModelFn: ((model: unknown) => Promise<boolean>) | undefined;

/** Bind pi.setModel for preset/switch commands. Called from the entry point. */
export function bindSetModel(fn: (model: unknown) => Promise<boolean>): void {
  setModelFn = fn;
}

/** Set the current model via the bound pi.setModel. Returns false on failure. */
export async function setCurrentModel(model: unknown): Promise<boolean> {
  if (!setModelFn) return false;
  return setModelFn(model);
}
