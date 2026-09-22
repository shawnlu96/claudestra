/**
 * 两张模型表的一致性闸门。
 *
 * 模型清单在两处各写一份——后端 `MODEL_ALIASES`（src/lib/claude-launch.ts，
 * `create --model` / `manager model list` 用）和前端 `MODEL_CATALOG`
 * （web/features/chat/claude-options.ts，新建弹窗 / 切换器 / 全局默认用）。
 *
 * **为什么不合成一张**：web 是独立构建，tsconfig 的 include 只覆盖 web/，
 * 拿不到 src/ 的任何东西；要真共享就得让前端运行时从 bridge 拉一次清单——
 * 为 7 行常量铺一整条异步路径（新 API route + loading 态 + 失败回退）不划算。
 *
 * 真正的问题从来不是「两份」，是**漂移**：加模型时只改一边。
 * 2026-09-15 就栽过一次（claude-options.ts 注释原话：「此前新建弹窗自维护一份
 * 别名列表，与这里漂移过，**两边都漏了 Sonnet 5**」）。这个文件把漂移变成红灯。
 */
import { describe, expect, test } from "bun:test";
import { MODEL_ALIASES } from "../src/lib/claude-launch";
import { MODEL_CATALOG } from "../web/features/chat/claude-options";

/** 裸家族名（opus / sonnet / …）始终跟该家族最新版，故意不进 UI——见两边注释。 */
const isVersioned = (alias: string) => alias.includes("-");

describe("模型表一致性（后端 MODEL_ALIASES ↔ 前端 MODEL_CATALOG）", () => {
  test("前端每个条目的 alias 在后端存在，且 id 对得上", () => {
    for (const { alias, id, label } of MODEL_CATALOG) {
      expect(MODEL_ALIASES[alias], `前端有 "${alias}"（${label}），后端别名表里没有`).toBeDefined();
      expect(MODEL_ALIASES[alias], `别名 "${alias}" 两边指向不同的 model id`).toBe(id);
    }
  });

  test("后端每个带版本号的别名都出现在前端下拉里", () => {
    const uiAliases = new Set<string>(MODEL_CATALOG.map((m) => m.alias));
    for (const alias of Object.keys(MODEL_ALIASES)) {
      if (!isVersioned(alias)) continue;
      expect(uiAliases.has(alias), `后端有 "${alias}"，前端下拉里选不到（加模型时漏了一边）`).toBe(true);
    }
  });

  test("裸家族名指向的那一代，前端下拉里有对应的带版本号条目", () => {
    const uiIds = new Set<string>(MODEL_CATALOG.map((m) => m.id));
    for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
      if (isVersioned(alias)) continue;
      expect(uiIds.has(id), `裸名 "${alias}" → ${id}，但前端下拉里没有这一代`).toBe(true);
    }
  });

  test("前端 label 不重复，id 不重复", () => {
    expect(new Set(MODEL_CATALOG.map((m) => m.id)).size).toBe(MODEL_CATALOG.length);
    expect(new Set(MODEL_CATALOG.map((m) => m.label)).size).toBe(MODEL_CATALOG.length);
  });
});
