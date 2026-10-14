/** 子 DAG 聚焦图（web/features/collab/dag/dag-focus-layout.ts，team-project-SUBDAG7）：三列成员、归列、重心排序、两枚小片、线、null、确定性 */
import { describe, expect, test } from "bun:test";
import { layoutFocus } from "../web/features/collab/dag/dag-focus-layout";
import { foldId, nodeId, type DagCanvas } from "../web/features/collab/dag/dag-layout";
import { feature, mainlineFeature, node } from "./web-collab-dag-fixture";

/** 按 x 分列（左 → 右），列内按 y */
function columns(c: DagCanvas): string[][] {
  const nodes = c.groups[0]!.nodes;
  const xs = [...new Set(nodes.map((n) => n.x))].sort((a, b) => a - b);
  return xs.map((x) => nodes.filter((n) => n.x === x).sort((a, b) => a.y - b.y).map((n) => n.key));
}
const overlaps = (c: DagCanvas) => {
  const boxes = c.groups.flatMap((g) => [...g.nodes, ...g.folds]);
  return boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
};

describe("layoutFocus", () => {
  test("主线形状：中列 8 张完整卡，左列上游一跳，右列下游一跳；两枚小片带数", () => {
    const f = mainlineFeature();
    const c = layoutFocus(f)!;
    const g = c.groups[0]!;
    expect(g.focus).toBe(true);
    const [left, mid, right] = columns(c);
    expect(left).toEqual(["d30"]);
    expect(mid).toEqual(["a-owner", "a-ci", "a-pool", "a-mq", "a-over", "a-w1", "a-w2", "a-peer"]);
    expect([...right!].sort()).toEqual(["f7", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
    expect(g.nodes.filter((n) => n.kind === "full")).toHaveLength(8);
    expect(g.nodes.filter((n) => mid!.includes(n.key)).every((n) => n.kind === "full")).toBe(true);
    expect(g.nodes.filter((n) => !mid!.includes(n.key)).every((n) => n.kind === "mini")).toBe(true);
    expect(g.folds.map((x) => [x.kind, x.n])).toEqual([["rest", 29], ["far", 8]]);
    expect(g.folds.every((x) => x.members.length === 0)).toBe(true);
    // 「其余」在左列顶上，「更远」在右列底下，都不另占列
    const at = (k: string) => g.nodes.find((n) => n.key === k)!;
    expect([g.folds[0]!.x, g.folds[0]!.y < at("d30").y]).toEqual([at("d30").x, true]);
    expect([g.folds[1]!.x, g.folds[1]!.y > Math.max(...right!.map((k) => at(k).y))]).toEqual([at("n1").x, true]);
    expect(c.w).toBe(14 * 2 + 3 * 220 + 2 * 72);
    expect(overlaps(c)).toBe(false);
  });

  test("missing 节点进中列，是完整卡", () => {
    const f = feature("m", [node("A", "active"), node("M", "idle", [], { missing: true }), node("B", "idle", ["M"])]);
    const [mid, right] = columns(layoutFocus(f)!);
    expect(mid).toEqual(["A", "M"]);
    expect(right).toEqual(["B"]);
  });

  test("既是上游又是下游：已完成的放左列，否则放右列", () => {
    const f = feature("x", [
      node("A", "active"), node("D", "done", ["A"]), node("I", "idle", ["A"]), node("B", "active", ["D", "I"]),
    ]);
    const [left, mid, right] = columns(layoutFocus(f)!);
    expect(left).toEqual(["D"]);
    expect(mid).toEqual(["A", "B"]);
    expect(right).toEqual(["I"]);
  });

  test("重心排序：左列按进行中下游、右列按进行中上游在中列的平均位置，平手按 key", () => {
    // 中列 topoOrder：P0 P1 P2 P3（同列，快照顺序）
    const f = feature("g", [
      node("u-z", "done"), node("u-b", "done"), node("u-a", "done"), node("u-m", "idle"),
      node("P0", "active", ["u-z", "u-a"]), node("P1", "active", ["u-b"]), node("P2", "active", ["u-m", "u-b"]), node("P3", "active", ["u-a"]),
      node("r-c", "idle", ["P3"]), node("r-b", "idle", ["P0", "P2"]), node("r-a", "idle", ["P1"]), node("r-d", "idle", ["P0"]),
    ]);
    const [left, mid, right] = columns(layoutFocus(f)!);
    expect(mid).toEqual(["P0", "P1", "P2", "P3"]);
    // u-z: 0；u-a: (0+3)/2=1.5；u-b: (1+2)/2=1.5；u-m: 2 → u-z, u-a, u-b（平手按 key）, u-m
    expect(left).toEqual(["u-z", "u-a", "u-b", "u-m"]);
    // r-d: 0；r-a: 1；r-b: (0+2)/2=1；r-c: 3 → r-d, r-a, r-b, r-c
    expect(right).toEqual(["r-d", "r-a", "r-b", "r-c"]);
  });

  test("小片 N：N = 0 不出；左列画出的已完成从「其余」里扣掉", () => {
    const none = layoutFocus(feature("n", [node("A", "active"), node("B", "idle", ["A"])]))!;
    expect(none.groups[0]!.folds).toEqual([]);
    const some = layoutFocus(feature("s", [node("D1", "done"), node("D2", "done", ["D1"]), node("A", "active", ["D2"]), node("B", "idle", ["A"]), node("C", "idle", ["B"])]))!;
    expect(some.groups[0]!.folds.map((x) => [x.kind, x.n, x.id])).toEqual([["rest", 1, `${foldId("s")}:rest`], ["far", 1, `${foldId("s")}:far`]]);
  });

  test("线只连画出来的节点", () => {
    const f = feature("e", [node("D1", "done"), node("D2", "done", ["D1"]), node("A", "active", ["D2"]), node("B", "idle", ["A"]), node("C", "idle", ["B"])]);
    const c = layoutFocus(f)!;
    expect(c.edges.map((e) => e.id).sort()).toEqual([`${nodeId("e", "A")}>${nodeId("e", "B")}`, `${nodeId("e", "D2")}>${nodeId("e", "A")}`].sort());
    expect(c.edges.find((e) => e.id === `${nodeId("e", "D2")}>${nodeId("e", "A")}`)!.solid).toBe(true);
    expect(c.edges.find((e) => e.id === `${nodeId("e", "A")}>${nodeId("e", "B")}`)!.solid).toBe(false);
    expect([...c.boxOf.keys()].sort()).toEqual(["A", "B", "D2"].map((k) => nodeId("e", k)).sort());
  });

  test("没有进行中节点：返回 null", () => {
    expect(layoutFocus(feature("z", [node("A", "done"), node("B", "idle", ["A"])]))).toBeNull();
    expect(layoutFocus(feature("z", []))).toBeNull();
  });

  test("同一输入两次结果一样", () => {
    expect(layoutFocus(mainlineFeature())).toEqual(layoutFocus(mainlineFeature()));
  });
});
