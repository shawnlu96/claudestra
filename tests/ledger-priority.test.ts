import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createItem, createTask, setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { runLedger } from "../src/manager/ledger.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { readPriority, priorityHistory } from "../src/lib/ledger-priority-read.js";
import { setPriority, setPriorityOrder, setPriorityMode } from "../src/lib/ledger-priority-write.js";
import type { PriorityBand, PriorityTarget } from "../src/lib/ledger-priority-types.js";
import { setItem, setTask, importTask } from "../src/lib/ledger-write.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { getFeature, getDagVersion, effectiveNodes, type DagNode } from "../src/lib/ledger-feature.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { setFeature } from "../src/lib/ledger-feature-write.js";
import { isWriteInvocation, READER_ONLY_SUBS } from "../src/manager/write-commands.js";

let db: Database;
const project = "prio";
const pm = "agent-pm";
const feature = "ab12-work";
function run(actor: string, ...args: string[]) {
  return runLedger(args, { db, actor, actorProject: project, projectIds: [project, "other"],
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 2000 });
}
beforeEach(() => {
  db = openLedger(":memory:");
  db.query("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')").run();
  setMeta(db, { actor: "owner" }, { project, key: "pms", value: [pm, "agent-dispatcher"] });
  createItem(db, { actor: "owner" }, { project, id: "legacy", title: "old", priority: "P0" });
  createTask(db, { actor: "owner" }, { project, id: "T1", title: "task", kind: "code", itemId: "legacy" });
  createFeature(db, { actor: pm }, { project, slug: "work", title: "work" });
  initDag(db, { actor: pm }, { id: feature, rev: 1, nodes: [
    { key: "card", taskId: "T1" }, { key: "planned", oneLine: "planned" },
  ] });
});
afterEach(() => closeLedger(":memory:"));

const ownerEvidence = { ownerWords: "这个现在做", ownerAt: 1000, sourceRef: "discord:owner/100" };
function write(target: PriorityTarget, band: PriorityBand | null, rev = 0, key: string = crypto.randomUUID(), actor = pm) {
  return setPriority(db, { actor, project, now: 2000, dedupKey: key }, { target, band, rev, evidence: ownerEvidence });
}
const card: PriorityTarget = { kind: "task", id: "T1" };
const parent: PriorityTarget = { kind: "feature", id: feature };
const planned: PriorityTarget = { kind: "node", id: feature, nodeKey: "planned" };

function flags(rev = 0, key: string = crypto.randomUUID()) {
  return ["--rev", String(rev), "--dedup", key, "--owner-words", ownerEvidence.ownerWords,
    "--owner-at", String(ownerEvidence.ownerAt), "--source", ownerEvidence.sourceRef];
}

test("旧文本 priority 不参与调度，默认 next 且标明 owner 未登记", async () => {
  expect(await run(pm, "priority-show", "task", "T1")).toMatchObject({ ok: true,
    priority: { effective: "next", source: "system", ownerRegistered: false, legacyPriority: "P0" } });
});

test("feature 修改即时影响继承卡和计划；显式档不受影响；clear 恢复动态继承", () => {
  write(parent, "now");
  expect(readPriority(db, project, card)).toMatchObject({ effective: "now", source: "feature", inheritedFrom: feature });
  expect(readPriority(db, project, planned).effective).toBe("now");
  write(card, "later");
  write(parent, "next", 1);
  expect(readPriority(db, project, card)).toMatchObject({ effective: "later", source: "explicit" });
  write(card, null, 1);
  expect(readPriority(db, project, card)).toMatchObject({ effective: "next", source: "feature", rev: 2 });
  write(parent, null, 2);
  expect(readPriority(db, project, card)).toMatchObject({ effective: "next", source: "system", ownerRegistered: false });
  expect(priorityHistory(db, project, card).map((e) => e.data.op)).toEqual(["set", "clear"]);
});

test("owner 与项目当班真实 PM 能登记，master、scheduler、调度助理、普通及退休 PM 拒绝", () => {
  setMeta(db, { actor: "owner" }, { project, key: "team", value: { dispatcher: "agent-dispatcher", audit: true } });
  for (const actor of ["master", "scheduler", "import", "agent-worker", "agent-dispatcher", "unknown", "agent-oldpm"]) {
    const n = listEvents(db).length;
    expect(() => write(parent, "now", 0, crypto.randomUUID(), actor)).toThrow("只有 owner");
    expect(listEvents(db)).toHaveLength(n);
  }
  write(parent, "now", 0, "owner-set", "owner");
  write(parent, "later", 1);
  db.query("INSERT INTO meta(project,key,value) VALUES (?,'activePm',?)").run(project, JSON.stringify("agent-retired"));
  expect(() => write(parent, "now", 2)).toThrow("只有 owner");
});

test("缺原话/时间/来源、非法枚举、CAS、dedup 校验失败均不留半份记录", () => {
  const before = db.query("SELECT count(*) n FROM priority_records").get();
  const ctx = { actor: pm, project, now: 2000, dedupKey: "new-key" };
  for (const evidence of [{ ...ownerEvidence, ownerWords: " " }, { ...ownerEvidence, ownerAt: 0 }, { ...ownerEvidence, sourceRef: "" }]) {
    expect(() => setPriority(db, ctx, { target: parent, rev: 0, band: "now", evidence })).toThrow("原话");
  }
  expect(() => write(parent, "P0" as PriorityBand)).toThrow("档位");
  expect(() => write(parent, "now", NaN)).toThrow("rev");
  expect(() => write(parent, "now", 0, "")).toThrow("dedupKey");
  expect(db.query("SELECT count(*) n FROM priority_records").get()).toEqual(before);
  const a = write(parent, "now", 0, "same");
  expect(write(parent, "now", 0, "same")).toMatchObject({ duplicate: true, event: { seq: a.event.seq }, row: a.row });
  expect(() => write(parent, "later", 0, "same")).toThrow("去重键");
  expect(() => write(parent, "later", 0)).toThrow("版本冲突");
  write(parent, "later", 1);
  expect(write(parent, "now", 0, "same").row).toEqual(a.row);
  expect(priorityHistory(db, project, parent)).toHaveLength(2);
});

test("CLI 六命令可用：鉴权、项目、枚举、缺 CAS/去重键全拒绝", async () => {
  expect(await run("owner", "priority-set", "feature", feature, "--band", "now", ...flags())).toMatchObject({ ok: true });
  expect(await run(pm, "priority-set", "task", "T1", "--band", "later", ...flags())).toMatchObject({ ok: true });
  expect(await run(pm, "priority-clear", "task", "T1", ...flags(1))).toMatchObject({ ok: true, priority: { effective: "now" } });
  expect(await run(pm, "priority-history", "task", "T1")).toMatchObject({ ok: true });
  expect(await run("master", "priority-set", "feature", feature, "--band", "next", ...flags(1))).toMatchObject({ ok: false, code: "forbidden" });
  expect(await run(pm, "priority-show", "task", "T1", "--project", "other")).toMatchObject({ ok: false, code: "not_found" });
  expect(await run(pm, "priority-set", "task", "T1", "--band", "P1", ...flags(2))).toMatchObject({ ok: false, code: "invalid" });
  expect(await run(pm, "priority-set", "task", "T1", "--band", "next")).toMatchObject({ ok: false, code: "invalid" });
});

test("通用 set/new/import/feature/DAG 与 nested extra 的受控字段均拒绝，旧事项 priority 仍可写", () => {
  const count = listEvents(db).length, taskRev = getTask(db, "T1")!.rev;
  for (const key of ["workPriority", "effectivePriority", "priorityRecordId", "priorityOrder",
    "prioritySort", "priorityNowStart", "priorityStall", "priorityPanel"]) {
    expect(() => setTask(db, { actor: "owner" }, { id: "T1", rev: taskRev, patch: { extra: { nested: [{ [key]: "now" }] } } })).toThrow("专用入口");
    expect(() => createItem(db, { actor: "owner" }, { project, id: "bad", title: "bad", extra: { [key]: "now" } })).toThrow("专用入口");
  }
  expect(() => createFeature(db, { actor: pm }, { project, slug: "bad", title: "bad", ...{ workPriority: "now" } })).toThrow("专用入口");
  expect(() => createTask(db, { actor: "owner" }, { project, id: "bad", title: "bad", kind: "code", extra: { workPriority: "now" } })).toThrow("专用入口");
  expect(() => importTask(db, { actor: "owner" }, { task: { project, id: "bad", title: "bad", kind: "code", extra: { workPriority: "now" } },
    createdTs: 1000, events: [] })).toThrow("专用入口");
  expect(listEvents(db)).toHaveLength(count);
  expect(getTask(db, "T1")!.rev).toBe(taskRev);
  setItem(db, { actor: "owner" }, { project, id: "legacy", rev: 1, patch: { priority: "现在做" } });
  expect(readPriority(db, project, card).effective).toBe("next");
});

test("同档顺序只在项目/队列内；异档、重复、跨项目批次整笔回滚；顺序及历史可查询", async () => {
  const targets = [planned, card];
  expect(readPriority(db, project, card).order).toBeNull();
  const result = await run(pm, "priority-order", "next", "--queue", "build", "--targets", JSON.stringify(targets), ...flags());
  expect(result).toMatchObject({ ok: true, order: { rev: 1 } });
  expect(readPriority(db, project, card, "build").order).toBe(1);
  expect(readPriority(db, project, card).order).toBeNull();
  expect(await run(pm, "priority-order", "next", "--queue", "build")).toMatchObject({ ok: true, order: { rev: 1 } });
  expect(priorityHistory(db, project, card).map((e) => e.data.op)).toEqual(["order"]);
  expect(() => setPriorityOrder(db, { actor: pm, project, dedupKey: "dup" },
    { queue: "other", band: "next", targets: [card, card], rev: 0, evidence: ownerEvidence })).toThrow("重复");
  expect(await run(pm, "priority-order", "next", "--queue", "other")).toMatchObject({ ok: true, order: { members: [], rev: 0 } });
  write(card, "now");
  expect(() => setPriorityOrder(db, { actor: pm, project, dedupKey: "mixed" },
    { queue: "other", band: "next", targets, rev: 0, evidence: ownerEvidence })).toThrow("同一档位");
});

test("四个独立开关默认 observe；off/observe/on CAS + 历史，不改卡/派单/asks", async () => {
  expect(await run(pm, "priority-mode")).toMatchObject({ ok: true, modes: {
    prioritySort: { mode: "observe", rev: 0 }, priorityNowStart: { mode: "observe", rev: 0 },
    priorityStall: { mode: "observe", rev: 0 }, priorityPanel: { mode: "observe", rev: 0 },
  } });
  const cardBefore = getTask(db, "T1"), asks = db.query("SELECT * FROM asks").all();
  const modes = ["off", "observe", "on"] as const;
  for (const [i, mode] of modes.entries()) {
    expect(await run(pm, "priority-mode", "prioritySort", "--mode", mode, ...flags(i))).toMatchObject({ ok: true, mode: { mode, rev: i + 1 } });
  }
  expect(getTask(db, "T1")).toEqual(cardBefore);
  expect(db.query("SELECT * FROM asks").all()).toEqual(asks);
  expect(await run(pm, "priority-mode")).toMatchObject({ modes: { priorityPanel: { mode: "observe", rev: 0 } } });
  expect(() => setPriorityMode(db, { actor: pm, project, dedupKey: "invalid-mode" },
    { mechanism: "prioritySort", mode: "invalid" as "on", rev: 3, evidence: ownerEvidence })).toThrow("非法");
  expect(priorityHistory(db, project).filter((e) => e.data.op === "mode")).toHaveLength(3);
});

function currentNodes(): DagNode[] {
  return effectiveNodes(db, getDagVersion(db, feature, getFeature(db, feature)!.currentVersion)!);
}
function rewrite(nodes: unknown) {
  return rewriteDag(db, { actor: pm }, { id: feature, rev: getFeature(db, feature)!.rev, nodes,
    reasonKind: "requirement_change", reasonText: "owner 调整计划", cancel: new Map(), scopeChange: false,
    askFrom: { agent: pm, channelId: null } });
}
function newTask(id: string) {
  return createTask(db, { actor: "owner" }, { project, id, title: id, kind: "code" });
}

test("计划定档再绑定，卡/节点共用一份真值及历史；去重不会重复绑定", () => {
  const a = write(planned, "now");
  newTask("T2");
  const ctx = { actor: pm, dedupKey: "bind" }, input = { id: feature, rev: getFeature(db, feature)!.rev, key: "planned", taskId: "T2" };
  bindNode(db, ctx, input);
  expect(bindNode(db, ctx, input).duplicate).toBe(true);
  const node = readPriority(db, project, planned), task = readPriority(db, project, { kind: "task", id: "T2" });
  expect(task).toMatchObject({ recordId: a.row.recordId, effective: "now", explicit: "now", rev: 2 });
  expect(node.recordId).toBe(task.recordId);
  expect(priorityHistory(db, project, { kind: "task", id: "T2" }).map((e) => e.data.op)).toEqual(["set", "bind"]);
  write({ kind: "task", id: "T2" }, "later", 2);
  expect(readPriority(db, project, planned).effective).toBe("later");
});

test("卡先定档再绑定会合并历史和排序；冲突授权拒绝整笔绑卡", () => {
  newTask("T2");
  const t: PriorityTarget = { kind: "task", id: "T2" };
  write(t, "later");
  setPriorityOrder(db, { actor: pm, project, dedupKey: "before-bind" },
    { queue: "project", band: "later", targets: [t], rev: 0, evidence: ownerEvidence });
  bindNode(db, { actor: pm }, { id: feature, rev: getFeature(db, feature)!.rev, key: "planned", taskId: "T2" });
  const linked = readPriority(db, project, t);
  expect(linked).toMatchObject({ explicit: "later", effective: "later", order: 0, rev: 2 });
  expect(readPriority(db, project, planned).recordId).toBe(linked.recordId);
  expect(priorityHistory(db, project, planned).map((e) => e.data.op)).toEqual(["set", "order", "bind"]);
  rewrite([...currentNodes(), { key: "conflict", oneLine: "conflict" }]);
  const c: PriorityTarget = { kind: "node", id: feature, nodeKey: "conflict" };
  write(c, "now");
  newTask("T3");
  write({ kind: "task", id: "T3" }, "later");
  const rev = getFeature(db, feature)!.rev, n = listEvents(db).length;
  expect(() => bindNode(db, { actor: pm }, { id: feature, rev, key: "conflict", taskId: "T3" })).toThrow("都有显式");
  expect(getFeature(db, feature)!.rev).toBe(rev);
  expect(db.query("SELECT 1 FROM dag_bindings WHERE taskId='T3'").get()).toBeNull();
  expect(listEvents(db)).toHaveLength(n);
});

test("DAG 编辑保留节点身份；删除后同名新节点无旧授权；历史仍能查询", () => {
  write(planned, "now", 0, "old-grant");
  const id = readPriority(db, project, planned).recordId;
  rewrite(currentNodes().map((n) => n.key === "planned" ? { ...n, oneLine: "补充计划" } : n));
  expect(readPriority(db, project, planned)).toMatchObject({ recordId: id, effective: "now" });
  rewrite(currentNodes().filter((n) => n.key !== "planned"));
  expect(priorityHistory(db, project, planned).map((e) => e.data.op)).toEqual(["set", "retire"]);
  rewrite([...currentNodes(), { key: "planned", oneLine: "同名新工作" }]);
  expect(readPriority(db, project, planned)).toMatchObject({ effective: "next", source: "system", rev: 0 });
  expect(readPriority(db, project, planned).recordId).not.toBe(id);
  expect(write(planned, "now", 0, "old-grant").duplicate).toBe(true);
  expect(readPriority(db, project, planned).effective).toBe("next");
  write(planned, "later");
  expect(priorityHistory(db, project, planned).map((e) => e.data.op)).toEqual(["set", "retire", "set"]);
});

test("同一版把已绑卡节点换成新卡也产生新身份", () => {
  const node: PriorityTarget = { kind: "node", id: feature, nodeKey: "card" };
  write(node, "now");
  const id = readPriority(db, project, node).recordId;
  newTask("T2");
  rewrite(currentNodes().map((n) => n.key === "card" ? { ...n, taskId: "T2" } : n));
  expect(readPriority(db, project, node)).toMatchObject({ effective: "next", rev: 0 });
  expect(readPriority(db, project, node).recordId).not.toBe(id);
  expect(readPriority(db, project, card)).toMatchObject({ recordId: id, effective: "now", source: "explicit" });
  expect(priorityHistory(db, project, { kind: "task", id: "T1" }).map((e) => e.data.op)).toEqual(["set", "retire"]);
});

test("已绑卡在同一 DAG 内改名/移动仍保存显式档位、记录和旧位置历史", () => {
  write(card, "later");
  const id = readPriority(db, project, card).recordId;
  rewrite(currentNodes().map((n) => n.key === "card" ? { ...n, key: "renamed" } : n));
  const moved = { kind: "node", id: feature, nodeKey: "renamed" } as const;
  expect(readPriority(db, project, card)).toMatchObject({ recordId: id, effective: "later" });
  expect(readPriority(db, project, moved)).toMatchObject({ recordId: id, effective: "later" });
  expect(priorityHistory(db, project, { kind: "node", id: feature, nodeKey: "card" }).map((e) => e.data.op)).toEqual(["set", "move"]);
});

test("两张卡交换节点key：先释放定位再搬迁，两份档位及身份均保持", () => {
  newTask("T2");
  bindNode(db, { actor: pm }, { id: feature, rev: getFeature(db, feature)!.rev, key: "planned", taskId: "T2" });
  const other = { kind: "task", id: "T2" } as const;
  write(card, "now"); write(other, "later");
  const a = readPriority(db, project, card).recordId, b = readPriority(db, project, other).recordId;
  rewrite(currentNodes().map((n) => n.key === "card" ? { ...n, key: "planned" } : n.key === "planned" ? { ...n, key: "card" } : n));
  expect(readPriority(db, project, card)).toMatchObject({ recordId: a, effective: "now" });
  expect(readPriority(db, project, other)).toMatchObject({ recordId: b, effective: "later" });
});

test("只有同档顺序授权的计划搬迁，也保存原位置历史", () => {
  setPriorityOrder(db, { actor: pm, project, dedupKey: "ordered-only" },
    { queue: "project", band: "next", targets: [planned], rev: 0, evidence: ownerEvidence });
  const id = readPriority(db, project, planned).recordId;
  applyFeatureSplit(db, { actor: pm }, feature, { targets: [{ slug: "ordered", title: "ordered", nodes: ["planned"] }], deps: [] });
  expect(readPriority(db, project, { kind: "node", id: "ab12-ordered", nodeKey: "planned" })).toMatchObject({ recordId: id, order: 0 });
  expect(priorityHistory(db, project, planned).map((e) => e.data.op)).toEqual(["order", "move"]);
});

test("旧图缺记录时拆分仅补无授权身份，缺省 observe 不新增通知或优先级事件", () => {
  db.query("DELETE FROM priority_records").run();
  applyFeatureSplit(db, { actor: pm }, feature, { targets: [{ slug: "legacy", title: "legacy", nodes: ["planned"] }], deps: [] });
  expect(readPriority(db, project, { kind: "node", id: "ab12-legacy", nodeKey: "planned" })).toMatchObject({ effective: "next", rev: 0 });
  expect(priorityHistory(db, project)).toEqual([]);
});

test("拆分搬迁保存同一记录与来源历史；未显式节点改为继承目标 feature", () => {
  write(planned, "now");
  write(parent, "later");
  const id = readPriority(db, project, planned).recordId;
  const result = applyFeatureSplit(db, { actor: pm }, feature,
    { targets: [{ slug: "target", title: "target", nodes: ["planned", "card"] }], deps: [] });
  expect(result.duplicate).toBe(false);
  const dest = { kind: "node", id: "ab12-target", nodeKey: "planned" } as const;
  expect(readPriority(db, project, dest)).toMatchObject({ recordId: id, effective: "now" });
  expect(readPriority(db, project, card)).toMatchObject({ effective: "next", source: "system" });
  write({ kind: "feature", id: "ab12-target" }, "now");
  expect(readPriority(db, project, card)).toMatchObject({ effective: "now", inheritedFrom: "ab12-target" });
  expect(priorityHistory(db, project, planned).map((e) => e.data.op)).toEqual(["set", "move"]);
  expect(priorityHistory(db, project, dest).map((e) => e.data.op)).toEqual(["set", "move"]);
});

test("通用网页/CLI extra、feature-set、DAG rewrite 均拒绝受控字段且没有副作用", async () => {
  const before = listEvents(db).length, f = getFeature(db, feature)!;
  expect(await run(pm, "task-set", "T1", "--rev", String(getTask(db, "T1")!.rev), "--extra", '{"workPriority":"now"}'))
    .toMatchObject({ ok: false, code: "invalid" });
  expect(() => setFeature(db, { actor: pm }, { id: feature, rev: f.rev, patch: { title: "changed", ...{ workPriority: "now" } } }))
    .toThrow("专用入口");
  expect(() => rewrite(currentNodes().map((n) => ({ ...n, ...{ extra: { workPriority: "now" } } })))).toThrow("专用入口");
  expect(getFeature(db, feature)).toEqual(f);
  expect(listEvents(db)).toHaveLength(before);
});

test("priority-show/history 走纯只读连接，专用写命令仍过写身份守卫", () => {
  for (const sub of ["priority-show", "priority-history"]) {
    expect(isWriteInvocation("ledger", [sub])).toBe(false);
    expect(READER_ONLY_SUBS.has(sub)).toBe(true);
  }
  for (const sub of ["priority-set", "priority-clear", "priority-order", "priority-mode"]) {
    expect(isWriteInvocation("ledger", [sub])).toBe(true);
  }
});
