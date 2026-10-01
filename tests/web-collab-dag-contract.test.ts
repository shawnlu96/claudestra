/**
 * 契约：L4 的真实投影（src/lib/ledger-dag-board*.ts）在临时内存台账上跑出来，按路由（src/bridge/local-api/ledger-dag.ts）的样子拼成响应，
 * 赋给 web 手抄的类型（dag-types.ts，编译期钉形状），过一遍 JSON 再喂给前端模型（运行期钉口径）：两张图、手机分节、版本对比都要画得出来、对得上。
 * 末尾一段手造快照只补真实台账不好造的情形（超过 MAX_OPEN 个 feature）。不碰生产台账。
 */
import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dagBoard } from "../src/lib/ledger-dag-board.js";
import { featureDetail, featureDiff } from "../src/lib/ledger-dag-board-history.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { compareOf, compareOverlay, defaultCompare, diffLists } from "../web/features/collab/dag/dag-diff";
import { defaultOpen, drawable, layoutDag, MAX_OPEN, nodeId, topoOrder } from "../web/features/collab/dag/dag-layout";
import { jumpToNode, ownerOf, progressRows, rowOf } from "../web/features/collab/dag/dag-progress";
import { nodeSteps } from "../web/features/collab/dag/dag-steps";
import type { DagBoard, DagDiffResponse, FeatureDetail } from "../web/features/collab/dag/dag-types";
import { board as fakeBoard, feature, node } from "./web-collab-dag-fixture";

const P = "claude-orchestrator";
const PM = "agent-pm";
const NOW = 10_000;
const J = (x: unknown) => JSON.stringify(x);
/** 过一遍 JSON：前端拿到的就是这个（undefined 字段消失、数字照旧） */
const wire = <T>(x: T): T => JSON.parse(J(x)) as T;
let db: Database;
let F = "";

const run = (...args: string[]) => runLedger(args, {
  db, actor: PM, actorProject: P, projectIds: [P, "other"],
  loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => NOW,
  notifyOwner: async () => true,
}) as Promise<Record<string, any>>;

const owner = (t: number) => ({ actor: "owner", now: t });
const walk = (id: string, ...steps: [string, string, number][]) => steps.forEach(([from, to, t]) => moveStage(db, owner(t), { taskId: id, from: from as never, to: to as never }));
const rev = () => String(getFeature(db, F)!.rev);

const T1 = { key: "T1", taskId: "T1", oneLine: "任务 T1", deps: [] };
const T2 = { key: "T2", taskId: "T2", oneLine: "任务 T2", deps: ["T1"] };
const T3 = { key: "T3", taskId: "T3", oneLine: "任务 T3", deps: ["T2"] };
const T4 = { key: "T4", taskId: "T4", oneLine: "任务 T4", deps: ["T1"] };
const Z = { key: "Z", oneLine: "计划 Z", deps: [] };
const M = { key: "M", oneLine: "新计划", deps: ["T1"] };

/** 路由的响应 = { ok, project, now, ...投影 }（ledger-dag.ts）；赋给 web 类型这一步就是编译期契约 */
function boardResp(): DagBoard {
  return wire<DagBoard>({ ok: true, project: P, exists: true, now: NOW, ...db.transaction(() => dagBoard(db, P, NOW)).deferred() });
}
function detailResp(v: number | "pending" | undefined): FeatureDetail {
  return wire<FeatureDetail>({ ok: true, project: P, now: NOW, ...featureDetail(db, getFeature(db, F)!, v, NOW) });
}
function diffResp(from: number | undefined, to: number | "pending" | undefined): DagDiffResponse {
  return wire<DagDiffResponse>({ ok: true, project: P, featureId: F, now: NOW, ...featureDiff(db, getFeature(db, F)!, from, to, NOW) });
}

// v1：T1 已完成 → T2 进行中（agent-exec）→ T3 没开始；T4 进行中（卡上只记 assignee）；Z 计划节点
// v2：直接生效，加 M；之后 Z 被手绑到别的项目的卡（missing）；v3 待批：取消 T2（带原因）、T3 改依赖
beforeAll(async () => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, owner(400), { project: P, key: "pms", value: [PM, "agent-pm2"] });
  createTask(db, owner(500), { project: P, id: "T1", title: "任务 T1", kind: "code", agent: "agent-exec", stage: "done" });
  createTask(db, owner(500), { project: P, id: "T2", title: "任务 T2", kind: "code", agent: "agent-exec", pr: "#7", branch: "feat/t2" });
  createTask(db, owner(500), { project: P, id: "T3", title: "任务 T3", kind: "code" });
  createTask(db, owner(500), { project: P, id: "T4", title: "任务 T4", kind: "code", assignee: "agent-asg", assigneeKind: "agent" });
  createTask(db, owner(500), { project: "other", id: "X1", title: "别的项目的卡", kind: "code", agent: "agent-x", stage: "done" });
  walk("T2", ["spec", "restate", 700], ["restate", "build", 800]);
  walk("T4", ["spec", "restate", 850], ["restate", "build", 900]);
  expect((await run("feature-new", "i28", "--title", "协作底座改版")).ok).toBe(true);
  F = "ab12-i28";
  expect((await run("dag-init", "i28", "--rev", "1", "--nodes", J([T1, T2, T3, T4, Z]))).ok).toBe(true);
  expect(await run("dag-rewrite", "i28", "--rev", rev(), "--nodes", J([T1, T2, T3, T4, Z, M]), "--reason-kind", "new_issue", "--reason", "加 M"))
    .toMatchObject({ ok: true, applied: true });
  expect(await run("dag-rewrite", "i28", "--rev", rev(), "--nodes", J([T1, { ...T3, deps: ["T1"] }, T4, Z, M]), "--reason-kind", "requirement_change",
    "--reason", "方向变了", "--cancel", "T2=方向变了")).toMatchObject({ ok: true, applied: false });
  // 手改库：v2 的 Z 绑到别的项目的卡（放在重写之后，否则它算已完成节点、重写必须原样带入）
  db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, 2, 'Z', 'X1', 'hand', 1)").run(F);
  expect((await run("feature-new", "later", "--title", "以后再说")).ok).toBe(true);
});
afterAll(() => closeLedger(":memory:"));

describe("L4 真实投影 → 子 DAG 图", () => {
  test("没建图的 feature 不进图；展开的 feature 每个节点都有框或收在 ✓N 里，✓N = counts.done", () => {
    const b = boardResp();
    expect(b.features.map((f) => f.id).sort()).toEqual([F, "ab12-later"].sort());
    expect(drawable(b.features).map((f) => f.id)).toEqual([F]);
    const open = defaultOpen(b.features);
    const c = layoutDag(b.features, open, new Set());
    const g = c.groups.find((x) => x.id === F)!;
    expect(g.feature.nodes.map((n) => n.key).sort()).toEqual(["M", "T1", "T2", "T3", "T4", "Z"]);
    for (const n of g.feature.nodes) expect(c.boxOf.has(nodeId(F, n.key))).toBe(true);
    expect(g.folds.reduce((s, f) => s + f.n, 0)).toBe(g.feature.counts.done);
    expect(g.feature.counts).toMatchObject({ done: 1, missing: 1 });
  });
  test("missing 节点（绑了别的项目的卡）字段为空也照画，不崩", () => {
    const z = boardResp().features.find((f) => f.id === F)!.nodes.find((n) => n.key === "Z")!;
    expect(z).toMatchObject({ missing: true, status: null, statusAtVersion: null, title: null, handler: null, stepLine: null });
    expect(nodeSteps(z.stepLine).current).toBeNull();
  });
  test("进行中节点的进度条：当前格 = 写", () => {
    const t2 = boardResp().features.find((f) => f.id === F)!.nodes.find((n) => n.key === "T2")!;
    expect(t2.phase).toBe("active");
    expect(nodeSteps(t2.stepLine).current?.label).toBe("写");
  });
  test("手机分节：拓扑序，前置在前", () => {
    const keys = topoOrder(boardResp().features.find((f) => f.id === F)!.nodes).map((n) => n.key);
    expect(keys.indexOf("T1")).toBeLessThan(keys.indexOf("T2"));
    expect(keys.indexOf("T2")).toBeLessThan(keys.indexOf("T3"));
    expect(keys.indexOf("T1")).toBeLessThan(keys.indexOf("M"));
  });
});

describe("L4 真实投影 → 进度图（两张图对得上）", () => {
  test("PM 按名单在最前；节点的负责人 = 进度行；每条 work 都能跳回图上的节点", () => {
    const b = boardResp();
    const rows = progressRows(b.agents, [], P);
    expect(rows.slice(0, 2).map((r) => [r.agent, r.pm])).toEqual([["pm", true], ["pm2", true]]);
    const f = b.features.find((x) => x.id === F)!;
    const active = f.nodes.filter((n) => n.handler?.agent);
    expect(active.map((n) => n.key).sort()).toEqual(["T2", "T4"]);
    for (const n of active) {
      const o = ownerOf(rows, F, n)!;
      expect(o.agent).toBe(n.handler!.agent!.replace(/^agent-/, ""));
      expect(rowOf(rows, o.agent)!.work.some((w) => w.featureId === F && w.nodeKey === n.key)).toBe(true);
    }
    for (const r of rows) for (const w of r.work) expect(jumpToNode(b.features, [], w.featureId, w.nodeKey)?.id).toBe(nodeId(w.featureId, w.nodeKey));
  });
});

describe("L4 真实投影 → 版本与对比", () => {
  test("版本列表：v1 / v2 有 delta（v2 增 M、手绑的 Z 算改），pending 在卡片上", () => {
    const d = detailResp(undefined);
    expect(d.versions.map((v) => [v.version, v.delta])).toEqual([[1, null], [2, { added: 1, removed: 0, changed: 1, cancelled: 0 }]]);
    expect(d.feature).toMatchObject({ currentVersion: 2, pending: { version: 3, baseVersion: 2, cancels: [{ key: "T2", reason: "方向变了" }] } });
    expect(defaultCompare(F, d.feature.currentVersion)).toEqual({ featureId: F, from: 1, to: 2 });
  });
  test("默认对比 v1 → v2：增 M，叠图没有幽灵，M 标成新增", () => {
    const b = boardResp();
    const diff = diffResp(1, 2);
    const from = detailResp(1).snapshot!.nodes;
    const to = b.features.find((f) => f.id === F)!.nodes;
    const ov = compareOverlay(F, to, from, diff);
    expect(ov.ghosts).toEqual([]);
    expect(ov.marks.get("M")).toEqual({ added: true });
    const c = layoutDag(b.features, [F], new Set(), ov);
    expect(c.groups[0]!.nodes.find((n) => n.key === "M")!.mark).toEqual({ added: true });
  });
  test("v2 → pending：T2 取消（带原因、画成幽灵），T3、Z 带入有改；路由给的 to 是数字", () => {
    const sel = compareOf(F, 2, "pending")!;
    expect(sel).toEqual({ featureId: F, from: 2, to: "pending" });
    const diff = diffResp(sel.from, sel.to);
    expect([diff.from, diff.to]).toEqual([2, 3]);
    const from = detailResp(2).snapshot!.nodes;
    const pend = detailResp("pending").snapshot!;
    expect(pend.version).toBe("pending");
    const ov = compareOverlay(F, pend.nodes, from, diff);
    expect(ov.ghosts.map((n) => n.key)).toEqual(["T2"]);
    expect(ov.marks.get("T2")).toEqual({ cancelled: "方向变了", ghost: true });
    const l = diffLists(diff, from, pend.nodes);
    expect(l.cancelled).toEqual([{ key: "T2", oneLine: "任务 T2", reason: "方向变了" }]);
    // Z 在 v2 被手绑了卡、提案里是没绑的原样：绑定算内容（L4 effectiveNodes），所以也是带入有改
    expect(l.changed.map((x) => x.key).sort()).toEqual(["T3", "Z"]);
    expect(diff.rewrittenDone).toEqual([]);
    const c = layoutDag(boardResp().features, [F], new Set(), ov);
    expect(c.groups[0]!.nodes.find((n) => n.key === "T2")!.kind).toBe("ghost");
  });
});

describe("补充（手造快照）：超过 MAX_OPEN 个 feature", () => {
  const snapshot: DagBoard = fakeBoard(Array.from({ length: 10 }, (_, i) => feature(`f${i}`, [node("A", "active"), node("B", "done")], { lastActivityAt: 100 + i })));
  test("默认展开不超过 MAX_OPEN，留下的是最近有动静的", () => {
    const open = defaultOpen(snapshot.features);
    expect(open.length).toBe(MAX_OPEN);
    expect(open).not.toContain("f0");
    expect(layoutDag(snapshot.features, open, new Set()).groups.length).toBe(MAX_OPEN);
  });
});
