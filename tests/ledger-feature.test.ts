/** feature + 子 DAG（T84）：CLI 正反例、CAS、dag-init 只建 v1、版本只追加、投影状态跟任务卡走、事件带 origin */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getFeature } from "../src/lib/ledger-feature.js";
import { ledgerOrigin, storedOrigin } from "../src/lib/ledger-origin.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import { openAsk } from "../src/lib/ledger-asks.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const PM = "agent-pm";
const EXE = "agent-exec";
let db: Database;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: actor === "owner" ? undefined : P, projectIds: [P, "other"],
    loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => 1_000,
  }) as Promise<Record<string, any>>;
}

const nodes = (xs: unknown) => JSON.stringify(xs);

beforeEach(() => {
  db = openLedger(":memory:");
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  const owner = { actor: "owner", now: 500 };
  setMeta(db, owner, { project: P, key: "pms", value: [PM] });
  for (const id of ["T1", "T2", "T3"]) createTask(db, owner, { project: P, id, title: `任务 ${id}`, kind: "code", agent: EXE });
  createTask(db, owner, { project: "other", id: "X1", title: "别的项目", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

async function newFeature(slug = "i28") {
  const r = await run(PM, "feature-new", slug, "--title", slug === "i28" ? "协作底座改版" : `feature ${slug}`, "--words", "它也有自己的 DAG");
  expect(r).toMatchObject({ ok: true, feature: { id: `ab12-${slug}`, project: P, status: "active", currentVersion: 0, rev: 1 } });
  return r.feature.id as string;
}

describe("feature-new / feature-set", () => {
  test("id 带本机前缀；slug 与全 id 都能找到；同项目同名被拒", async () => {
    const id = await newFeature();
    expect((await run(PM, "feature-show", "i28")).feature.id).toBe(id);
    expect((await run(EXE, "feature-show", id)).feature.id).toBe(id);
    expect(await run(PM, "feature-new", "other", "--title", "协作底座改版")).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(PM, "feature-new", "i28", "--title", "另一个")).toMatchObject({ ok: false, code: "conflict" });
    expect(await run(PM, "feature-new", "bad slug", "--title", "x")).toMatchObject({ ok: false, code: "invalid" });
  });

  test("只有 PM / master / owner 能写；执行者被拒", async () => {
    expect(await run(EXE, "feature-new", "f1", "--title", "x")).toMatchObject({ ok: false, code: "forbidden" });
    await newFeature();
    expect(await run(EXE, "feature-set", "i28", "--rev", "1", "--status", "paused")).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("CAS：带旧 rev 改会冲突，current 带库里的 rev；改成功 rev + 1 并留事件", async () => {
    const id = await newFeature();
    expect(await run(PM, "feature-set", id, "--rev", "1", "--status", "paused")).toMatchObject({ ok: true, feature: { status: "paused", rev: 2 } });
    expect(await run(PM, "feature-set", id, "--rev", "1", "--title", "新名字")).toMatchObject({ ok: false, code: "conflict", current: { rev: 2 } });
    expect(await run(PM, "feature-set", id, "--title", "新名字")).toMatchObject({ ok: false, code: "invalid" });
    expect(await run(PM, "feature-set", id, "--rev", "2", "--status", "nope")).toMatchObject({ ok: false, code: "invalid" });
    const evs = listEvents(db, { target: id });
    expect(evs.map((e) => [e.kind, e.data.op])).toEqual([["feature", "new"], ["feature", "set"]]);
  });

  test("--dedup 重放返回原事件，不重复写", async () => {
    const a = await run(PM, "feature-new", "i29", "--title", "t", "--dedup", "k1");
    const b = await run(PM, "feature-new", "i29", "--title", "t", "--dedup", "k1");
    expect(b).toMatchObject({ ok: true, duplicate: true, event: { seq: a.event.seq } });
    expect(listEvents(db, { target: "ab12-i29" })).toHaveLength(1);
  });
});

describe("dag-init", () => {
  test("建 v1：节点快照、任务卡挂上 featureId 并各留一条 task 事件、feature 版本 = 1", async () => {
    const id = await newFeature();
    const rev0 = getTask(db, "T2")!.rev;
    const r = await run(PM, "dag-init", "i28", "--rev", "1", "--reason", "owner 09-30 开工",
      "--nodes", nodes([{ taskId: "T1", oneLine: "迁移", estimate: "半天" }, { taskId: "T2", deps: ["T1"] }]));
    expect(r).toMatchObject({ ok: true, version: { featureId: id, version: 1, reasonKind: "initial", reasonText: "owner 09-30 开工", proposedBy: PM, approvedBy: null } });
    expect(r.version.nodes).toEqual([
      { key: "T1", taskId: "T1", oneLine: "迁移", deps: [], status: "spec", estimate: "半天", inheritedFrom: null },
      { key: "T2", taskId: "T2", oneLine: "任务 T2", deps: ["T1"], status: "spec", estimate: "", inheritedFrom: null },
    ]);
    expect(getFeature(db, id)).toMatchObject({ currentVersion: 1, rev: 2 });
    expect(getTask(db, "T2")).toMatchObject({ featureId: id, rev: rev0 + 1 });
    expect(getTask(db, "T3")!.featureId).toBeNull();
    expect(listEvents(db, { target: "T2" }).at(-1)).toMatchObject({ kind: "task", data: { op: "set", patch: { featureId: id }, rev: rev0 + 1 } });
    expect(listEvents(db, { target: id }).at(-1)).toMatchObject({ kind: "feature", data: { op: "dag-init", version: 1, nodes: ["T1", "T2"] } });
  });

  test("已有 v1 再 dag-init（带当前 rev）被拒：建不出第二版", async () => {
    await newFeature();
    expect((await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes([{ taskId: "T1" }]))).ok).toBe(true);
    const again = await run("owner", "dag-init", "i28", "--rev", "2", "--nodes", nodes([{ taskId: "T1" }, { taskId: "T2" }]));
    expect(again).toMatchObject({ ok: false, code: "conflict", current: { currentVersion: 1 } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM dag_versions").get()).toEqual({ n: 1 });
  });

  test("库里也拦：版本不能改、不能删；v2 以后不能标成初版", async () => {
    await newFeature();
    await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes([{ taskId: "T1" }]));
    expect(() => db.prepare("UPDATE dag_versions SET nodes = '[]'").run()).toThrow(/rewrite-only/);
    expect(() => db.prepare("DELETE FROM dag_versions").run()).toThrow(/rewrite-only/);
    expect(() => db.prepare("INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes) VALUES ('ab12-i28', 2, 'initial', 'x', 0, '[]')").run()).toThrow();
  });

  test("REPLACE / UPSERT 也换不掉已有版本：快照与事件都不变", async () => {
    await newFeature();
    await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes([{ taskId: "T1" }]));
    const before = db.prepare("SELECT * FROM dag_versions").all();
    const evs = listEvents(db).length;
    const row = "INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes) VALUES ('ab12-i28', 1, 'initial', 'x', 9, '[]')";
    for (const sql of [`INSERT ${row}`, `INSERT OR REPLACE ${row}`, `REPLACE ${row}`, `INSERT ${row} ON CONFLICT (featureId, version) DO UPDATE SET nodes = excluded.nodes`]) {
      expect(() => db.prepare(sql).run()).toThrow();
    }
    expect(db.prepare("SELECT * FROM dag_versions").all()).toEqual(before);
    expect(listEvents(db).length).toBe(evs);
  });

  test("CAS：带旧 rev 被拒，库不动", async () => {
    const id = await newFeature();
    await run(PM, "feature-set", id, "--rev", "1", "--words", "改过");
    expect(await run(PM, "dag-init", id, "--rev", "1", "--nodes", nodes([{ taskId: "T1" }]))).toMatchObject({ ok: false, code: "conflict", current: { rev: 2 } });
    expect(getFeature(db, id)!.currentVersion).toBe(0);
    expect(getTask(db, "T1")!.featureId).toBeNull();
  });

  test("节点校验：别的项目、没有的卡、重复、未知依赖、自环、成环、别的 feature 的卡、坏 JSON", async () => {
    await newFeature();
    await newFeature("f2");
    await run(PM, "dag-init", "f2", "--rev", "1", "--nodes", nodes([{ taskId: "T3" }]));
    const bad = async (xs: unknown, code = "invalid") =>
      expect(await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", typeof xs === "string" ? xs : nodes(xs))).toMatchObject({ ok: false, code });
    await bad([{ taskId: "X1" }]);
    await bad([{ taskId: "T9" }], "not_found");
    await bad([{ taskId: "T1" }, { taskId: "T1" }]);
    await bad([{ taskId: "T1", deps: ["T2"] }]);
    await bad([{ taskId: "T1", deps: ["T1"] }]);
    await bad([{ taskId: "T1", deps: ["T2"] }, { taskId: "T2", deps: ["T1"] }]);
    await bad([{ taskId: "T3" }], "conflict");
    await bad([{ taskId: "T1", oneLine: "两\n行" }]);
    await bad([]);
    await bad("{not json");
    expect(getFeature(db, "ab12-i28")!.currentVersion).toBe(0);
  });
});

describe("计划中的节点（还没建卡）", () => {
  test("taskId 可空：快照记 planned，只给有卡的节点挂 featureId；投影显示计划中，依赖满足后 ready", async () => {
    const id = await newFeature();
    const r = await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes([
      { taskId: "T1" }, { key: "L2", oneLine: "重写命令", deps: ["T1"] }, { key: "L3", taskId: null, oneLine: "迁移旧卡", deps: ["L2"], estimate: "1 天" },
    ]));
    expect(r.version.nodes.map((n: any) => [n.key, n.taskId, n.status])).toEqual([["T1", "T1", "spec"], ["L2", null, "planned"], ["L3", null, "planned"]]);
    expect(getTask(db, "T1")!.featureId).toBe(id);
    expect(listEvents(db, { target: id }).at(-1)!.data.nodes).toEqual(["T1", "L2", "L3"]);
    const view = async () => (await run(EXE, "feature-show", id)).nodes.map((n: any) => [n.key, n.status, n.ready, n.missing]);
    expect(await view()).toEqual([["T1", "spec", true, false], ["L2", "planned", false, false], ["L3", "planned", false, false]]);
    const pm = { actor: PM, now: 2_000 };
    ["restate", "build", "review", "merge", "live"].reduce((from, to) => (moveStage(db, pm, { taskId: "T1", from: from as never, to: to as never }), to), "spec");
    expect(await view()).toEqual([["T1", "live", false, false], ["L2", "planned", true, false], ["L3", "planned", false, false]]);
  });

  test("计划节点要有 key 与一句话；同一张卡不能进两个节点", async () => {
    await newFeature();
    const bad = async (xs: unknown) => expect(await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes(xs))).toMatchObject({ ok: false, code: "invalid" });
    await bad([{ oneLine: "没 key" }]);
    await bad([{ key: "L2" }]);
    await bad([{ key: "坏 key", oneLine: "x" }]);
    await bad([{ key: "a", taskId: "T1" }, { key: "b", taskId: "T1" }]);
    await bad([{ key: "a", taskId: 3, oneLine: "x" }]);
  });
});

describe("投影", () => {
  test("feature-show / dag-show 的节点状态跟任务卡现读一致；快照原值留在 statusAtVersion；满足口径同依赖边", async () => {
    const id = await newFeature();
    await run(PM, "dag-init", "i28", "--rev", "1", "--nodes", nodes([{ taskId: "T1" }, { taskId: "T2", deps: ["T1"] }, { taskId: "T3", deps: ["T2"] }]));
    const pm = { actor: PM, now: 2_000 };
    const walk = (task: string, stages: string[]) => stages.slice(1).forEach((to, i) => moveStage(db, pm, { taskId: task, from: stages[i] as never, to: to as never }));
    walk("T1", ["spec", "restate", "build", "review", "merge", "live"]);
    walk("T2", ["spec", "restate"]);
    const show = await run(EXE, "feature-show", id);
    for (const n of show.nodes) expect(n.status).toBe(getTask(db, n.taskId)!.stage);
    expect(show.nodes).toMatchObject([
      { key: "T1", status: "live", statusAtVersion: "spec", satisfied: true, ready: false, missing: false },
      { key: "T2", status: "restate", statusAtVersion: "spec", satisfied: false, ready: true },
      { key: "T3", status: "spec", satisfied: false, ready: false },
    ]);
    moveStage(db, pm, { taskId: "T1", from: "live", to: "fix" });
    const dag = await run(EXE, "dag-show", "i28", "--version", "1");
    expect(dag.version.nodes.map((n: any) => [n.status, n.ready])).toEqual([["fix", true], ["restate", false], ["spec", false]]);
    expect(await run(EXE, "dag-show", "i28", "--version", "2")).toMatchObject({ ok: false, code: "not_found" });
  });


  test("没建 DAG：feature-show 节点为空，dag-show 报 not_found", async () => {
    await newFeature();
    expect(await run(EXE, "feature-show", "i28")).toMatchObject({ ok: true, version: null, nodes: [] });
    expect(await run(EXE, "dag-show", "i28")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("事件来源", () => {
  test("新事件带 origin 与本机单调序号；ask 事件也带", async () => {
    await newFeature();
    openAsk(db, { project: P, fromAgent: PM, fromChannelId: "c", source: "reply", kind: "decide", title: "问",
      options: [{ type: "buttons", buttons: [{ id: "go", label: "好" }] }] }, 3_000);
    expect(listEvents(db).some((e) => e.kind === "ask" && e.origin === "ab12")).toBe(true);
    const evs = listEvents(db).filter((e) => e.origin);
    expect(evs.length).toBeGreaterThanOrEqual(2);
    expect(evs.every((e) => e.origin === "ab12")).toBe(true);
    expect(evs.map((e) => e.originSeq)).toEqual(evs.map((_, i) => (evs[0].originSeq as number) + i));
  });

  test("取不到前缀：返回 null 且不落库（事件照写不带 origin；建 feature 会拒绝）", () => {
    closeLedger(":memory:");
    db = openLedger(":memory:");
    expect(ledgerOrigin(db, () => "")).toBeNull();
    expect(storedOrigin(db)).toBeNull();
    expect(ledgerOrigin(db, () => "cd34")).toBe("cd34");
    expect(ledgerOrigin(db, () => "ffff")).toBe("cd34");
  });

  test("事务回滚后不留前缀：同一事务里读到的未提交值不算数", () => {
    closeLedger(":memory:");
    db = openLedger(":memory:");
    const rollback = db.transaction(() => {
      expect(ledgerOrigin(db, () => "abcd")).toBe("abcd");
      expect(ledgerOrigin(db, () => "abcd")).toBe("abcd");
      throw new Error("回滚");
    });
    expect(() => rollback.immediate()).toThrow("回滚");
    expect(storedOrigin(db)).toBeNull();
    expect(ledgerOrigin(db, () => "ffff")).toBe("ffff");
    expect(storedOrigin(db)).toBe("ffff");
  });
});
