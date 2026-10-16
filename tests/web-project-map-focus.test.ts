/** PDFOCUS1 [验收线 1]：focusSet / criticalPath / highlight 纯函数，数据是 PDLAYOUT1 的 projectMapBoard。 */
import { expect, test } from "bun:test";
import { criticalPath, cpSpan, filterCount, focusSet, highlight } from "../web/features/collab/product/product-focus";
import { productLayout } from "../web/features/collab/product/product-layout";
import type { ProductBoard } from "../web/lib/api/product-board-types";
import { PROJECT_MAP_NOW as now, projectMapBoard } from "./helpers/project-map-fixture";

const board = () => projectMapBoard(now);
const sorted = (s: Set<string>) => [...s].sort();

test("focusSet: 团队项目 → 私有云拆分、共享台账（结构边祖先）、成员名册（锁边一层），不含链 2", () => {
  const layout = productLayout(board());
  const f = focusSet(layout, "f-team");
  expect(sorted(f.nodes)).toEqual(["f-ledger", "f-private", "f-roster", "f-team"]);
  for (const id of ["f-dispatch", "f-merge", "f-sched", "f-lend"]) expect(f.nodes.has(id)).toBe(false);
  expect(sorted(f.edges)).toEqual(["dep:f-ledger>f-private", "dep:f-private>f-team", "lock:f-team>f-private", "lock:f-team>f-roster"]);
});

test("focusSet: 锁边只取一层；独立推进的卡只有它自己", () => {
  const layout = productLayout(board());
  // 成员名册只经锁边连着团队项目：不再往团队项目的祖先走
  expect(sorted(focusSet(layout, "f-roster").nodes)).toEqual(["f-roster", "f-team"]);
  expect(sorted(focusSet(layout, "f-sessions").nodes)).toEqual(["f-sessions"]);
  expect(focusSet(layout, "f-sessions").edges.size).toBe(0);
  // 后代不限层数：调度引擎 → 借算力协议 → 直连优先
  expect(sorted(focusSet(layout, "f-sched").nodes)).toEqual(["f-direct", "f-lend", "f-sched"]);
});

test("criticalPath: 私有云拆分 → 团队项目，约 33 小时；cpHours 全删掉为空", () => {
  const b = board();
  const cp = criticalPath(b, productLayout(b));
  expect(cp).toEqual({ ids: ["f-private", "f-team"], edges: ["dep:f-private>f-team"], hours: 33 });
  for (const f of b.features) if (f.eta?.basis) delete f.eta.basis.cpHours;
  expect(criticalPath(b, productLayout(b))).toEqual({ ids: [], edges: [], hours: 0 });
});

test("criticalPath: 锁边、back 边、已满足的边和 gate 都不进", () => {
  const b = board();
  const hours = (id: string, h: number) => { b.features.find(f => f.id === id)!.eta = { at: null, basis: { cpHours: h } }; };
  // 锁边 团队项目 → 成员名册：给成员名册很大的权重也不该接上
  hours("f-roster", 100);
  // 已满足的结构边 调度引擎 → 借算力协议：调度引擎权重大也接不上借算力协议
  hours("f-sched", 40); hours("f-lend", 1);
  const cp = criticalPath(b, productLayout(b));
  expect(cp.ids).toEqual(["f-private", "f-team"]);
  expect(cp.edges.some(e => e.startsWith("lock:"))).toBe(false);
  // back 边：把锁边换成结构边 团队项目 → 私有云拆分（成环，标 back），路径不绕回去
  const looped: ProductBoard = { ...b, links: b.links!.map(l => l.from === "f-team" && l.to === "f-private" ? { ...l, kind: "task" as const } : l) };
  const layout = productLayout(looped);
  expect(layout.edges.find(e => e.id === "dep:f-team>f-private")!.back).toBe(true);
  expect(criticalPath(looped, layout).ids).toEqual(["f-private", "f-team"]);
  // gate 不算：把团队项目改成待验收，剩下的最长路径在链 2
  b.features.find(f => f.id === "f-team")!.state = "gate";
  expect(criticalPath(b, productLayout(b))).toMatchObject({ ids: ["f-dispatch", "f-merge"], hours: 10 });
});

test("criticalPath: 只剩 1 个节点有 cpHours、连不起来时为空", () => {
  const b = board();
  for (const f of b.features) if (f.eta?.basis && f.id !== "f-team") delete f.eta.basis.cpHours;
  b.features.find(f => f.id === "f-private")!.state = "gate";
  expect(criticalPath(b, productLayout(b)).ids).toEqual([]);
});

test("highlight: 过滤『受阻 · 久未动』只剩 3 张卡亮；选中 + 关键路径叠加", () => {
  const b = board(), layout = productLayout(b);
  expect(filterCount(layout.summary, "blocked")).toBe(3);
  const lit = (h: ReturnType<typeof highlight>) => layout.nodes.filter(n => !n.chip && !h.dim.has(n.id)).map(n => n.id).sort();
  const blocked = highlight(layout, { pick: null, filter: "blocked", summary: layout.summary, cp: null });
  expect(lit(blocked)).toEqual(["f-agents", "f-dispatch", "f-sched"]);
  const cp = criticalPath(b, layout);
  const both = highlight(layout, { pick: { kind: "feature", id: "f-team" }, filter: "all", summary: layout.summary, cp });
  expect(lit(both)).toEqual(["f-private", "f-team"]);
  expect(sorted(both.strong)).toEqual(["dep:f-private>f-team"]);
  expect(both.dimEdges.has("lock:f-team>f-roster")).toBe(true);
  // 选中的卡不豁免过滤：团队项目在跑，它的上下游里没有受阻 · 久未动的，全部变暗；描边照留
  const self = highlight(layout, { pick: { kind: "feature", id: "f-team" }, filter: "blocked", summary: layout.summary, cp: null });
  expect(lit(self)).toEqual([]);
  expect(self.selected.has("f-team") && self.picked === "f-team").toBe(true);
  // 选中边只描两端，不变暗；两端不算选中的模块

  const edge = highlight(layout, { pick: { kind: "edge", id: "dep:f-private>f-team" }, filter: "all", summary: layout.summary, cp: null });
  expect(sorted(edge.selected)).toEqual(["f-private", "f-team"]);
  expect(edge.picked).toBeNull();
  expect(edge.dim.size).toBe(0);
});

test("cpSpan: 取整，超过 48 小时按天", () => {
  expect(cpSpan(33.4)).toEqual({ word: "h", n: 33 });
  expect(cpSpan(48)).toEqual({ word: "h", n: 48 });
  expect(cpSpan(60)).toEqual({ word: "d", n: 3 });
});
