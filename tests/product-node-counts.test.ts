/**
 * team-project-N8B1：本机 nodeCounts 与 web twin productNodeCounts 是同一个纯函数——同一组节点行逐字段相等。
 * 覆盖远期节点、取消节点、绑了卡但卡缺失、没绑卡的 spec、等依赖、受阻卡；游离卡不在节点行里，不计。
 * team-project-PDSTATE1：等依赖的节点计 waiting，不再计 blocked；受阻只剩卡 stage=blocked 与绑了卡读不到两种。
 */
import { expect, test } from "bun:test";
import { nodeCounts } from "../src/lib/ledger-product-board.js";
import type { EtaNode } from "../src/lib/ledger-product-board-eta.js";
import type { LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { nodeClasses as srcClasses, productNodeCounts as srcCounts, type NodeClass } from "../src/lib/product-node-counts.js";
import { nodeClasses as webClasses, productNodeCounts as webCounts, deferredLine } from "../web/lib/product-node-counts.js";

const node = (key: string, stage: Stage | null | "missing", deps: string[] = [], oneLine = key): EtaNode => ({
  key, taskId: stage ? `t-${key}` : null, oneLine, deps, estimate: "", status: "planned", inheritedFrom: null,
  task: stage && stage !== "missing" ? ({ id: `t-${key}`, stage, project: "p", kind: "code", updatedAt: 1 } as LedgerTask) : null,
});
const rows = (nodes: EtaNode[]) => nodes.map((n) => ({ key: n.key, deferred: deferredLine(n.oneLine), taskId: n.taskId, stage: n.task?.stage ?? null, deps: n.deps }));

const NODES = [node("done", "verified"), node("cancel", "cancelled"), node("active", "review", ["done"]), node("blocked", "blocked"),
  node("lost", "missing"), node("spec", "spec", ["done", "cancel"]), node("idle", null, ["done"]), node("wait", null, ["active"]),
  node("future", "done", [], "（远期）future"), node("future2", null, ["wait"], "(远期) future2")];

test("src 与 web 两份函数在同一组节点行上逐字段相等，且等于本机 nodeCounts", () => {
  const local = nodeCounts(NODES);
  expect(local).toEqual({ total: 10, completed: 2, active: 1, ready: 2, blocked: 2, deferred: 2, waiting: 1 });
  expect(srcCounts(rows(NODES))).toEqual(local);
  expect(webCounts(rows(NODES))).toEqual(local);
});

test("取消节点计完成并满足下游依赖；绑了卡但卡缺失计受阻", () => {
  expect(webCounts(rows([node("c", "cancelled"), node("n", null, ["c"])]))).toMatchObject({ completed: 1, ready: 1, blocked: 0 });
  expect(webCounts(rows([node("lost", "missing")]))).toMatchObject({ blocked: 1, active: 0 });
});

test("远期判定两种括号都认，前导空白也认；不在开头不算", () => {
  for (const s of ["（远期）a", "(远期) a", "  （远期）a"]) expect(deferredLine(s)).toBe(true);
  for (const s of ["a（远期）", "远期 a", ""]) expect(deferredLine(s)).toBe(false);
});

const range = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`);
const sum = (c: ReturnType<typeof srcCounts>) => c.completed + c.active + c.ready + c.blocked + c.deferred + c.waiting;

test("夹具 B（3 完成、1 可开工、19 等依赖）：受阻 0、在等 19、可开工 1（main 上记成受阻 19）", () => {
  const nodes = [...range("d", 3).map((k) => node(k, "done")), node("next", null, ["d0"]), ...range("w", 19).map((k) => node(k, null, ["next"]))];
  const local = nodeCounts(nodes);
  expect(local).toEqual({ total: 23, completed: 3, active: 0, ready: 1, blocked: 0, deferred: 0, waiting: 19 });
  expect(srcCounts(rows(nodes))).toEqual(local);
  expect(webCounts(rows(nodes))).toEqual(local);
});

test("混合夹具：受阻只有 blocked 卡和读不到的卡；六项之和等于 total；类别按输入顺序", () => {
  const nodes = [node("blk", "blocked"), node("lost", "missing"), node("far", "blocked", [], "（远期）以后"), node("x", "cancelled"),
    node("go", "build", ["x"]), node("after-lost", null, ["lost"]), node("after-blk", "spec", ["blk"]), node("next", null, ["x"])];
  const local = nodeCounts(nodes);
  expect(local).toEqual({ total: 8, completed: 1, active: 1, ready: 1, blocked: 2, deferred: 1, waiting: 2 });
  expect(sum(local)).toBe(local.total);
  const classes: NodeClass[] = ["blocked", "blocked", "deferred", "completed", "active", "waiting", "waiting", "ready"];
  expect(srcClasses(rows(nodes))).toEqual(classes);
  expect(webClasses(rows(nodes))).toEqual(srcClasses(rows(nodes)));
  expect(srcCounts(rows(nodes))).toEqual(local);
  expect(webCounts(rows(nodes))).toEqual(local);
});
