/** web/lib/i18n：{name} 整句插值、字典占位对齐、切语言不再顺带写机器语言 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DICT } from "@/lib/i18n-dict";
import { fillParams } from "@/lib/i18n-fill";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// lib/i18n.tsx 的 t(s, params) = fillParams(zh ? s : DICT[s] ?? s, params)；它带 React，根目录 tsc 没开 jsx，只能这样测
const en = (s: string, params?: Record<string, string | number>) => fillParams(DICT[s] ?? s, params);

describe("fillParams / 整句插值", () => {
  test("中文原样填变量；没传 params 不替换（menu-shell 自己 replace {app} 的老用法照旧）", () => {
    expect(fillParams("证书剩 {n} 天", { n: 30 })).toBe("证书剩 30 天");
    expect(fillParams("在 {app} 中打开")).toBe("在 {app} 中打开");
  });
  test("英文先查字典再填变量；params 里没有的占位原样留着", () => {
    expect(en("证书已过期 {n} 天", { n: 3 })).toBe("Cert expired 3 days ago");
    expect(en("{n} 个会话", { n: 0 })).toBe("0 sessions");
    expect(en("字典里没有的 {a} 和 {b}", { a: 1 })).toBe("字典里没有的 1 和 {b}");
  });
});

describe("字典", () => {
  test("每条译文的 {占位} 与原文一致（漏一个就会把 {n} 原样露给用户）", () => {
    const bad = Object.entries(DICT).filter(([zh, v]) => placeholders(zh).join() !== placeholders(v).join());
    expect(bad).toEqual([]);
  });
});

describe("界面语言只属于本设备", () => {
  // 设备切换 / 启动时顺带 PUT 机器的 config.lang = 「最后启动的设备说了算」，guest 设备还每次 403
  test("lib/i18n.tsx 不写机器设置", () => {
    const src = readFileSync(new URL("../web/lib/i18n.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/putSettings|api\/settings/);
  });
});
