/**
 * web/lib/api/ledger-done.ts 的纯函数：合并页（去重、总览优先、按服务端次序）、补段接没接上、doneRest 形状不对（老 bridge / 坏缓存）一律按 0。
 * 和服务端对着跑的窗口 / 翻页 / 计数一致性在 tests/ledger-read-done.test.ts。
 */
import { describe, expect, test } from "bun:test";
import type { LedgerTaskView } from "../web/features/collab/collab-model";
import { gapClosed, mergeDone, restCount, restInItems, restSum } from "../web/lib/api/ledger-done";

const t = (id: string, endTs: number, stage: LedgerTaskView["stage"] = "verified"): LedgerTaskView => ({ id, title: id, kind: "code", stage, round: 0, updatedAt: endTs + 5, metrics: { endTs } });

describe("mergeDone / gapClosed", () => {
  test("按 id 去重（后到的新）、总览里有的不列、完成时刻倒序同一时刻 id 倒序；endTs 缺省用 updatedAt", () => {
    const pages = [t("a", 30), t("b", 20)];
    const merged = mergeDone(pages, [t("b", 20, "done"), t("c", 20), t("d", 10), { ...t("e", 0), metrics: {}, updatedAt: 25 }], { tasks: [t("d", 10)] });
    expect(merged.map((x) => [x.id, x.stage])).toEqual([["a", "verified"], ["e", "verified"], ["c", "verified"], ["b", "done"]]);
  });

  test("补段：这页最旧的不比已翻到的最新一张新 = 接上了；空页、没有更早的、还没翻过页也算补齐", () => {
    const pages = [t("p1", 100), t("p2", 90)];
    expect(gapClosed(pages, { tasks: [t("g1", 120), t("g2", 110)], nextCursor: "110:g2" })).toBe(false);
    expect(gapClosed(pages, { tasks: [t("g1", 120), t("p1", 100)], nextCursor: "100:p1" })).toBe(true);
    expect(gapClosed(pages, { tasks: [t("g1", 120), t("p0", 100)], nextCursor: "100:p0" })).toBe(true); // 同一毫秒、id 更小 = 更旧
    expect(gapClosed(pages, { tasks: [], nextCursor: null })).toBe(true);
    expect(gapClosed(pages, { tasks: [t("g1", 120)], nextCursor: null })).toBe(true);
    expect(gapClosed([], { tasks: [t("g1", 120)], nextCursor: "120:g1" })).toBe(true);
  });
});

describe("doneRest 读取", () => {
  const rest = {
    n: 5,
    groups: [
      { stage: "verified", kind: "code", blocked: false, p0: true, n: 3, reviewRounds: 4, p0p1: 2 },
      { stage: "cancelled", kind: "ops", blocked: true, p0: false, n: 2, reviewRounds: 1, p0p1: 0 },
    ],
    byItem: { i1: { verified: 3 }, "": { cancelled: 2 } },
  };
  test("按谓词计数 / 求和、按事项取阶段张数", () => {
    const ov = { doneRest: rest };
    expect(restCount(ov, (x) => x.stage === "verified" && (x.metrics.p0 ?? 0) > 0)).toBe(3);
    expect(restCount(ov, (x) => x.kind === "ops" && (x.blockedBy?.length ?? 0) > 0)).toBe(2);
    expect(restSum(ov, () => true, "reviewRounds")).toBe(5);
    expect(restSum(ov, (x) => x.stage === "verified", "p0p1")).toBe(2);
    expect([restInItems(ov, ["i1"], "verified"), restInItems(ov, ["", "x"], "cancelled"), restInItems(ov, ["i1"], "done")]).toEqual([3, 2, 0]);
  });

  test("老 bridge 没有 / 形状不对：一律 0，不抛", () => {
    for (const bad of [undefined, null, 3, "x", [], { groups: "x", byItem: [] }, { n: "5", groups: [null, { stage: 1 }], byItem: { i1: 7 } }]) {
      const ov = { doneRest: bad };
      expect([restCount(ov, () => true), restSum(ov, () => true, "p0p1"), restInItems(ov, ["i1"], "verified")]).toEqual([0, 0, 0]);
    }
  });
});
