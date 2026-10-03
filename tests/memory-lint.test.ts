/** pmem-M2 验收线 3：设计稿 §2.3 八条「不记什么」各有拒绝用例（memoryLint），另有不误伤的对照 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { markMemory, recordMemory } from "../src/lib/ledger-memory.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { filesOverlap, lintText, memoryLint, type MemoryLintInput } from "../src/lib/memory-lint.js";

const P = "demo";
let db: Database;
const GOOD: MemoryLintInput = {
  project: P, kind: "pitfall", title: "bun:sqlite 事务回调里不能 await", symptom: "事务提前提交，已合并的后半段写丢了", rule: "事务内只做同步写，异步 IO 放事务外",
  files: ["src/lib/widget-store.ts"], family: "widget-tx", fixable: true, via: "tool", authorRole: "reviewer", sources: [{ seq: 3 }],
};
const rejected = (patch: Partial<MemoryLintInput>, rule: number) => {
  const r = memoryLint(db, { ...GOOD, ...patch });
  expect(r).toMatchObject({ ok: false, rule });
  return r as { error: string };
};

beforeEach(() => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
});
afterEach(() => closeLedger(":memory:"));

describe("§2.3 八条各一条拒绝", () => {
  test("1 进度 / 状态", () => {
    rejected({ title: "已完成 widget 批量写" }, 1);
    rejected({ title: "等审查：N3 已推送" }, 1);
  });
  test("2 代码本身读得出的事实", () => {
    rejected({ title: "foo 函数在 bar.ts" }, 2);
    rejected({ rule: "常量 WIRE_LIMITS 定义在 order-wire.ts" }, 2);
  });
  test("3 规格复述 / 一次性的错别字、格式、命名意见 / P2", () => {
    rejected({ title: "变量命名不统一" }, 3);
    rejected({ rule: "规格里写了要用 CAS" }, 3);
    rejected({ severity: "P2" }, 3);
  });
  test("4 环境个例", () => {
    rejected({ title: "本机 bun 版本和 CI 不同会崩" }, 4);
    rejected({ rule: "网络超时就重跑" }, 4);
  });
  test("5 无来源的推测（执行者 / 系统没来源；导入没 sourceNote）", () => {
    rejected({ authorRole: "executor", sources: [] }, 5);
    rejected({ authorRole: "system", via: "p1_family", sources: [] }, 5);
    rejected({ authorRole: "pm", via: "import", sources: [], sourceNote: null }, 5);
  });
  test("6 秘密、地址、本机绝对路径、个人信息、商业内容：只报字段位置，不带原文", () => {
    const token = "ghp_" + "a".repeat(30);
    const e = rejected({ symptom: `日志里出现 ${token}` }, 6);
    expect(e.error).toContain("symptom");
    expect(e.error).not.toContain(token);
    rejected({ rule: "连 8.8.8.8 前先探活" }, 6);
    rejected({ files: ["/Users/someone/repo/x.ts"] }, 6);
    rejected({ rule: "日志写到 /tmp/x 里看" }, 6);
    rejected({ symptom: "联系 someone@example.com 才知道" }, 6);
    rejected({ symptom: "客户报价 ¥30000 时出错" }, 6);
  });
  test("7 重复：同 family + 文件有交集的 open 坑；同内容；语义余弦 ≥0.92", () => {
    recordMemory(db, { actor: "agent-r", now: 1 }, { ...GOOD, title: "旧的同类坑" });
    const e = rejected({ files: ["src/lib/widget-*.ts"] }, 7);
    expect(e.error).toContain("mark_memory confirm ab12-m1");
    expect(memoryLint(db, { ...GOOD, family: "other-fam" }).ok).toBe(true);
    recordMemory(db, { actor: "agent-r", now: 1 }, { ...GOOD, family: "x2" });
    expect(memoryLint(db, { ...GOOD, family: "x3" })).toMatchObject({ ok: false, rule: 7, duplicateOf: "ab12-m2" });
    expect(memoryLint(db, { ...GOOD, family: "x4", title: "另一种说法" }, { similar: () => [{ id: "ab12-m2", cosine: 0.95 }] })).toMatchObject({ ok: false, rule: 7 });
    expect(memoryLint(db, { ...GOOD, family: "x4", title: "另一种说法" }, { similar: () => [{ id: "ab12-m2", cosine: 0.9 }] }).ok).toBe(true);
  });
  test("8 长度超限：直接拒，不截断", () => {
    rejected({ title: "长".repeat(30) }, 8);
    rejected({ rule: "x".repeat(301) }, 8);
    rejected({ files: Array.from({ length: 21 }, (_, i) => `f${i}.ts`) }, 8);
  });
});

describe("不误伤", () => {
  test("正常的坑通过；症状里描述现场（已合并、本机）不算进度 / 环境", () => {
    expect(memoryLint(db, GOOD)).toEqual({ ok: true });
    expect(lintText({ ...GOOD, symptom: "PR 已合并后本机重跑才发现版本号已前进" }).ok).toBe(true);
  });
  test("「要 / 必须」写成的规矩里提到文件名不算代码事实；shell 的 $1 不算商业内容", () => {
    expect(lintText({ ...GOOD, rule: "迁移函数在 ledger-store.ts 里必须逐条 prepare().run()" }).ok).toBe(true);
    expect(lintText({ ...GOOD, rule: "脚本里要引用 $1 而不是 $@" }).ok).toBe(true);
  });
  test("已撤回 / 已修的同类坑不挡新坑", () => {
    recordMemory(db, { actor: "agent-r", now: 1 }, { ...GOOD, title: "旧的同类坑" });
    markMemory(db, { actor: "owner", now: 2 }, { memoryId: "ab12-m1", mark: "retract", reason: "记错" });
    expect(memoryLint(db, GOOD).ok).toBe(true);
  });
  test("filesOverlap：路径对 glob、glob 对 glob、两边都空", () => {
    expect(filesOverlap(["src/a/x.ts"], ["src/a/*.ts"])).toBe(true);
    expect(filesOverlap(["src/lib/*-schema.ts"], ["src/lib/widget-*.ts"])).toBe(true);
    expect(filesOverlap(["src/lib/*-import.ts"], ["web/**"])).toBe(false);
    expect(filesOverlap([], [])).toBe(true);
    expect(filesOverlap([], ["a.ts"])).toBe(false);
  });
});
