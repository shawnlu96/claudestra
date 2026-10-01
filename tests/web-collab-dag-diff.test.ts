/** 子 DAG 版本对比叠图（web/features/collab/dag/dag-diff.ts）：四类分类跟 L4 diff 一致、幽灵节点、rewrittenDone、pending 只当 to */
import { describe, expect, test } from "bun:test";
import { compareOf, compareOverlay, defaultCompare, diffLists, diffMarks } from "../web/features/collab/dag/dag-diff";
import { layoutDag, nodeId } from "../web/features/collab/dag/dag-layout";
import type { DagDiffResponse } from "../web/features/collab/dag/dag-types";
import { feature, node } from "./web-collab-dag-fixture";

// v1：A(done) → B(active) → C(idle)，D(idle)，R(active)
// v2：A、B 带入（B 改了一句话），C 删掉，D 留着，R 换了卡（取消 + 带入有改），X(active) 被取消且移出，N 新加；A 是被改写过的已完成节点
const from = [node("A", "done"), node("B", "active", ["A"]), node("C", "idle", ["B"]), node("D", "idle"), node("R", "active"), node("X", "active", ["A"])];
const to = [node("A", "done"), node("B", "active", ["A"], { oneLine: "新的一句" }), node("D", "idle"), node("R", "active", [], { taskId: "T-R2" }), node("N", "idle", ["B"])];
const resp: Pick<DagDiffResponse, "diff" | "rewrittenDone"> = {
  diff: {
    added: ["N"], removed: ["C"],
    carried: [{ key: "A", changed: true }, { key: "B", changed: true }, { key: "D", changed: false }, { key: "R", changed: true }],
    cancelled: [{ key: "R", taskId: "T-R", reason: "换人重做" }, { key: "X", taskId: "T-X", reason: "范围砍掉" }],
  },
  rewrittenDone: ["A"],
};

describe("diffMarks", () => {
  const m = diffMarks(resp, new Set(to.map((n) => n.key)));
  test("增 / 删（幽灵）/ 带入有改 / 取消（带原因）各归各类", () => {
    expect(m.get("N")).toEqual({ added: true });
    expect(m.get("C")).toEqual({ ghost: true });
    expect(m.get("B")).toEqual({ changed: true });
    expect(m.has("D")).toBe(false);
    expect(m.get("X")).toEqual({ cancelled: "范围砍掉", ghost: true });
  });
  test("key 还在、换了卡：同时是带入有改和取消，不画幽灵", () => {
    expect(m.get("R")).toEqual({ changed: true, cancelled: "换人重做" });
  });
  test("rewrittenDone 单独标出", () => {
    expect(m.get("A")).toMatchObject({ rewrittenDone: true, changed: true });
  });
});

describe("compareOverlay + layoutDag", () => {
  const f = feature("f", to, { currentVersion: 2 });
  const ov = compareOverlay("f", to, from, resp);
  const c = layoutDag([f], ["f"], new Set(), ov);
  const g = c.groups[0]!;
  const at = (k: string) => g.nodes.find((n) => n.key === k)!;

  test("from 版独有的（删、取消且已不在）画成幽灵，to 版的照画；对比时 done 不折叠", () => {
    expect(ov.ghosts.map((n) => n.key).sort()).toEqual(["C", "X"]);
    expect(at("C").kind).toBe("ghost");
    expect(at("X").kind).toBe("ghost");
    expect(at("A").kind).toBe("mini");
    expect(g.folds).toHaveLength(0);
  });
  test("幽灵节点的位置按 from 版的依赖排：C 在 B 右边，X 在 A 右边", () => {
    expect(at("C").x).toBeGreaterThan(at("B").x);
    expect(at("X").x).toBeGreaterThan(at("A").x);
  });
  test("幽灵节点不连线；标记挂在节点上", () => {
    expect(c.edges.some((e) => e.from === nodeId("f", "C") || e.to === nodeId("f", "C") || e.to === nodeId("f", "X"))).toBe(false);
    expect(at("N").mark).toEqual({ added: true });
    expect(at("A").mark?.rewrittenDone).toBe(true);
  });
});

describe("diffLists / 版本选择", () => {
  test("四类清单（加 rewrittenDone），取消带原因，一句话取所在那一版", () => {
    const l = diffLists(resp, from, to);
    expect(l.added).toEqual([{ key: "N", oneLine: "做 N" }]);
    expect(l.removed).toEqual([{ key: "C", oneLine: "做 C" }]);
    expect(l.changed.map((x) => x.key)).toEqual(["A", "B", "R"]);
    expect(l.changed.find((x) => x.key === "B")!.oneLine).toBe("新的一句");
    expect(l.cancelled).toEqual([{ key: "R", oneLine: "做 R", reason: "换人重做" }, { key: "X", oneLine: "做 X", reason: "范围砍掉" }]);
    expect(l.rewrittenDone.map((x) => x.key)).toEqual(["A"]);
  });
  test("默认对比当前版 vs 上一版；只有 v1 没得比", () => {
    expect(defaultCompare("f", 5)).toEqual({ featureId: "f", from: 4, to: 5 });
    expect(defaultCompare("f", 1)).toBeNull();
  });
  test("pending 只能当 to；小的版本当 from；同一版不成对比", () => {
    expect(compareOf("f", "pending", 3)).toEqual({ featureId: "f", from: 3, to: "pending" });
    expect(compareOf("f", 5, 2)).toEqual({ featureId: "f", from: 2, to: 5 });
    expect(compareOf("f", 2, 2)).toBeNull();
  });
});
