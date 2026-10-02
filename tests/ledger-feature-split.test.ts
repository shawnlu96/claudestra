import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeLedger, openLedger, getTask } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getDagVersion } from "../src/lib/ledger-feature.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { parseSplitMap, planFeatureSplit, type SplitMap } from "../src/lib/ledger-feature-split-plan.js";
import { setAutostartSwitch } from "../src/lib/ledger-autostart.js";
import { readSwitch } from "../src/lib/scheduler-autostart.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const source = "ab12-src";
const node = (key: string, deps: string[] = []) => ({ key, oneLine: key, deps });
const map = (): SplitMap => ({ targets: [
  { slug: "one", title: "One", nodes: ["A"] }, { slug: "two", title: "Two", nodes: ["B"] },
  { id: "ab12-existing", title: "Existing", nodes: ["C"] },
], deps: [] });
const snapshot = () => JSON.stringify(db.serialize());

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  for (const slug of ["src", "existing"]) createFeature(db, ctx, { project: "p", slug, title: slug });
  initDag(db, ctx, { id: source, rev: 1, nodes: [node("A"), node("B"), node("C"), node("D")] });
  createTask(db, ctx, { project: "p", id: "i28-A", title: "Task", kind: "code", stage: "build" });
  bindNode(db, ctx, { id: source, rev: 2, key: "A", taskId: "i28-A" });
});
afterEach(() => closeLedger(":memory:"));

test("two new targets and existing target preserve immutable snapshot, bindings, cards and events", () => {
  const old = getDagVersion(db, source, 1);
  setAutostartSwitch(db, ctx, { project: "p", featureId: source, on: false, reason: "test" });
  const task = getTask(db, "i28-A")!;
  const result = applyFeatureSplit(db, { ...ctx, dedupKey: "split" }, source, map());
  expect(result.duplicate).toBe(false);
  expect(getDagVersion(db, source, 1)).toEqual(old);
  expect(getDagVersion(db, source, 2)!.nodes.map((n) => n.key)).toEqual(["D"]);
  expect(getDagVersion(db, "ab12-one", 1)!.nodes[0]).toMatchObject({ taskId: task.id, movedFrom: { featureId: source, version: 1 } });
  expect(getTask(db, task.id)).toMatchObject({ ...task, featureId: "ab12-one", rev: task.rev + 1 });
  expect(getDagVersion(db, "ab12-existing", 1)!.nodes[0].key).toBe("C");
  expect(readSwitch(db, "p").features?.["ab12-one"].off).toBe(true);
  const events = db.query("SELECT origin, data FROM events WHERE json_extract(data,'$.op') LIKE 'feature-split%' OR json_extract(data,'$.splitSource') IS NOT NULL").all();
  expect(events).toHaveLength(6);
  expect(events.every((e) => (e as { origin: string }).origin === "ab12")).toBe(true);
});

test("dedup replay writes nothing and mismatched map is rejected", () => {
  applyFeatureSplit(db, { ...ctx, dedupKey: "split" }, source, map());
  const before = snapshot();
  expect(applyFeatureSplit(db, { ...ctx, dedupKey: "split" }, source, map()).duplicate).toBe(true);
  expect(snapshot()).toBe(before);
  expect(() => applyFeatureSplit(db, { ...ctx, dedupKey: "split" }, source, { ...map(), deps: [{ from: "one", to: "two" }] })).toThrow();
});

test("planning and map parsing are read only", () => {
  const before = snapshot();
  expect(planFeatureSplit(db, source, parseSplitMap(map())).rejected).toEqual([]);
  expect(snapshot()).toBe(before);
});

for (const [label, setup] of [
  ["duplicate node", (m: SplitMap) => m.targets[1].nodes.push("A")],
  ["target collision", () => initDag(db, ctx, { id: "ab12-existing", rev: 1, nodes: [node("C")] })],
  ["unfinished cross dependency", () => {}],
] as const) {
  test(`reject ${label} without writes`, () => {
    const m = map(); setup(m);
    if (label === "unfinished cross dependency") {
      // A fresh source version supplies a cross-group prerequisite without mutating the protected old version.
      db.exec(`INSERT INTO dag_versions SELECT featureId,2,'requirement_change',reasonText,proposedBy,approvedBy,createdAt,
        '[{"key":"A","taskId":"i28-A","oneLine":"A","deps":[],"status":"build","estimate":"","inheritedFrom":null},
        {"key":"B","taskId":null,"oneLine":"B","deps":["A"],"status":"planned","estimate":"","inheritedFrom":null},
        {"key":"C","taskId":null,"oneLine":"C","deps":[],"status":"planned","estimate":"","inheritedFrom":null}]',
        cancels,scopeChange,askId FROM dag_versions WHERE featureId='ab12-src' AND version=1`);
      db.exec("UPDATE features SET currentVersion=2 WHERE id='ab12-src'");
    }
    const before = snapshot();
    expect(planFeatureSplit(db, source, m).rejected.length).toBeGreaterThan(0);
    expect(() => applyFeatureSplit(db, ctx, source, m)).toThrow();
    expect(snapshot()).toBe(before);
  });
}

test("backup failure and unauthorized caller cause no writes", () => {
  const before = snapshot();
  expect(() => applyFeatureSplit(db, ctx, source, map(), () => { throw new Error("backup failed"); })).toThrow("backup failed");
  expect(() => applyFeatureSplit(db, { actor: "worker" }, source, map())).toThrow();
  expect(snapshot()).toBe(before);
});

test("pending source proposal refuses the entire split", () => {
  db.prepare(`INSERT INTO dag_proposals
    (featureId,version,baseVersion,reasonKind,reasonText,proposedBy,nodes,cancels,scopeChange,sha,askId,createdAt,state)
    VALUES (?,2,1,'requirement_change','pending','owner','[]','[]',1,'sha','ask',100,'pending')`).run(source);
  const before = snapshot();
  expect(planFeatureSplit(db, source, map()).rejected).toContain("源 feature 有待批重写提案");
  expect(() => applyFeatureSplit(db, ctx, source, map())).toThrow();
  expect(snapshot()).toBe(before);
});

test("unsettled autostart claim refuses migration, settled claim allows it", () => {
  db.prepare(`INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey)
    VALUES (100,'scheduler','p',?,'feature','',?,?)`).run(source,
      JSON.stringify({ op: "autostart_claim", key: "A", taskId: "i28-A" }), `autostart:${source}:A:arm`);
  const before = snapshot();
  expect(planFeatureSplit(db, source, map()).rejected.some((r) => r.includes("未结 claim"))).toBe(true);
  expect(() => applyFeatureSplit(db, ctx, source, map())).toThrow();
  expect(snapshot()).toBe(before);
  const row = db.query("SELECT seq FROM events WHERE dedupKey=?").get(`autostart:${source}:A:arm`) as { seq: number };
  db.prepare(`INSERT INTO events (ts,actor,project,target,kind,text,data,dedupKey)
    VALUES (100,'scheduler','p',?,'feature','','{}',?)`).run(source, `autostart-settle:${row.seq}`);
  expect(planFeatureSplit(db, source, map()).rejected).toEqual([]);
});

test("completed cross-group dependencies are recorded and existing DAG is appended", () => {
  db.exec("UPDATE tasks SET stage='verified' WHERE id='i28-A'");
  db.prepare(`INSERT INTO dag_versions (featureId,version,reasonKind,reasonText,proposedBy,approvedBy,createdAt,nodes)
    VALUES (?,2,'requirement_change','test','owner','owner',100,?)`).run(source, JSON.stringify([
      { ...node("A"), taskId: "i28-A", status: "build", estimate: "", inheritedFrom: null },
      { ...node("B", ["A"]), taskId: null, status: "planned", estimate: "", inheritedFrom: null },
      { ...node("C"), taskId: null, status: "planned", estimate: "", inheritedFrom: null },
    ]));
  db.exec("UPDATE features SET currentVersion=2 WHERE id='ab12-src'");
  initDag(db, ctx, { id: "ab12-existing", rev: 1, nodes: [node("X")] });
  const old = getDagVersion(db, "ab12-existing", 1);
  applyFeatureSplit(db, ctx, source, map());
  expect(getDagVersion(db, "ab12-two", 1)!.nodes[0]).toMatchObject({ deps: [], droppedDeps: ["A"] });
  expect(getDagVersion(db, "ab12-existing", 1)).toEqual(old);
  expect(getDagVersion(db, "ab12-existing", 2)!.nodes.map((n) => n.key)).toEqual(["X", "C"]);
});

test("late write failure rolls back all features, versions, task assignments and events", () => {
  db.exec("CREATE TRIGGER fail_split BEFORE INSERT ON feature_deps BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  const before = snapshot();
  expect(() => applyFeatureSplit(db, ctx, source, map())).toThrow("injected failure");
  expect(snapshot()).toBe(before);
});
