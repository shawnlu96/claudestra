/** 等待图读侧（src/lib/ledger-deadlock-read.ts）+ 巡检接线：隔离的真实台账库（真迁移、真写入口），复现事故环与各种来源 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { collectAuditSnapshots, type SnapshotSources } from "../src/lib/ledger-audit-snapshot.js";
import { readWaitGraph } from "../src/lib/ledger-deadlock-read.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";

let dir: string, path: string, db: Database;
const ctx = { actor: "owner", now: 100 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dlk1-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  setMeta(db, ctx, { project: "p", key: "pms", value: ["agent-pm"] });
});
afterEach(() => {
  closeLedger(path);
  rmSync(dir, { recursive: true, force: true });
});

function card(id: string, globs: string[], stages: string[] = [], project = "p"): void {
  createTask(db, ctx, { project, id, title: `${id} 标题里写着 UPDW 也不算事实`, kind: "code", extra: { fileGlobs: globs } });
  setWorkflow(db, ctx, { taskId: id, taskRev: getTask(db, id)!.rev, mode: "auto", template: "code", templateVersion: 2, authorFamily: "claude", fallback: "wait" });
  let from = "spec";
  for (const to of stages) {
    moveStage(db, ctx, { taskId: id, from: from as never, to: to as never });
    from = to;
  }
}
/** 真实持锁：调度表里的一行 dispatch 意图 + 它拿到的文件锁（与 planIntent 落库的列一致） */
function hold(taskId: string, resource: string, project = "p"): void {
  const id = `t68:${taskId}:${resource}`;
  db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt) VALUES (?, ?, ?, 'write', 'dispatch', 'agent-w', 1, 1, 1, 1, NULL, 2, 'done', 'x', 200, 200)`).run(id, taskId, project);
  db.prepare("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, 300, 'card')").run(project, resource, taskId, id);
}
function feature(slug: string, nodes: unknown[]): string {
  createFeature(db, ctx, { project: "p", slug, title: slug });
  initDag(db, ctx, { id: `ab12-${slug}`, rev: 1, nodes });
  return `ab12-${slug}`;
}

/** UPDW -依赖-> UGCFG -文件-> MQ1 -DAG(另一个 feature)-> REBOR2 -文件-> UPDW */
function incident(): void {
  card("UPDW", ["src/lib/update-gate.ts"], ["restate", "build"]);
  card("UGCFG", ["src/lib/scheduler-config.ts"]);
  card("MQ1", ["src/lib/scheduler-config.ts"], ["restate", "build"]);
  card("REBOR2", ["src/lib/update-*.ts"], ["restate", "build", "review", "fix"]);
  addDep(db, ctx, { from: "UGCFG", to: "UPDW", when: "配置先上线" });
  hold("UPDW", "src/lib/update-gate.ts");
  hold("MQ1", "src/lib/scheduler-config.ts");
  hold("MQ1", "slot:p:0");
  feature("mq", [{ key: "MQ1", taskId: "MQ1", deps: ["REBOR2"] }, { key: "REBOR2", taskId: "REBOR2" }]);
  feature("upd", [{ key: "UPDW", taskId: "UPDW" }]);
}

test("真实台账复现本次复合环：整条链、边类型、来源与快照 seq", () => {
  incident();
  const g = readWaitGraph(db, "p");
  expect(g.unknown).toEqual([]);
  expect(g.cycles.map((c) => c.nodes)).toEqual([["MQ1", "REBOR2", "UPDW", "UGCFG"]]);
  expect(g.cycles[0].edges.map((e) => `${e.from}-${e.kind}-${e.to}`)).toEqual(["MQ1-dag-REBOR2", "REBOR2-resource-UPDW", "UPDW-dep-UGCFG", "UGCFG-resource-MQ1"]);
  expect(g.cycles[0].edges[0]).toMatchObject({ feature: "ab12-mq", version: 1 });
  expect(g.cycles[0].edges[3]).toMatchObject({ intentId: "t68:MQ1:src/lib/scheduler-config.ts", held: "src/lib/scheduler-config.ts" });
  expect(g.asOfSeq).toBe((db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s);
  expect(JSON.stringify(g)).not.toContain("标题"); // 只带必要元数据，不导出标题 / 备注
});

test("巡检接线：快照带上等待图，发现推 PM，重复扫描同一个 key；只读不改库", async () => {
  incident();
  const src: SnapshotSources = {
    registry: async () => [], windows: async () => ["0"], turn: async () => "idle",
    fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json"),
  };
  const before = db.query("SELECT COUNT(*) AS n, MAX(seq) AS s FROM events").get();
  const locks = db.query("SELECT * FROM scheduler_resources ORDER BY resource").all();
  const [s] = await collectAuditSnapshots(db, ["p"], 1000, src);
  const r = auditLedger(s, 1000);
  const cyc = r.findings.filter((f) => f.rule === "wait_cycle");
  expect(cyc).toEqual([expect.objectContaining({ project: "p", taskId: "MQ1", notify: "agent-pm" })]);
  expect(r.evaluated).toContain("wait_cycle");
  const [again] = await collectAuditSnapshots(db, ["p"], 2000, src);
  expect(auditLedger(again, 2000).findings.filter((f) => f.rule === "wait_cycle").map((f) => f.key)).toEqual(cyc.map((f) => f.key));
  expect(db.query("SELECT COUNT(*) AS n, MAX(seq) AS s FROM events").get()).toEqual(before);
  expect(db.query("SELECT * FROM scheduler_resources ORDER BY resource").all()).toEqual(locks);
});

test("终态解环：环上一张卡取消后环消失", () => {
  incident();
  moveStage(db, ctx, { taskId: "UGCFG", from: "spec", to: "cancelled" });
  expect(readWaitGraph(db, "p").cycles).toEqual([]);
});

test("已释放的锁不留旧环（备注 / 标题写了什么都不算）", () => {
  incident();
  db.prepare("DELETE FROM scheduler_resources WHERE taskId = 'UPDW'").run();
  expect(readWaitGraph(db, "p").cycles).toEqual([]);
});

test("别的项目里同名路径的锁不算；通配符跨项目也不算", () => {
  card("W", ["src/lib/*"], ["restate", "build"]);
  card("H", ["x.ts"], ["restate", "build"]);
  card("Q", ["src/lib/a.ts"], [], "q");
  hold("Q", "src/lib/a.ts", "q");
  expect(readWaitGraph(db, "p").edges).toEqual([]);
  hold("H", "src/lib/b.ts");
  expect(readWaitGraph(db, "p").edges).toEqual([expect.objectContaining({ kind: "resource", from: "W", to: "H", wanted: "src/lib/*" })]);
});

test("活卡等未建卡节点：报 missing-node 与链；普通 planned 节点不报", () => {
  card("A", ["a.ts"], ["restate", "build"]);
  const fid = feature("f", [{ key: "A", taskId: "A", deps: ["P"] }, { key: "P", oneLine: "P" }, { key: "R", oneLine: "R", deps: ["A"] }]);
  const g = readWaitGraph(db, "p");
  expect(g.missing.map((m) => [m.origin, m.node, m.chain])).toEqual([["A", `${fid}#P`, ["A", `${fid}#P`]]]);
  card("P1", ["p.ts"]);
  bindNode(db, ctx, { id: fid, rev: getFeature(db, fid)!.rev, key: "P", taskId: "P1" });
  expect(readWaitGraph(db, "p").missing).toEqual([]);
  expect(readWaitGraph(db, "p").edges.map((e) => `${e.from}-${e.kind}-${e.to}`)).toEqual(["A-dag-P1", `${fid}#R-dag-A`]);
});

test("坏来源 → unknown：DAG 版本 JSON 坏了不当无环，巡检不把等待规则列进 evaluated", () => {
  incident();
  const fid = "ab12-mq";
  db.prepare(`INSERT INTO dag_versions (featureId, version, reasonKind, reasonText, proposedBy, approvedBy, createdAt, nodes)
    VALUES (?, 2, 'new_issue', 'x', 'pm', 'pm', 400, '{bad')`).run(fid);
  db.prepare("UPDATE features SET currentVersion = 2 WHERE id = ?").run(fid);
  const g = readWaitGraph(db, "p");
  expect(g.unknown).toEqual([expect.stringContaining(`${fid} v2 节点 JSON 读不了`)]);
  expect(g.cycles).toEqual([]);
  const r = auditLedger({ project: "p", pms: ["agent-pm"], tasks: [], agents: [], reviewers: [], held: [], ownerInbox: [], waitGraph: g }, 1000);
  expect(r.evaluated).not.toContain("wait_cycle");
  expect(r.skipped).toEqual([
    { rule: "wait_cycle", reason: expect.stringContaining("等待图取数不完整") }, { rule: "wait_missing_node", reason: expect.stringContaining("等待图取数不完整") },
  ]);
});

test("老库缺调度 / feature 表：没有这类事实，不是 unknown", () => {
  card("A", ["a.ts"]);
  db.exec("DROP TABLE scheduler_resources");
  expect(readWaitGraph(db, "p")).toMatchObject({ unknown: [], edges: [], cycles: [] });
});
