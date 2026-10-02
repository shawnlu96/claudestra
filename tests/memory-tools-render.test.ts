/** PM 定 lend-memory-read：出借单直接附记忆全文、总字数有上限、超出截断并注明、不出现 show_memory；本机单是摘要 + show_memory */
import { describe, expect, test } from "bun:test";
import { lendMemorySection, localMemorySection, MEMORY_SECTION_HEAD, type OrderMemoryItem } from "../src/lib/memory-tools-render.js";

const DAY = 86_400_000;
const pit = (id: string, title: string, extra = ""): OrderMemoryItem => ({
  memory: { id, kind: "pitfall", title, body: { symptom: `事务提前提交${extra}`, rule: "事务内只做同步写" }, files: ["src/lib/*-import.ts"], createdAt: 0 },
  status: "open", routes: ["vector"],
});
const sum: OrderMemoryItem = {
  memory: { id: "ab12-m2", kind: "summary", title: "widget 表 + CAS 写", body: "2 轮；P1 cas-missing 第 1 轮修掉", files: ["src/lib/widget-store.ts"], createdAt: 0 },
  status: "open", routes: ["graph", "file", "vector"],
};
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("本机单", () => {
  test("摘要一行一条，带类 / id / 状态 / 路由，末尾 show_memory", () => {
    const s = localMemorySection([pit("ab12-m6", "bun:sqlite 事务回调里不能 await"), sum], 9 * DAY)!;
    expect(s.split("\n")[0]).toBe(MEMORY_SECTION_HEAD);
    expect(s).toContain("- [坑 ab12-m6 · 开放 · 语义] bun:sqlite 事务回调里不能 await：事务提前提交 → 事务内只做同步写");
    expect(s).toContain("- [总结 ab12-m2 · 9 天前 · 图+文件+语义]");
    expect(s).toContain("全文：show_memory <id>");
  });
  test("修复中显示修复卡；一条都没有就不写这一节", () => {
    expect(localMemorySection([{ ...pit("ab12-m3", "写入没包事务"), status: "fixing", fixTask: "N1f" }], 0)).toContain("修复中：N1f");
    expect(localMemorySection([], 0)).toBeNull();
    expect(lendMemorySection([], 0)).toBeNull();
  });
});

describe("出借单", () => {
  test("附全文（症状、规矩、文件），不出现 show_memory", () => {
    const s = lendMemorySection([pit("ab12-m6", "事务回调里不能 await"), sum], 9 * DAY)!;
    expect(s).toContain("症状：事务提前提交");
    expect(s).toContain("规矩：事务内只做同步写");
    expect(s).toContain("文件：src/lib/*-import.ts");
    expect(s).toContain("正文：2 轮；P1 cas-missing 第 1 轮修掉");
    expect(s).not.toMatch(/show_memory/);
  });
  test("超出总字数：放不下的那条截断并注明，其余列出未附；总字节不超上限", () => {
    const items = Array.from({ length: 6 }, (_, i) => pit(`ab12-m${i + 1}`, `坑 ${i + 1}`, "很长".repeat(40)));
    const s = lendMemorySection(items, 0, 1200)!;
    expect(bytes(s)).toBeLessThanOrEqual(1200);
    expect(s).toContain("（字数上限，已截断）");
    expect(s).toMatch(/（另有 \d 条因字数上限未附：ab12-m\d/);
    expect(s).not.toMatch(/show_memory/);
  });
});
