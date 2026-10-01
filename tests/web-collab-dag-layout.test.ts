/** 子 DAG 图的布局（web/features/collab/dag/dag-layout.ts）与节点内进度条（dag-steps.ts）：分列、不重叠、done 折叠、MAX_OPEN、线 */
import { describe, expect, test } from "bun:test";
import { defaultOpen, foldId, layoutDag, longestPath, MAX_OPEN, nodeId, openWith, topoOrder, type DagCanvas } from "../web/features/collab/dag/dag-layout";
import { nodeSteps } from "../web/features/collab/dag/dag-steps";
import { feature, node } from "./web-collab-dag-fixture";

const overlaps = (c: DagCanvas) => {
  const boxes = c.groups.flatMap((g) => [...g.nodes, ...g.folds]);
  return boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
};

describe("longestPath / topoOrder", () => {
  test("列号沿依赖的最长路径，环不死循环", () => {
    const r = longestPath([node("A", "done"), node("B", "active", ["A"]), node("C", "idle", ["A", "B"]), node("D", "idle", ["D"])]);
    expect([r.get("A"), r.get("B"), r.get("C")]).toEqual([0, 1, 2]);
    expect(Number.isFinite(r.get("D"))).toBe(true); // 自环：在环上停，给个有限列号
  });
  test("拓扑序：列号优先，同列进行中在前", () => {
    const order = topoOrder([node("Z", "idle"), node("Y", "active"), node("X", "idle", ["Y"])]).map((n) => n.key);
    expect(order).toEqual(["Y", "Z", "X"]);
  });
});

describe("layoutDag", () => {
  const f = feature("f1", [node("A", "done"), node("B", "done", ["A"]), node("C", "active", ["B"]), node("D", "idle", ["C"]), node("E", "active", ["A"])]);

  test("done 折成框角的 ✓N，N = counts.done；连向它们的线收到 ✓N 上", () => {
    const c = layoutDag([f], ["f1"], new Set());
    const g = c.groups[0]!;
    expect(g.nodes.map((n) => n.key).sort()).toEqual(["C", "D", "E"]);
    expect(g.folds).toHaveLength(1);
    expect(g.folds[0]!.n).toBe(f.counts.done);
    expect(c.boxOf.get(nodeId("f1", "A"))).toBe(foldId("f1"));
    const edges = c.edges.map((e) => `${e.from}>${e.to}`).sort();
    expect(edges).toEqual([`${foldId("f1")}>${nodeId("f1", "C")}`, `${foldId("f1")}>${nodeId("f1", "E")}`, `${nodeId("f1", "C")}>${nodeId("f1", "D")}`].sort());
    expect(overlaps(c)).toBe(false);
  });

  test("点开 ✓N：done 节点按列画出来，不再有折叠", () => {
    const c = layoutDag([f], ["f1"], new Set(["f1"]));
    const g = c.groups[0]!;
    expect(g.folds).toHaveLength(0);
    expect(g.nodes).toHaveLength(5);
    const x = (k: string) => g.nodes.find((n) => n.key === k)!.x;
    expect(x("A")).toBeLessThan(x("B"));
    expect(x("B")).toBeLessThan(x("C"));
    expect(x("C")).toBeLessThan(x("D"));
    expect(overlaps(c)).toBe(false);
  });

  test("实线 = 前置已满足，点线 = 没满足；只画 deps", () => {
    const c = layoutDag([f], ["f1"], new Set(["f1"]));
    const edge = (a: string, b: string) => c.edges.find((e) => e.id === `${nodeId("f1", a)}>${nodeId("f1", b)}`);
    expect(edge("A", "B")!.solid).toBe(true);
    expect(edge("C", "D")!.solid).toBe(false);
    expect(c.edges).toHaveLength(4); // A>B B>C C>D A>E，没有别的线
  });

  test("已完成节点依赖没完成的（往回连）：收起时不画进 ✓N 的线，点开后照画", () => {
    const back = feature("b", [node("A", "active"), node("D", "done", ["A"])]);
    expect(layoutDag([back], ["b"], new Set()).edges).toHaveLength(0);
    expect(layoutDag([back], ["b"], new Set(["b"])).edges.map((e) => e.id)).toEqual([`${nodeId("b", "A")}>${nodeId("b", "D")}`]);
  });

  test("进行中与 missing 是完整节点，没开始是小节点；missing 照样画", () => {
    const g = layoutDag([feature("f", [node("M", "active", [], { missing: true, status: null, handler: null }), node("I", "idle")])], ["f"], new Set()).groups[0]!;
    expect(g.nodes.find((n) => n.key === "M")!.kind).toBe("full");
    expect(g.nodes.find((n) => n.key === "I")!.kind).toBe("mini");
  });

  test("多个框上下排开，互不重叠；没展开的 feature 不画；没建图的不画", () => {
    const fs = [feature("a", [node("A", "active")]), feature("b", [node("B", "active")]), feature("c", [], { currentVersion: 0 })];
    const c = layoutDag(fs, ["a", "b", "c"], new Set());
    expect(c.groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(c.groups[1]!.y).toBeGreaterThan(c.groups[0]!.y + c.groups[0]!.h);
    expect(layoutDag(fs, ["b"], new Set()).groups.map((g) => g.id)).toEqual(["b"]);
  });
});

describe("MAX_OPEN", () => {
  const many = Array.from({ length: 12 }, (_, i) => feature(`f${i}`, [node("A", i === 3 ? "idle" : "active")], { lastActivityAt: 100 + i }));

  test("默认展开：active 且有进行中节点的，按 lastActivityAt 降序，最多 MAX_OPEN 个", () => {
    const fs = [...many, feature("paused", [node("A", "active")], { status: "paused", lastActivityAt: 999 })];
    const open = defaultOpen(fs);
    expect(open).toHaveLength(MAX_OPEN);
    expect(open[0]).toBe("f11");
    expect(open).not.toContain("f3"); // 没有进行中节点
    expect(open).not.toContain("paused");
  });

  test("再展开第 9 个：挤掉最久没动静的那个", () => {
    const open = defaultOpen(many);
    const r = openWith(open, "f0", many);
    expect(r.open).toHaveLength(MAX_OPEN);
    expect(r.open).toContain("f0");
    const oldest = open.reduce((a, b) => (many.find((f) => f.id === a)!.lastActivityAt! < many.find((f) => f.id === b)!.lastActivityAt! ? a : b));
    expect(r.evicted).toBe(oldest);
    expect(r.open).not.toContain(oldest);
    expect(openWith(open.slice(0, 3), "f0", many)).toEqual({ open: [...open.slice(0, 3), "f0"], evicted: null });
  });
});

describe("nodeSteps：节点内进度条（不是节点）", () => {
  test("复述做完、写进行中", () => {
    const s = nodeSteps(node("A", "active").stepLine);
    expect(s.slots.map((x) => x.state)).toEqual(["done", "cur", "todo", "todo", "todo", "todo"]);
    expect(s.current?.key).toBe("write");
  });
  test("终审并进「审」一格，轮次取大的；没有 stepLine 全空", () => {
    const s = nodeSteps({ active: { step: "final_review", round: 3 }, steps: [{ step: "review", round: 2, state: "done" }, { step: "write", round: 1, state: "done" }] });
    expect(s.current).toMatchObject({ key: "review", round: 3 });
    expect(nodeSteps(null).slots.every((x) => x.state === "todo")).toBe(true);
  });
});
