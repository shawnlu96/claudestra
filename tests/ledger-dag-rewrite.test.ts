/** 子 DAG 重写 + 审批 + 绑卡（T89）：四条规矩、直接生效 / owner 审批两条路（含驳回、快照被换、卡状态变了）、dag-bind 的约束、diff */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerAsk, getAsk } from "../src/lib/ledger-asks.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const F = "ab12-i28";
let db: Database;
let now = 1_000;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P, "other"],
    loadRegistry: async () => ({ socket: "", agents: { [PM]: { channelId: "c-pm" } } }) as never, saveRegistry: async () => {}, now: () => now,
  }) as Promise<Record<string, any>>;
}

const stage = (id: string, s: string) => db.prepare("UPDATE tasks SET stage = ? WHERE id = ?").run(s, id);
const rev = () => String(getFeature(db, F)!.rev);
const J = (x: unknown) => JSON.stringify(x);
const rewrite = (nodes: unknown, ...more: string[]) => run(PM, "dag-rewrite", "i28", "--rev", rev(), "--nodes", J(nodes), "--reason-kind", "new_issue", "--reason", "审查发现新问题", ...more);
const answer = (askId: string, button: string, owner = true) => answerAsk(db, askId, {
  choices: [`[button:${button}]`], labels: [button.endsWith("approve") ? "批准" : "驳回"], text: "", principal: owner ? "owner" : "guest:x", via: "web_card", at: now,
  ...(owner ? { owner: true as const } : { external: true }),
});
const versions = () => (db.prepare("SELECT version FROM dag_versions WHERE featureId = ? ORDER BY version").all(F) as { version: number }[]).map((r) => r.version);

/** v1：T1 已完成（done）→ T2 进行中（build）→ T3 没开始（spec）；L 是计划节点（没卡） */
const V1 = [{ taskId: "T1" }, { taskId: "T2", deps: ["T1"] }, { taskId: "T3", deps: ["T2"] }, { key: "L", oneLine: "以后再做", deps: ["T1"] }];
const T1 = { key: "T1", taskId: "T1", oneLine: "任务 T1", deps: [] };
const T2 = { key: "T2", taskId: "T2", oneLine: "任务 T2", deps: ["T1"] };
const T3 = { key: "T3", taskId: "T3", oneLine: "任务 T3", deps: ["T2"] };
const L = { key: "L", oneLine: "以后再做", deps: ["T1"] };

beforeEach(async () => {
  now = 1_000;
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  const owner = { actor: "owner", now: 500 };
  setMeta(db, owner, { project: P, key: "pms", value: [PM] });
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) createTask(db, owner, { project: P, id, title: `任务 ${id}`, kind: "code" });
  createTask(db, owner, { project: "other", id: "X1", title: "别的项目", kind: "code" });
  stage("T1", "done");
  stage("T2", "build");
  expect((await run(PM, "feature-new", "i28", "--title", "协作底座改版")).ok).toBe(true);
  expect((await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", J(V1))).ok).toBe(true);
});
afterEach(() => closeLedger(":memory:"));

describe("四条规矩", () => {
  test("已完成的节点删掉或改掉都被拒；原样带入标 inheritedFrom", async () => {
    expect(await rewrite([T2, T3, L].map((n) => ({ ...n, deps: n.deps.filter((d) => d !== "T1") })))).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("T1") });
    expect(await rewrite([{ ...T1, oneLine: "改名" }, T2, T3, L])).toMatchObject({ ok: false, code: "invalid" });
    expect(await rewrite([{ ...T1, estimate: "1 天" }, T2, T3, L])).toMatchObject({ ok: false, code: "invalid" });
    const r = await rewrite([T1, T2, T3, { ...L, oneLine: "换个做法" }]);
    expect(r).toMatchObject({ ok: true, applied: true });
    expect(r.version.nodes.find((n: any) => n.key === "T1").inheritedFrom).toBe(1);
    expect(r.version.nodes.find((n: any) => n.key === "L").inheritedFrom).toBeNull();
  });

  test("进行中的节点没写取消原因就消失 / 换卡：拒；--cancel 只能点名被移出的进行中节点", async () => {
    expect(await rewrite([T1, { ...T3, deps: ["T1"] }, L])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--cancel T2") });
    expect(await rewrite([T1, { ...T2, taskId: "T4", oneLine: "任务 T4" }, T3, L])).toMatchObject({ ok: false, code: "invalid" });
    expect(await rewrite([T1, T2, T3], "--cancel", "L=不做了")).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--cancel L") });
    expect(await rewrite([T1, { ...T3, deps: ["T1"] }, L], "--cancel", "T2=")).toMatchObject({ ok: false, code: "invalid" });
    expect(versions()).toEqual([1]);
  });

  test("只加节点、只换没开始的节点：直接生效，写事件，给 inform；移出的卡清 featureId，新卡挂上", async () => {
    const r = await rewrite([T1, T2, { key: "T4", taskId: "T4", deps: ["T2"] }, L, { key: "M", oneLine: "新计划" }]);
    expect(r).toMatchObject({ ok: true, applied: true, version: { version: 2, reasonKind: "new_issue", approvedBy: "auto", askId: null }, proposal: null });
    expect(r.inform).toContain("v2");
    expect(r.inform).toContain("新增 T4, M");
    expect(getFeature(db, F)).toMatchObject({ currentVersion: 2 });
    expect([getTask(db, "T3")!.featureId, getTask(db, "T4")!.featureId, getTask(db, "T2")!.featureId]).toEqual([null, F, F]);
    const ev = listEvents(db).filter((e) => e.target === F).at(-1)!;
    expect(ev.data).toMatchObject({ op: "dag-rewrite", version: 2, auto: true });
    expect(listEvents(db).some((e) => e.target === "T3" && (e.data.patch as any)?.featureId === null)).toBe(true);
  });

  test("CAS：旧 rev 被拒、库不动；一模一样的重写被拒；版本行照旧不可改", async () => {
    const before = listEvents(db).length;
    expect(await run(PM, "dag-rewrite", "i28", "--rev", "1", "--nodes", J([T1, T2, L]), "--reason-kind", "new_issue", "--reason", "x")).toMatchObject({ ok: false, code: "conflict" });
    expect(await rewrite([T1, T2, T3, L])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("一模一样") });
    expect(await rewrite([T1, T2, L], "--reason-kind", "initial")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("agent-exec", "dag-rewrite", "i28", "--rev", rev(), "--nodes", J([T1, T2, L]), "--reason-kind", "new_issue", "--reason", "x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(listEvents(db).length).toBe(before);
    expect(versions()).toEqual([1]);
  });
  test("--dedup 重放：重写、审批、绑卡都返回原事件，不重复写", async () => {
    const r = await rewrite([T1, T2, T3, L, { key: "M", oneLine: "新计划" }], "--dedup", "rw-1");
    const n = listEvents(db).length;
    expect(await run(PM, "dag-rewrite", "i28", "--rev", "2", "--nodes", "[]", "--reason-kind", "new_issue", "--reason", "x", "--dedup", "rw-1"))
      .toMatchObject({ ok: true, duplicate: true, event: { seq: r.event.seq } });
    const b = await run(PM, "dag-bind", "i28", "M", "T5", "--rev", rev(), "--dedup", "bind-1");
    expect(await run(PM, "dag-bind", "i28", "M", "T5", "--rev", "1", "--dedup", "bind-1")).toMatchObject({ ok: true, duplicate: true, event: { seq: b.event.seq } });
    expect(listEvents(db).length).toBe(n + 2);
  });
});

describe("owner 审批", () => {
  test("取消进行中的节点 → pending + authorize ask（bind 到快照）；批之前当前版本不变；owner 批准后 dag-approve 生效", async () => {
    const r = await rewrite([T1, { ...T3, deps: ["T1"] }, L], "--cancel", "T2=方向变了");
    expect(r).toMatchObject({ ok: true, applied: false, version: null, proposal: { version: 2, baseVersion: 1, state: "pending" } });
    const ask = getAsk(db, r.askId)!;
    expect(ask).toMatchObject({ kind: "authorize", fromAgent: PM, fromChannelId: "c-pm", bind: { action: "dag_rewrite", params: { feature: F, version: 2, sha: r.proposal.sha } } });
    expect(getFeature(db, F)!.currentVersion).toBe(1);
    expect((await run(PM, "feature-show", "i28")).pending).toMatchObject({ version: 2, askId: r.askId });
    expect(await run(PM, "dag-approve", "i28")).toMatchObject({ ok: false, code: "conflict" });
    expect(await rewrite([T1, T2, L])).toMatchObject({ ok: false, code: "conflict", current: { pending: 2 } });
    answer(r.askId, "dag_rewrite_approve");
    const a = await run(PM, "dag-approve", "i28");
    expect(a).toMatchObject({ ok: true, version: { version: 2, approvedBy: "owner", askId: r.askId, cancels: [{ key: "T2", taskId: "T2", reason: "方向变了" }] }, proposal: { state: "approved" } });
    expect(getFeature(db, F)!.currentVersion).toBe(2);
    expect(getTask(db, "T2")!.featureId).toBeNull();
    expect(await run(PM, "dag-approve", "i28")).toMatchObject({ ok: false, code: "not_found" });
  });

  test("--scope-change 与改进行中节点的内容也要批；owner 驳回 → 作废，当前版本不变，可以重新提", async () => {
    const r = await rewrite([T1, T2, T3, { ...L, oneLine: "换个做法" }], "--scope-change");
    expect(r).toMatchObject({ ok: true, applied: false });
    answer(r.askId, "dag_rewrite_reject");
    expect(await run(PM, "dag-approve", "i28")).toMatchObject({ ok: false, code: "rejected", proposal: { state: "rejected" } });
    expect(versions()).toEqual([1]);
    const again = await rewrite([T1, { ...T2, oneLine: "改一句话" }, T3, L]);
    expect(again).toMatchObject({ ok: true, applied: false });
    expect(getAsk(db, again.askId)!.context).toContain("改了进行中的节点 T2");
  });

  test("审批绑定的快照被替换：库里拦改提案；强改后批准也对不上哈希，提案作废", async () => {
    const r = await rewrite([T1, { ...T3, deps: ["T1"] }, L], "--cancel", "T2=方向变了");
    expect(() => db.prepare("UPDATE dag_proposals SET nodes = '[]'").run()).toThrow(/rewrite-only/);
    expect(() => db.prepare("DELETE FROM dag_proposals").run()).toThrow(/rewrite-only/);
    answer(r.askId, "dag_rewrite_approve");
    db.prepare("DROP TRIGGER dag_proposals_frozen").run();
    db.prepare("UPDATE dag_proposals SET nodes = ?").run(J([{ ...T1, status: "done", estimate: "", inheritedFrom: 1 }, { ...L, taskId: null, status: "planned", estimate: "", inheritedFrom: 1 }]));
    const a = await run(PM, "dag-approve", "i28");
    expect(a).toMatchObject({ ok: false, code: "conflict", proposal: { state: "void" } });
    expect(a.error).toContain("hash mismatch");
    expect(versions()).toEqual([1]);
  });

  test("不是 owner 本人答的、ask 过期了：都不生效，提案作废", async () => {
    const r = await rewrite([T1, { ...T3, deps: ["T1"] }, L], "--cancel", "T2=方向变了");
    answer(r.askId, "dag_rewrite_approve", false);
    expect(await run(PM, "dag-approve", "i28")).toMatchObject({ ok: false, proposal: { state: "void" } });
    const r2 = await rewrite([T1, { ...T3, deps: ["T1"] }, L], "--cancel", "T2=方向变了");
    now += 8 * 24 * 3600_000;
    expect(await run(PM, "dag-approve", "i28")).toMatchObject({ ok: false, proposal: { state: "void", askId: r2.askId } });
    expect(versions()).toEqual([1]);
  });

  test("提案后卡开工了：批下来时按现在的状态重判，没开始时移出的节点现在进行中 → 作废", async () => {
    const r = await rewrite([T1, T2, L], "--scope-change");
    stage("T3", "build");
    answer(r.askId, "dag_rewrite_approve");
    const a = await run(PM, "dag-approve", "i28");
    expect(a).toMatchObject({ ok: false, proposal: { state: "void" } });
    expect(a.error).toContain("T3");
    expect(getTask(db, "T3")!.featureId).toBe(F);
  });
});

describe("dag-bind", () => {
  test("计划节点绑卡：不产生新版本，卡挂 featureId、投影跟卡走；已绑 / 别的项目 / 别的 feature / 已在别的节点 / 旧 rev 都拒", async () => {
    expect(await run(PM, "dag-bind", "i28", "L", "X1", "--rev", rev())).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "dag-bind", "i28", "L", "T2", "--rev", rev())).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(PM, "dag-bind", "i28", "T3", "T5", "--rev", rev())).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(PM, "dag-bind", "i28", "Z", "T5", "--rev", rev())).toMatchObject({ ok: false, code: "not_found" });
    expect(await run(PM, "dag-bind", "i28", "L", "T5", "--rev", "1")).toMatchObject({ ok: false, code: "conflict" });
    await run(PM, "feature-new", "f2", "--title", "另一个");
    await run(PM, "dag-init", "f2", "--rev", "1", "--nodes", J([{ taskId: "T6" }]));
    expect(await run(PM, "dag-bind", "i28", "L", "T6", "--rev", rev())).toMatchObject({ ok: false, code: "conflict" });
    stage("T5", "build");
    expect(await run(PM, "dag-bind", "i28", "L", "T5", "--rev", rev())).toMatchObject({ ok: true, node: { key: "L", taskId: "T5" } });
    expect(versions()).toEqual([1]);
    expect(getTask(db, "T5")!.featureId).toBe(F);
    const show = await run(PM, "feature-show", "i28");
    expect(show.nodes.find((n: any) => n.key === "L")).toMatchObject({ taskId: "T5", status: "build" });
    expect(await run(PM, "dag-bind", "i28", "L", "T4", "--rev", rev())).toMatchObject({ ok: false, code: "conflict" });
    expect(() => db.prepare("DELETE FROM dag_bindings").run()).toThrow(/rewrite-only/);
    // 绑上的卡开工了：重写时它就是进行中的节点
    expect(await rewrite([T1, T2, T3])).toMatchObject({ ok: false, code: "invalid", error: expect.stringContaining("--cancel L") });
  });
});

describe("dag-show --diff", () => {
  test("增 / 删 / 带入 / 取消四类；pending 也能比", async () => {
    const r = await rewrite([T1, { ...T3, deps: ["T1"] }, { key: "N", oneLine: "新节点" }], "--cancel", "T2=方向变了");
    const d = await run(PM, "dag-show", "i28", "--diff", "1", "pending");
    expect(d).toMatchObject({ ok: true, from: 1, to: 2, diff: {
      added: ["N"], removed: ["L"], cancelled: [{ key: "T2", reason: "方向变了" }],
      carried: [{ key: "T1", changed: false }, { key: "T3", changed: true }],
    } });
    const show = await run(PM, "dag-show", "i28");
    expect(show).toMatchObject({ current: 1, pending: { version: 2, askId: r.askId } });
    answer(r.askId, "dag_rewrite_approve");
    await run(PM, "dag-approve", "i28");
    expect((await run(PM, "dag-show", "i28", "--diff", "1", "2")).diff).toEqual(d.diff);
    expect(await run(PM, "dag-show", "i28", "--diff", "x")).toMatchObject({ ok: false, code: "invalid" });
  });
});
