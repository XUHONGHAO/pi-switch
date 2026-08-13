/**
 * Model selector UI (Phase 5)
 *
 * /switch model picker. In TUI mode it renders a SelectList with per-alias
 * line descriptions via ctx.ui.custom; in non-TUI modes it falls back to
 * ctx.ui.select.
 *
 *   Select Model
 *   > GPT-5            sub2api/gpt-5, openai_official/gpt-5
 *     Claude Sonnet    sub2api/claude-sonnet-4-5
 *     Gemini
 *     Local Model
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import type { ModelAliasConfig } from "../config/loader";

/** A single entry shown in the /switch picker. */
export interface SelectorItem {
  alias: string;
  label: string;
  description?: string;
}

/** Map model aliases to picker items, sorted by display name. */
export function toSelectorItems(models: Record<string, ModelAliasConfig>): SelectorItem[] {
  return Object.entries(models)
    .map(([alias, cfg]) => ({
      alias,
      label: cfg.displayName ?? alias,
      description: cfg.providers?.map((p) => `${p.provider}/${p.model}`).join(", "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Show the model picker and return the chosen alias, or undefined when
 * cancelled / no aliases configured.
 */
export async function showModelSelector(
  ctx: ExtensionContext,
  items: SelectorItem[],
): Promise<string | undefined> {
  if (items.length === 0) {
    ctx.ui.notify("尚未配置模型别名，请使用 /config models 添加", "warning");
    return undefined;
  }

  // Non-TUI modes: plain string selector.
  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select("选择模型", items.map((i) => i.label));
    return items.find((i) => i.label === choice)?.alias;
  }

  // TUI: SelectList with descriptions.
  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const border = (str: string) => theme.fg("accent", str);
    const container = new Container();
    container.addChild(new DynamicBorder(border));
    container.addChild(new Text(theme.fg("accent", theme.bold("选择模型"))));

    const listItems = items.map((i) => ({
      value: i.alias,
      label: i.label,
      ...(i.description ? { description: i.description } : {}),
    }));
    const selectList = new SelectList(listItems, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Text(theme.fg("dim", "↑↓ 移动 • Enter 选择 • Esc 取消")));
    container.addChild(new DynamicBorder(border));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}
