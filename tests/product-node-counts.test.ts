/**
 * team-project-N8B1：本机 nodeCounts 与 web twin productNodeCounts 是同一个纯函数——同一组节点行逐字段相等。
 * 覆盖远期节点、取消节点、绑了卡但卡缺失、没绑卡的 spec、等依赖、受阻卡；游离卡不在节点行里，不计。
 */
import { expect, test } from "bun:test";
import { nodeCounts } from "../src/lib/ledger-product-board.js";
import type { EtaNode } from "../src/lib/ledger-product-board-eta.js";
import type { LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { productNodeCounts as srcCounts } from "../src/lib/product-node-counts.js";
import { productNodeCounts as webCounts, deferredLine } from "../web/lib/product-node-counts.js";

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
  expect(local).toEqual({ total: 10, completed: 2, active: 1, ready: 2, blocked: 3, deferred: 2 });
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
