/** PDLAYOUT1 [验收线 1]：项目地图的图与摆放（纯函数），数据用 tests/helpers/project-map-fixture.ts */
import { expect, test } from "bun:test";
import type { ProductBoard, ProductFeature } from "../web/lib/api/product-board-types";
import { CHIP_H, CHIP_W } from "../web/features/collab/product/product-card-model";
import { featureState, productGraph } from "../web/features/collab/product/product-graph";
import { productLayout, type ProductCanvas } from "../web/features/collab/product/product-layout";
import { PROJECT_MAP_NOW, projectMapBoard } from "./helpers/project-map-fixture";

const board = projectMapBoard(PROJECT_MAP_NOW);
const title = (c: ProductCanvas, id: string) => c.nodes.find((n) => n.id === id)?.feature.title;
const cards = (c: ProductCanvas) => c.nodes.filter((n) => !n.chip);

function noOverlap(c: ProductCanvas) {
  const boxes = [...c.nodes, ...c.chips];
  for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
    const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    if (hit) throw new Error(`${a.id} overlaps ${b.id}`);
  }
}

test("by dependency: 3 chains on the left, 8 standalone on the right in rows of 3; wrapped-up and paused stay out", () => {
  const g = productGraph(board);
  expect(g.chains).toHaveLength(3);
  expect(g.solo.map((n) => n.id)).toHaveLength(8);
  const c = productLayout(board);
  expect(cards(c)).toHaveLength(16);
  const chainIds = new Set(g.chains.flat(2).map((n) => n.id));
  const chainRight = Math.max(...c.nodes.filter((n) => chainIds.has(n.id)).map((n) => n.x + n.w));
  const solo = c.nodes.filter((n) => !chainIds.has(n.id));
  expect(solo).toHaveLength(8);
  expect(Math.min(...solo.map((n) => n.x))).toBeGreaterThan(chainRight);
  expect(new Set(solo.map((n) => n.x)).size).toBe(3);
  for (const id of ["f-codex", "f-msg", "f-base", "f-unclosed", "f-gone"]) expect(c.nodes.some((n) => n.id === id)).toBe(false);
  expect(c.done.map((f) => f.id)).toContain("f-unclosed");
  expect(c.paused.map((f) => f.id).sort()).toEqual(["f-codex", "f-msg"]);
  expect(c.zones.filter((z) => z.kind === "chains" || z.kind === "solo").map((z) => z.words.map((w) => [w.w, w.n]))).toEqual([
    [["依赖链 · {n} 串", 3]], [["独立推进 · {n} 个", 8], ["{n} 在跑", 2]]]);
});

test("split draws no line and names its source; the cyclic lock edge is back and leaves ranks alone; chain 1 starts with a chip", () => {
  const c = productLayout(board);
  expect(c.edges.some((e) => e.from === "f-base" || e.from === "f-dag")).toBe(false);
  expect(c.nodes.find((n) => n.id === "f-lend")?.splitFrom).toBe("协作底座改版");
  expect(c.nodes.find((n) => n.id === "f-quota")?.splitFrom).toBe("台账与子 DAG");
  const back = c.edges.filter((e) => e.back);
  expect(back.map((e) => [e.from, e.to, e.kinds])).toEqual([["f-team", "f-private", ["lock"]]]);
  const rank = (id: string) => c.nodes.find((n) => n.id === id)!.rank;
  expect(["f-ledger", "f-private", "f-team", "f-roster"].map(rank)).toEqual([0, 1, 2, 3]);
  const noLock = productLayout({ ...board, links: board.links!.filter((l) => l.kind !== "lock") });
  expect(["f-ledger", "f-private", "f-team"].map((id) => noLock.nodes.find((n) => n.id === id)!.rank)).toEqual([0, 1, 2]);
  const chip = c.nodes.find((n) => n.id === "f-ledger")!;
  expect([chip.chip, chip.w, chip.h]).toEqual([true, CHIP_W, CHIP_H]);
  const g = productGraph(board);
  const chain1 = g.chains.find((cols) => cols.flat().some((n) => n.id === "f-team"))!;
  expect(chain1.flat()).toHaveLength(4);
  expect(chain1[0].map((n) => n.id)).toEqual(["f-ledger"]);
  const merged = c.edges.find((e) => e.from === "f-private" && e.to === "f-team")!;
  expect([merged.kinds, merged.count, merged.satisfied, merged.solid]).toEqual([["task"], 3, false, false]);
  expect(c.edges.find((e) => e.from === "f-ledger")!.solid).toBe(true);
});

test("declared and task edges between the same pair merge into one structural edge", () => {
  const b: ProductBoard = { ...board, deps: [...board.deps, { from: "f-private", to: "f-team", note: "手写", kind: "declared", satisfied: true }] };
  const e = productLayout(b).edges.filter((x) => x.from === "f-private" && x.to === "f-team");
  expect(e.map((x) => [x.kinds, x.count, x.satisfied, x.deps.length, x.links.length])).toEqual([[["declared", "task"], 3, false, 1, 1]]);
});

test("main cards never overlap, also with per-card heights", () => {
  noOverlap(productLayout(board));
  noOverlap(productLayout(board, { doneOpen: true, pausedOpen: true }));
  const tall = (f: ProductFeature) => 100 + (f.id.length * 37) % 120;
  noOverlap(productLayout(board, { cardHeight: tall }));
  noOverlap(productLayout(board, { cardHeight: tall, mode: "lane", doneOpen: true, laneDone: ["team", "ui", ""] }));
});

test("the top chain is the highest-priority one (blocked chain 2); first standalone is the running 会话列表恢复", () => {
  const c = productLayout(board);
  const g = productGraph(board);
  expect(g.chains[0].flat().map((n) => n.id).sort()).toEqual(["f-dispatch", "f-merge"]);
  const top = Math.min(...c.nodes.map((n) => n.y));
  expect(c.nodes.filter((n) => n.y === top).map((n) => n.id)).toContain("f-dispatch");
  expect(g.solo[0].feature.title).toBe("会话列表恢复");
  const solo = c.nodes.filter((n) => g.solo.some((s) => s.id === n.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  expect(title(c, solo[0].id)).toBe("会话列表恢复");
});

test("deterministic, and cycles / missing endpoints / empty boards never throw or recurse", () => {
  expect(JSON.stringify(productLayout(board))).toBe(JSON.stringify(productLayout(projectMapBoard(PROJECT_MAP_NOW))));
  const f = (id: string): ProductFeature => ({ id, title: id, status: "active", hasDag: true, version: 1, counts: { total: 2, completed: 0, active: 1, blocked: 0 }, eta: null });
  const cyc = productLayout({ features: ["a", "b", "c"].map(f), deps: [{ from: "a", to: "b", note: "" }, { from: "b", to: "c", note: "" },
    { from: "c", to: "a", note: "" }, { from: "missing", to: "a", note: "" }, { from: "a", to: "a", note: "" }] });
  expect(cyc.nodes).toHaveLength(3);
  expect(cyc.edges.filter((e) => e.back)).toHaveLength(1);
  noOverlap(cyc);
  const empty = productLayout({ features: [], deps: [] });
  expect([empty.w, empty.h, empty.nodes.length]).toEqual([0, 0, 0]);
});

test("by area: 6 lanes + 1 ungrouped; without areas the mode is unavailable", () => {
  const c = productLayout(board, { mode: "lane" });
  expect(c.mode).toBe("lane");
  const lanes = c.zones.filter((z) => z.kind === "lane");
  expect(lanes).toHaveLength(7);
  expect(lanes.at(-1)!.words[0].w).toBe("未分组");
  expect(lanes.map((z) => z.lane!.key).slice(0, 6).sort()).toEqual(["agent", "base", "lend", "sched", "team", "ui"]);
  const runtime = c.nodes.find((n) => n.id === "f-runtime")!;
  expect(runtime.y).toBeGreaterThan(lanes.at(-1)!.y);
  const team = lanes.find((z) => z.lane!.key === "team")!;
  expect(team.lane!.done).toBe(1);
  const open = productLayout(board, { mode: "lane", laneDone: ["team"] });
  expect(open.chips.map((x) => x.feature.id)).toEqual(["f-ledger"]);
  for (const e of c.edges.filter((x) => !x.back)) expect(e.x2).toBeGreaterThan(e.x1);
  const { areas: _drop, ...noAreas } = board;
  const fallback = productLayout(noAreas, { mode: "lane" });
  expect([fallback.lanesOk, fallback.mode]).toEqual([false, "dep"]);
});

test("wrapped-up and paused shelves: paused above done, rows by area, frozen tagged", () => {
  const c = productLayout(board, { doneOpen: true, pausedOpen: true });
  const paused = c.chips.filter((x) => x.id.startsWith("paused:")), done = c.chips.filter((x) => x.id.startsWith("done:"));
  expect(done).toHaveLength(8);
  expect(paused.map((x) => [x.feature.id, x.tag]).sort()).toEqual([["f-codex", "paused"], ["f-msg", "frozen"]]);
  expect(new Set(paused.map((x) => x.y)).size).toBe(2); // 两个板块各一行
  expect(Math.max(...paused.map((x) => x.y))).toBeLessThan(Math.min(...done.map((x) => x.y)));
  expect(Math.min(...paused.map((x) => x.y))).toBeGreaterThan(Math.max(...c.nodes.map((n) => n.y + n.h)));
  const { areas: _drop, ...noAreas } = board;
  const flat = productLayout(noAreas, { doneOpen: true });
  expect(new Set(flat.chips.map((x) => x.y)).size).toBe(1);
});

test("team shape (no state / links / areas, deps empty): all standalone, states by the count fallback", () => {
  const pf = (id: string, counts: ProductFeature["counts"], status: ProductFeature["status"] = "active"): ProductFeature =>
    ({ id, title: id, status, hasDag: true, version: 1, counts, eta: null });
  const team: ProductBoard = { deps: [], features: [pf("blk", { total: 4, completed: 1, active: 1, blocked: 1 }), pf("run", { total: 4, completed: 1, active: 2, blocked: 0 }),
    pf("unk", { total: 4, completed: 1, active: 0, blocked: 0, activeUnknown: true }), pf("all", { total: 3, completed: 3, active: 0, blocked: 0 }),
    pf("closed", { total: 3, completed: 1, active: 0, blocked: 0 }, "done"), pf("ps", { total: 3, completed: 1, active: 0, blocked: 0 }, "paused")] };
  expect(team.features.map(featureState)).toEqual(["blocked", "run", "wait", "done", "done", "paused"]);
  const c = productLayout(team);
  expect(c.zones.map((z) => z.kind)).toEqual(["solo"]);
  expect(cards(c).map((n) => n.id)).toEqual(["blk", "run", "unk"]);
  expect(featureState({ ...pf("x", { total: 1, completed: 0, active: 0, blocked: 0 }, "paused"), state: "stale" })).toBe("paused");
});
