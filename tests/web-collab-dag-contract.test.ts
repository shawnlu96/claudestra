/**
 * 契约：L4 的快照喂给前端模型能完整画出来（两张图、手机分节）。L4 的 src 投影（src/lib/ledger-dag-board.ts）合并前先用手造的快照，
 * 形状照 i28-L4 规格第 1 条；L4 合并后改成临时台账跑 src 投影、把输出赋给 web 手抄的类型（i28-V1 规格「契约测试」）。
 */
import { describe, expect, test } from "bun:test";
import { defaultOpen, drawable, layoutDag, MAX_OPEN, nodeId, topoOrder } from "../web/features/collab/dag/dag-layout";
import { ownerOf, progressRows, rowOf } from "../web/features/collab/dag/dag-progress";
import type { DagBoard } from "../web/features/collab/dag/dag-types";
import { board, feature, node } from "./web-collab-dag-fixture";

const snapshot: DagBoard = board([
  feature("b5cf-i28", [node("L4", "done"), node("V1", "active", ["L4"]), node("T4", "active"), node("V2", "idle", ["V1", "T4"])], { lastActivityAt: 900, currentVersion: 12 }),
  ...Array.from({ length: 9 }, (_, i) => feature(`f${i}`, [node("A", "active"), node("B", "done", [])], { lastActivityAt: 100 + i })),
  feature("draft", [], { currentVersion: 0, version: null }),
  feature("paused", [node("P", "active")], { status: "paused" }),
]);

describe("L4 快照 → 子 DAG 图", () => {
  const open = defaultOpen(snapshot.features);
  const c = layoutDag(snapshot.features, open, new Set());

  test("默认展开不超过 MAX_OPEN，没建图的 feature 不进图", () => {
    expect(open.length).toBe(MAX_OPEN);
    expect(drawable(snapshot.features).some((f) => f.id === "draft")).toBe(false);
    expect(c.groups.length).toBe(MAX_OPEN);
  });
  test("展开的 feature 里每个节点都画了：自己一个框，或收在 ✓N 里；✓N 和 counts.done 对得上", () => {
    for (const g of c.groups) {
      for (const n of g.feature.nodes) expect(c.boxOf.has(nodeId(g.id, n.key))).toBe(true);
      expect(g.folds.reduce((s, f) => s + f.n, 0)).toBe(g.feature.counts.done);
    }
  });
});

describe("L4 快照 → 进度图", () => {
  const rows = progressRows(snapshot.agents, [], snapshot.project);
  test("PM 有行且在最前；每个进行中节点的负责人都有行", () => {
    expect(rows[0]!.pm).toBe(true);
    for (const f of drawable(snapshot.features)) {
      for (const n of f.nodes.filter((x) => x.phase === "active")) expect(rowOf(rows, ownerOf(rows, f.id, n)!.agent)).not.toBeNull();
    }
  });
});

describe("L4 快照 → 手机分节", () => {
  test("节内按拓扑序：前置在前", () => {
    const f = snapshot.features[0]!;
    const keys = topoOrder(f.nodes).map((n) => n.key);
    expect(keys.indexOf("V1")).toBeLessThan(keys.indexOf("V2"));
    expect(keys.indexOf("T4")).toBeLessThan(keys.indexOf("V2"));
  });
});
