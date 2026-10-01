/**
 * 子 DAG 看板投影（i28-L4，lib/ledger-dag-board*.ts）：节点三态 / 计时 / 谁在做 / 进度条、agent 行与节点双向对得上、
 * 别的项目的卡按 missing 清空、版本列表与对比（取消、换卡、pending）、绕过 planRewrite 改写已完成节点进 rewrittenDone。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerAsk } from "../src/lib/ledger-asks.js";
import { dagBoard, type BoardNode, type DagBoard } from "../src/lib/ledger-dag-board.js";
import { featureDetail, featureDiff } from "../src/lib/ledger-dag-board-history.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { projectView } from "../src/lib/ledger-read.js";
import { schedulerProjectView } from "../src/lib/ledger-scheduler.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const F = "ab12-i28";
const NOW = 10_000;
let db: Database;
let now = 1_000;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P, "other"],
    loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => now,
    notifyOwner: async () => true,
  }) as Promise<Record<string, any>>;
}

const J = (x: unknown) => JSON.stringify(x);
const rev = () => String(getFeature(db, F)!.rev);
const owner = (t: number) => ({ actor: "owner", now: t });
const walk = (id: string, ...steps: [string, string, number][]) => steps.forEach(([from, to, t]) => moveStage(db, owner(t), { taskId: id, from: from as never, to: to as never }));
const board = (): DagBoard => db.transaction(() => dagBoard(db, P, NOW)).deferred();
const node = (b: DagBoard, key: string, f = F): BoardNode => b.features.find((x) => x.id === f)!.nodes.find((n) => n.key === key)!;
/** 绕过 planRewrite 直接写一版并设为当前版（模拟手改库 / L2 之前的历史） */
function handVersion(version: number, createdAt: number, nodes: unknown) {
  db.prepare("INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, approvedBy, createdAt, nodes, cancels, scopeChange, askId) "
    + "VALUES (?, ?, 'new_issue', '手改', 'hand', 'hand', ?, ?, '[]', 0, NULL)").run(F, version, createdAt, J(nodes));
  db.prepare("UPDATE features SET currentVersion = ? WHERE id = ?").run(version, F);
}
const rewrite = (nodes: unknown, ...more: string[]) => run(PM, "dag-rewrite", "i28", "--rev", rev(), "--nodes", J(nodes), "--reason-kind", "new_issue", "--reason", "审查发现新问题", ...more);

/** v1：T1 已完成 → T2 进行中（agent-exec）→ T3 没开始；T4 进行中、卡上只记了 assignee；L / Z 计划节点，W 依赖 Z */
const T1 = { key: "T1", taskId: "T1", oneLine: "任务 T1", deps: [] };
const T2 = { key: "T2", taskId: "T2", oneLine: "任务 T2", deps: ["T1"] };
const T3 = { key: "T3", taskId: "T3", oneLine: "任务 T3", deps: ["T2"] };
const T4 = { key: "T4", taskId: "T4", oneLine: "任务 T4", deps: ["T1"] };
const L = { key: "L", oneLine: "以后再做", deps: ["T1"] };
const Z = { key: "Z", oneLine: "计划 Z", deps: [] };
const W = { key: "W", oneLine: "计划 W", deps: ["Z"] };
const V1 = [T1, T2, T3, T4, L, Z, W];

beforeEach(async () => {
  now = 1_000;
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, owner(400), { project: P, key: "pms", value: [PM, "agent-pm2"] });
  createTask(db, owner(500), { project: P, id: "T1", title: "任务 T1", kind: "code", agent: "agent-exec", stage: "done" });
  createTask(db, owner(500), { project: P, id: "T2", title: "任务 T2", kind: "code", agent: "agent-exec", pr: "#7", branch: "feat/t2" });
  createTask(db, owner(500), { project: P, id: "T3", title: "任务 T3", kind: "code" });
  createTask(db, owner(500), { project: P, id: "T4", title: "任务 T4", kind: "code", assignee: "agent-asg", assigneeKind: "agent" });
  createTask(db, owner(500), { project: P, id: "T5", title: "任务 T5", kind: "code" });
  createTask(db, owner(500), { project: P, id: "T6", title: "任务 T6", kind: "code", agent: "agent-off" });
  createTask(db, owner(500), { project: "other", id: "X1", title: "别的项目的卡", kind: "code", agent: "agent-x", pr: "#99", branch: "secret", stage: "done" });
  walk("T2", ["spec", "restate", 700], ["restate", "build", 800]);
  walk("T4", ["spec", "restate", 850], ["restate", "build", 900]);
  walk("T6", ["spec", "restate", 550], ["restate", "build", 600]);
  expect((await run(PM, "feature-new", "i28", "--title", "协作底座改版")).ok).toBe(true);
  expect((await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", J(V1))).ok).toBe(true);
});
afterEach(() => closeLedger(":memory:"));

describe("当前版投影", () => {
  test("三态、计时、谁在做、进度条；快照字段原样，done 节点照样在", () => {
    const b = board();
    const f = b.features[0];
    expect(f).toMatchObject({ id: F, status: "active", currentVersion: 1, version: { version: 1, reasonKind: "initial" }, pending: null,
      counts: { total: 7, done: 1, active: 2, idle: 4, missing: 0 } });
    const snap = getDagVersion(db, F, 1)!.nodes;
    expect(f.nodes.map((n) => [n.key, n.taskId, n.oneLine, n.deps, n.estimate, n.fileGlobs])).toEqual(snap.map((n) => [n.key, n.taskId, n.oneLine, n.deps, n.estimate, n.fileGlobs]));
    expect(node(b, "T1")).toMatchObject({ phase: "done", since: null, handler: null, status: "done", missing: false });
    expect(node(b, "T2")).toMatchObject({ phase: "active", since: 800, round: 0, pr: "#7", branch: "feat/t2", ready: true,
      handler: { role: "executor", agent: "agent-exec", since: 800 }, stepLine: { active: { step: "write", round: 0 } } });
    expect(node(b, "T3")).toMatchObject({ phase: "idle", since: null, handler: null, status: "spec" });
    expect(node(b, "L")).toMatchObject({ phase: "idle", since: null, handler: null, status: "planned", stepLine: null, round: null });
    // 卡上没记 agent：用 stepAtStage 认出的执行人补
    expect(node(b, "T4").handler).toEqual({ role: "executor", agent: "agent-asg", since: 900 });
  });

  test("since 与 GET /ledger/:project 的 stageSince 一致；handler 与同一时刻的 schedulerProjectView 一致；asOfSeq = MAX(seq)", () => {
    const b = board();
    const pv = projectView(db, P, NOW);
    const sv = schedulerProjectView(db, P);
    for (const n of b.features[0].nodes.filter((x) => x.phase === "active")) {
      expect(n.since).toBe(pv.tasks.find((t) => t.id === n.taskId)!.stageSince);
      const h = sv.tasks.find((t) => t.taskId === n.taskId)!.handler!;
      expect([n.handler!.role, n.handler!.since]).toEqual([h.role, h.since]);
      if (h.agent) expect(n.handler!.agent).toBe(h.agent);
    }
    expect(b.asOfSeq).toBe((db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s);
  });

  test("agent 行：PM 在前（含空行），其余按最早 since；节点 ↔ 行双向对得上；不在图里的在做卡进 offGraph", () => {
    const b = board();
    expect(b.agents.map((r) => [r.agent, r.pm])).toEqual([["pm", true], ["pm2", true], ["off", false], ["exec", false], ["asg", false]]);
    expect(b.agents[1]).toMatchObject({ work: [], offGraph: [] });
    expect(b.agents.find((r) => r.agent === "off")!.offGraph).toEqual([{ taskId: "T6", stage: "build", role: "executor", since: 600 }]);
    expect(b.agents.find((r) => r.agent === "exec")!.work).toEqual([{ featureId: F, nodeKey: "T2", taskId: "T2", role: "executor", step: "write", round: 0, since: 800 }]);
    const nodes = b.features.flatMap((f) => f.nodes.map((n) => ({ f: f.id, n })));
    for (const { f, n } of nodes.filter((x) => x.n.handler?.agent)) {
      expect(b.agents.find((r) => r.agent === n.handler!.agent!.replace(/^agent-/, ""))!.work.some((w) => w.featureId === f && w.nodeKey === n.key)).toBe(true);
    }
    for (const r of b.agents) for (const w of r.work) {
      expect(nodes.find((x) => x.f === w.featureId && x.n.key === w.nodeKey)!.n.handler!.agent!.replace(/^agent-/, "")).toBe(r.agent);
    }
  });

  test("审查员 handler 的 agent 为空：用 stepAtStage 认出的审查那一步补，审查员也占一行", () => {
    db.prepare("UPDATE tasks SET extra = ? WHERE id = 'T3'").run(J({ reviewer: "agent-rv" }));
    walk("T3", ["spec", "restate", 1100], ["restate", "build", 1200]);
    deliver(db, owner(1300), { taskId: "T3", headSHA: "abc", moveFrom: "build" });
    appendEvent(db, owner(1400), { project: P, target: "T3", kind: "dispatch" });
    expect(schedulerProjectView(db, P).tasks.find((t) => t.taskId === "T3")!.handler).toMatchObject({ role: "reviewer", agent: null });
    const b = board();
    expect(node(b, "T3")).toMatchObject({ phase: "active", since: 1300, handler: { role: "reviewer", agent: "agent-rv", since: 1400 }, stepLine: { active: { step: "review" } } });
    expect(b.agents.find((r) => r.agent === "rv")!.work).toEqual([{ featureId: F, nodeKey: "T3", taskId: "T3", role: "reviewer", step: "review", round: 0, since: 1400 }]);
  });

  test("绑到别的项目的卡 / 找不到的卡 → missing，字段全空，依赖它的节点不 ready；别的项目的任何字段都不带出来", () => {
    const bind = db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES (?, 1, ?, ?, 'hand', 1)");
    bind.run(F, "Z", "X1");
    bind.run(F, "L", "GHOST");
    const b = board();
    for (const key of ["Z", "L"]) {
      expect(node(b, key)).toMatchObject({ missing: true, status: null, title: null, handler: null, stepLine: null, pr: null, branch: null, round: null, since: null, satisfied: false, ready: false });
    }
    expect(node(b, "W").ready).toBe(false);
    expect(b.features[0].counts).toMatchObject({ missing: 2, total: 7 });
    const text = J(b);
    for (const leak of ["别的项目的卡", "agent-x", "#99", "secret", "\"x\""]) expect(text).not.toContain(leak);
    const d = db.transaction(() => featureDetail(db, getFeature(db, F)!, 1, NOW)).deferred();
    expect(J(d)).not.toContain("别的项目的卡");
  });

  test("没建图的 feature：version null、nodes []；status 分组排序", async () => {
    expect((await run(PM, "feature-new", "later", "--title", "以后再说")).ok).toBe(true);
    const b = board();
    expect(b.features.map((f) => f.id)).toEqual([F, "ab12-later"]);
    expect(b.features[1]).toMatchObject({ currentVersion: 0, version: null, nodes: [], lastActivityAt: null });
    const d = featureDetail(db, getFeature(db, "ab12-later")!, undefined, NOW);
    expect(d.snapshot).toBeNull();
    expect(() => featureDetail(db, getFeature(db, "ab12-later")!, 1, NOW)).toThrow();
  });
});

describe("版本与对比", () => {
  const M = { key: "M", oneLine: "新计划", deps: [] };
  const Lb = { ...L, taskId: "T5" };

  test("dag-bind → 直接生效 → 带 cancel 的 pending → approve：pending 不并进 nodes，取消原因、四类差异、delta", async () => {
    expect((await run(PM, "dag-bind", "i28", "L", "T5", "--rev", rev())).ok).toBe(true);
    expect(node(board(), "L")).toMatchObject({ taskId: "T5", phase: "idle", status: "spec" });
    expect(await rewrite([T1, T2, T3, T4, Lb, Z, W, M])).toMatchObject({ ok: true, applied: true });
    const r = await rewrite([T1, { ...T3, deps: ["T1"] }, T4, Lb, Z, W, M], "--cancel", "T2=方向变了");
    expect(r).toMatchObject({ ok: true, applied: false, proposal: { version: 3 } });
    const b = board();
    expect(b.features[0]).toMatchObject({ currentVersion: 2, pending: { version: 3, baseVersion: 2, askId: r.askId, cancels: [{ key: "T2", reason: "方向变了" }] } });
    expect(node(b, "T2")).toBeTruthy();
    const f = getFeature(db, F)!;
    const pend = featureDetail(db, f, "pending", NOW);
    expect(pend.snapshot).toMatchObject({ version: "pending", meta: { version: 3, cancels: [{ key: "T2", taskId: "T2", reason: "方向变了" }] } });
    expect(pend.snapshot!.nodes.map((n) => n.key)).not.toContain("T2");
    const dp = featureDiff(db, f, undefined, "pending", NOW);
    expect(dp).toMatchObject({ from: 2, to: 3, rewrittenDone: [] });
    expect(dp.diff).toMatchObject({ added: [], removed: [], cancelled: [{ key: "T2", taskId: "T2", reason: "方向变了" }] });
    expect(dp.diff.carried.find((c) => c.key === "T3")!.changed).toBe(true);
    expect(dp.phaseNow).toMatchObject({ T1: "done", T2: "active", T3: "idle", M: "idle" });

    answerAsk(db, r.askId, { choices: ["[button:dag_rewrite_approve]"], labels: ["批准"], text: "", principal: "owner", via: "web_card", at: now, owner: true });
    expect((await run(PM, "dag-approve", "i28")).ok).toBe(true);
    const f3 = getFeature(db, F)!;
    const d = featureDiff(db, f3, 1, undefined, NOW);
    expect(d).toMatchObject({ from: 1, to: 3, diff: { added: ["M"], removed: [], cancelled: [{ key: "T2", reason: "方向变了" }] }, rewrittenDone: [] });
    const det = featureDetail(db, f3, undefined, NOW);
    expect(det.versions.map((v) => [v.version, v.delta])).toEqual([
      [1, null], [2, { added: 1, removed: 0, changed: 0, cancelled: 0 }], [3, { added: 0, removed: 0, changed: 1, cancelled: 1 }],
    ]);
    expect(det.snapshot).toMatchObject({ version: 3 });
    // 历史版也按卡现读：v1 里的 T2 现在还在 build
    expect(featureDetail(db, f3, 1, NOW).snapshot!.nodes.find((n) => n.key === "T2")).toMatchObject({ status: "build", phase: "active" });
  });

  test("key 还在、换了卡的进行中节点：同时在 carried.changed 和 cancelled；只移走没开始的节点算 removed", async () => {
    const r = await rewrite([T1, T2, { ...T4, taskId: "T6", oneLine: "任务 T6" }, L, Z, W], "--cancel", "T4=换人");
    expect(r).toMatchObject({ ok: true, applied: false });
    const d = featureDiff(db, getFeature(db, F)!, undefined, "pending", NOW).diff;
    expect(d.carried.find((c) => c.key === "T4")).toEqual({ key: "T4", changed: true });
    expect(d.cancelled).toEqual([{ key: "T4", taskId: "T4", reason: "换人" }]);
    expect(d.removed).toEqual(["T3"]);
  });

  test("绕过 planRewrite 改写已完成节点：投影用快照的 oneLine 不拿卡标题顶，diff 进 rewrittenDone", () => {
    const v1 = getDagVersion(db, F, 1)!;
    handVersion(2, 5000, v1.nodes.map((n) => (n.key === "T1" ? { ...n, oneLine: "被手改的一句话" } : n)));
    const b = board();
    expect(node(b, "T1")).toMatchObject({ oneLine: "被手改的一句话", title: "任务 T1", phase: "done" });
    const d = featureDiff(db, getFeature(db, F)!, undefined, undefined, NOW);
    expect(d).toMatchObject({ from: 1, to: 2, rewrittenDone: ["T1"] });
    expect(d.diff.carried.filter((c) => c.changed).map((c) => c.key)).toEqual(["T1"]);
  });

  test("跨多版：完成前合法改过、之后原样带入的不算；完成后又被改的才算——逐次重写按那一刻核对", () => {
    const v1 = getDagVersion(db, F, 1)!.nodes;
    const t2 = (oneLine: string, status: string) => v1.map((n) => (n.key === "T2" ? { ...n, oneLine, status } : n));
    handVersion(2, 850, t2("T2 改过一次", "build"));
    db.prepare("UPDATE tasks SET stage = 'done' WHERE id = 'T2'").run();
    db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (950, 'owner', ?, 'T2', 'stage', '', ?)").run(P, J({ from: "build", to: "done" }));
    handVersion(3, 1200, [...t2("T2 改过一次", "done"), { key: "P", taskId: null, oneLine: "新计划", deps: [], estimate: "", inheritedFrom: null, status: "planned" }]);
    const f = () => getFeature(db, F)!;
    expect(featureDiff(db, f(), 1, 2, NOW).rewrittenDone).toEqual([]);
    expect(featureDiff(db, f(), 1, 3, NOW).rewrittenDone).toEqual([]);
    expect(featureDiff(db, f(), 1, 3, NOW).diff.carried.find((c) => c.key === "T2")!.changed).toBe(true);
    handVersion(4, 1300, t2("T2 完成后又被改", "done"));
    expect(featureDiff(db, f(), 1, 4, NOW).rewrittenDone).toEqual(["T2"]);
    expect(featureDiff(db, f(), 2, 4, NOW).rewrittenDone).toEqual(["T2"]);
  });

  test("快照里已经写着别的项目的卡（库被手改）：statusAtVersion 也清空，rewrittenDone 不拿它的快照状态说话", () => {
    const v1 = getDagVersion(db, F, 1)!.nodes;
    const withX = (oneLine: string) => v1.map((n) => (n.key === "Z" ? { ...n, taskId: "X1", oneLine, status: "done" } : n));
    handVersion(2, 5000, withX("绑了别的项目"));
    handVersion(3, 6000, withX("又改了一次"));
    expect(node(board(), "Z")).toMatchObject({ missing: true, status: null, statusAtVersion: null, title: null });
    const d = db.transaction(() => featureDetail(db, getFeature(db, F)!, 2, NOW)).deferred();
    expect(d.snapshot!.nodes.find((n) => n.key === "Z")).toMatchObject({ missing: true, statusAtVersion: null });
    const diff = featureDiff(db, getFeature(db, F)!, 2, 3, NOW);
    expect(diff.diff.carried.find((c) => c.key === "Z")!.changed).toBe(true);
    expect(diff.rewrittenDone).toEqual([]);
  });

  test("越界与非法：from ≥ to → invalid；不存在的版本 / 没有 pending → not_found", () => {
    const f = getFeature(db, F)!;
    expect(() => featureDiff(db, f, 1, 1, NOW)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => featureDiff(db, f, 0, 1, NOW)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => featureDiff(db, f, undefined, 9, NOW)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => featureDiff(db, f, undefined, "pending", NOW)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => featureDetail(db, f, 9, NOW)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => featureDetail(db, f, "pending", NOW)).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
