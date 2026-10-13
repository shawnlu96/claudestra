import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { productBoard } from "../src/lib/ledger-product-board.js";
import { LOCK_EVIDENCE_MAX, productEdges, SPLIT_NOTE, type ProductEdgesInput } from "../src/lib/ledger-product-board-edges.js";
import { HOUR, propagateEtas } from "../src/lib/ledger-product-board-eta.js";
import { closeLedger, listTasks, openLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { Stage } from "../src/lib/ledger-stages.js";
import { assertProductBoard } from "../web/lib/api/product-board-types.js";

const now = 100 * HOUR, ctx = { actor: "owner", now: 1 };

function withDb(run: (db: Database) => void): void {
  const db = openLedger(":memory:");
  try { run(db); } finally { closeLedger(":memory:"); }
}
const feature = (db: Database, slug: string) => createFeature(db, ctx, { project: "p", slug, title: slug }).row.id;
function card(db: Database, id: string, stage: Stage, featureId: string | null = null): void {
  createTask(db, ctx, { project: "p", id, title: id, kind: "code", stage });
  if (featureId) db.prepare("UPDATE tasks SET featureId=? WHERE id=?").run(featureId, id);
}
const featureDep = (db: Database, from: string, to: string, note: string) =>
  db.prepare("INSERT INTO feature_deps (project,fromFeature,toFeature,note,createdBy,createdAt) VALUES ('p',?,?,?,'owner',1)").run(from, to, note);
const taskDep = (db: Database, from: string, to: string) =>
  db.prepare("INSERT INTO task_deps (project,fromTask,toTask,kind,createdBy,createdAt,updatedAt) VALUES ('p',?,?,'blocks','owner',1,1)").run(from, to);
function hold(db: Database, taskId: string, resource: string, at = 5): void {
  db.prepare(`INSERT OR IGNORE INTO scheduler_intents (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,'p','build','dispatch',1,1,1,1,'submitted','t',1,1)`).run(`i-${taskId}`, taskId);
  db.prepare("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope) VALUES ('p',?,?,?,?,'card')").run(resource, taskId, `i-${taskId}`, at);
}
/** productBoard 同口径的输入；features 可覆写（complete 是 PDSTATE1 才加的字段） */
function input(db: Database, features?: ProductEdgesInput["features"]): ProductEdgesInput {
  const board = productBoard(db, "p", now), tasks = listTasks(db, "p"), own = new Map(tasks.map((t) => [t.id, t]));
  const fs = db.query("SELECT * FROM features WHERE project='p' ORDER BY id").all() as { id: string; status: string; currentVersion: number }[];
  const entries = fs.map((f) => {
    const v = db.query("SELECT nodes FROM dag_versions WHERE featureId=? AND version=?").get(f.id, f.currentVersion) as { nodes: string } | null;
    const binds = new Map((db.query("SELECT nodeKey, taskId FROM dag_bindings WHERE featureId=?").all(f.id) as { nodeKey: string; taskId: string }[]).map((b) => [b.nodeKey, b.taskId]));
    const nodes = (v ? JSON.parse(v.nodes) : []).map((n: { key: string; taskId: string | null }) => {
      const taskId = n.taskId ?? binds.get(n.key) ?? null;
      return { ...n, taskId, task: taskId ? own.get(taskId) ?? null : null };
    });
    return { f, nodes };
  });
  return { project: "p", deps: board.deps.map(({ from, to, note }) => ({ from, to, note })), features: features ?? board.features, tasks, entries };
}

test("[验收线 1] split / declared by note, complete counts as satisfied, task edges aggregate across features only", () => withDb((db) => {
  const a = feature(db, "a"), b = feature(db, "b"), c = feature(db, "c");
  featureDep(db, a, b, SPLIT_NOTE); featureDep(db, b, c, "CL1 等共享台账在做的卡合完");
  card(db, "a1", "live", a); card(db, "a2", "build", a); card(db, "a3", "spec", a);
  card(db, "b1", "spec", b); card(db, "b2", "spec", b);
  taskDep(db, "a1", "b1"); taskDep(db, "a2", "b2"); taskDep(db, "a1", "a3");
  const board = productBoard(db, "p", now);
  expect(board.deps.map((d) => [d.from, d.to, d.kind, d.satisfied, d.count, d.evidence])).toEqual([
    [a, b, "split", false, 1, []], [b, c, "declared", false, 1, []]]);
  expect(board.links).toEqual([{ from: a, to: b, note: "", kind: "task", satisfied: false, count: 2, evidence: [
    { from: "a1", to: "b1", fromStage: "live", toStage: "spec", satisfied: true },
    { from: "a2", to: "b2", fromStage: "build", toStage: "spec", satisfied: false }] }]);
  const complete = input(db, [{ id: a, status: "active", complete: true }, { id: b, status: "done" }, { id: c, status: "active" }]);
  expect(productEdges(db, complete).deps.map((d) => d.satisfied)).toEqual([true, true]);
  db.prepare("UPDATE tasks SET stage='verified' WHERE id='b2'").run();
  expect(productBoard(db, "p", now).links[0]).toMatchObject({ satisfied: true, count: 2 });
}));

function lockFixture(db: Database): { a: string; b: string } {
  const a = feature(db, "a"), b = feature(db, "b");
  card(db, "ha", "build", a); card(db, "bs", "spec"); card(db, "bb", "build");
  initDag(db, ctx, { id: b, rev: 1, nodes: [
    { key: "todo", oneLine: "todo", fileGlobs: ["src/lib/foo-bar.ts"] },
    { key: "spec", oneLine: "spec", taskId: "bs", fileGlobs: ["repo:org/x/y.ts"] },
    { key: "busy", oneLine: "busy", taskId: "bb", fileGlobs: ["src/lib/foo-baz.ts"] },
    { key: "later", oneLine: "（远期）later", fileGlobs: ["src/lib/foo-later.ts"] },
  ] });
  initDag(db, ctx, { id: a, rev: 1, nodes: [{ key: "own", oneLine: "own", fileGlobs: ["src/lib/foo-own.ts"] }] });
  for (const r of ["src/lib/foo*.ts", "merge:p", "repo:org/x/**"]) hold(db, "ha", r);
  return { a, b };
}

test("[验收线 2] lock edge counts not-started nodes, skips merge slots, started nodes, self edges", () => withDb((db) => {
  const { a, b } = lockFixture(db);
  const links = productBoard(db, "p", now).links;
  expect(links).toEqual([{ from: a, to: b, note: "", kind: "lock", satisfied: false, count: 2, evidence: [
    { node: "spec", wanted: "repo:org/x/y.ts", held: "repo:org/x/**", holder: "ha", since: 5 },
    { node: "todo", wanted: "src/lib/foo-bar.ts", held: "src/lib/foo*.ts", holder: "ha", since: 5 }] }]);
  expect(JSON.stringify(links)).not.toContain("merge:");
  expect(JSON.stringify(links)).not.toContain("busy");
  db.prepare("DELETE FROM scheduler_resources").run();
  expect(productBoard(db, "p", now).links).toEqual([]);
}));

test("lock holder falls back to node binding; done feature and missing table give no edge", () => withDb((db) => {
  const { a, b } = lockFixture(db);
  db.prepare("UPDATE tasks SET featureId=NULL WHERE id='ha'").run();
  expect(productBoard(db, "p", now).links).toEqual([]);
  db.prepare("INSERT INTO dag_bindings (featureId,version,nodeKey,taskId,boundBy,boundAt) VALUES (?,1,'own','ha','owner',1)").run(a);
  expect(productBoard(db, "p", now).links.map((l) => [l.from, l.to, l.count])).toEqual([[a, b, 2]]);
  db.prepare("UPDATE features SET status='done' WHERE id=?").run(b);
  expect(productBoard(db, "p", now).links).toEqual([]);
  db.prepare("DROP TABLE scheduler_resources").run();
  expect(productBoard(db, "p", now).links).toEqual([]);
}));

test("[验收线 3] card-dependency cycle stays in links, ETA and deps ignore it, board still validates", () => withDb((db) => {
  const i28 = feature(db, "i28"), sched = feature(db, "sched"), up = feature(db, "up");
  featureDep(db, up, i28, SPLIT_NOTE);
  card(db, "T68f", "done", i28); card(db, "T68h", "build", sched); card(db, "T82", "spec", i28);
  for (const [f, k] of [[i28, "T82"], [sched, "T68h"]] as const) initDag(db, ctx, { id: f, rev: 1, nodes: [{ key: "n", oneLine: "n", taskId: k, estimate: "S" }] });
  const before = productBoard(db, "p", now);
  taskDep(db, "T68f", "T68h"); taskDep(db, "T68h", "T82");
  const after = productBoard(db, "p", now);
  expect(after.links.map((l) => [l.from, l.to, l.kind])).toEqual([[i28, sched, "task"], [sched, i28, "task"]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  expect(after.features.map((f) => f.eta)).toEqual(before.features.map((f) => f.eta));
  const plain = db.query("SELECT fromFeature AS 'from', toFeature AS 'to', note FROM feature_deps ORDER BY fromFeature,toFeature").all();
  expect(after.deps.map(({ from, to, note }) => ({ from, to, note }))).toEqual(plain as never);
  expect(() => propagateEtas(after.features, after.deps)).not.toThrow();
  expect(() => assertProductBoard({ ok: true, exists: true, now, ...after })).not.toThrow();
}));

test("[验收线 4] evidence capped at 20 with real count; same input gives identical output", () => withDb((db) => {
  const a = feature(db, "a"), b = feature(db, "b");
  card(db, "ha", "build", a);
  initDag(db, ctx, { id: b, rev: 1, nodes: Array.from({ length: 25 }, (_, i) => ({ key: `n${String(i).padStart(2, "0")}`, oneLine: "x", fileGlobs: [`src/z/f${i}.ts`] })) });
  hold(db, "ha", "src/z/*");
  const once = productBoard(db, "p", now);
  expect(once.links[0]).toMatchObject({ kind: "lock", count: 25 });
  expect(once.links[0].evidence).toHaveLength(LOCK_EVIDENCE_MAX);
  expect((once.links[0].evidence[0] as { node: string }).node).toBe("n00");
  expect(JSON.stringify(productBoard(db, "p", now))).toBe(JSON.stringify(once));
}));
