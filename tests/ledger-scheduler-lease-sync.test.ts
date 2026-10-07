/** LCK-1: rewrite_dag on a bound card moves its extra.fileGlobs and held file locks with it; lanes read the locks actually held. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { computeLanes, featureLanes } from "../src/lib/dag-tools-lanes.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { syncedLocks } from "../src/lib/ledger-scheduler-lease-sync.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const WIDE = ["src/lib/acp/*", "src/bridge/acp-link.ts", "src/lib/acp-turn.ts"];
const feature = () => getFeature(db, "ab12-i28")!;
const nodes = () => { const f = feature(); return effectiveNodes(db, getDagVersion(db, f.id, f.currentVersion)!); };
const locks = (taskId: string) => (db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? AND scope = 'card' ORDER BY resource")
  .all(taskId) as { resource: string }[]).map((r) => r.resource);
const rewriteA = (fileGlobs: string[]) => {
  const f = feature();
  return rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: nodes().map((n) => (n.key === "A" ? { ...n, fileGlobs } : n)), reasonKind: "new_issue",
    reasonText: "实际只改两个文件", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
};
/** A dispatched card: one done write intent and its file locks, the way planIntent leaves them. */
function hold(taskId: string, resources: string[], status = "done"): void {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt, eventSeq) VALUES (?, ?, 'p', 'write', 'dispatch', 'w', 1, 1, 1, NULL, 3, ?, 'x', 50, 50, 1)`).run(`i-${taskId}`, taskId, status);
  for (const r of resources) db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, ?, ?, 50, 'card')")
    .run(r, taskId, `i-${taskId}`);
}

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "i28", title: "i28" });
  initDag(db, ctx, { id: "ab12-i28", rev: 1, nodes: [{ key: "A", oneLine: "A", deps: [], fileGlobs: WIDE },
    { key: "B", oneLine: "B", deps: [], fileGlobs: ["src/lib/acp/b.ts"] }] });
  createTask(db, ctx, { project: "p", id: "i28-A", title: "A", kind: "code", stage: "build", extra: { fileGlobs: WIDE } });
  bindNode(db, ctx, { id: "ab12-i28", rev: feature().rev, key: "A", taskId: "i28-A" });
  hold("i28-A", WIDE);
});
afterEach(() => closeLedger(":memory:"));

test("narrowing a bound node moves the card's fileGlobs and locks in the same write; the blocked node can start", () => {
  expect(featureLanes(db, feature())!.waiting).toEqual([{ key: "B", why: "files", on: ["A"] }]);
  rewriteA(["src/lib/acp/a.ts", "src/bridge/acp-link.ts"]);
  expect(getTask(db, "i28-A")!.extra.fileGlobs).toEqual(["src/bridge/acp-link.ts", "src/lib/acp/a.ts"]);
  expect(locks("i28-A")).toEqual(["src/bridge/acp-link.ts", "src/lib/acp/a.ts"]);
  const ev = listEvents(db, { project: "p", target: "i28-A" }).findLast((e) => e.kind === "task")!;
  expect(ev.data.fileScope).toMatchObject({ locks: { from: ["src/bridge/acp-link.ts", "src/lib/acp-turn.ts", "src/lib/acp/*"],
    to: ["src/bridge/acp-link.ts", "src/lib/acp/a.ts"] } });
  expect(featureLanes(db, feature())!.startNow).toEqual(["B"]);
});

test("widening onto another card's lock refuses the whole rewrite and names the holder; a free one is taken", () => {
  createTask(db, ctx, { project: "p", id: "X1", title: "x", kind: "code", stage: "build", extra: { fileGlobs: ["src/web/x.ts"] } });
  hold("X1", ["src/web/x.ts"]);
  const before = feature().rev;
  expect(() => rewriteA([...WIDE, "src/web/*"])).toThrow(/X1.*src\/web\/x\.ts/);
  expect(feature().rev).toBe(before);
  expect(getTask(db, "i28-A")!.extra.fileGlobs).toEqual(WIDE);
  expect(locks("i28-A")).toEqual([...WIDE].sort());
  rewriteA([...WIDE, "src/docs.ts"]);
  expect(locks("i28-A")).toEqual([...WIDE, "src/docs.ts"].sort());
});

test("a card holding no locks yet only gets its fileGlobs; its first dispatch acquires them", () => {
  db.query("DELETE FROM scheduler_resources").run();
  rewriteA(["src/lib/acp/a.ts"]);
  expect(getTask(db, "i28-A")!.extra.fileGlobs).toEqual(["src/lib/acp/a.ts"]);
  expect(locks("i28-A")).toEqual([]);
});

test("lanes count a live card still holding locks, and only the files it actually holds", () => {
  db.query("UPDATE tasks SET stage = 'live' WHERE id = 'i28-A'").run();
  expect(featureLanes(db, feature())!.waiting).toEqual([{ key: "B", why: "files", on: ["A"] }]);
  db.query("DELETE FROM scheduler_resources WHERE resource <> 'src/bridge/acp-link.ts'").run();
  expect(featureLanes(db, feature())!.startNow).toEqual(["B"]);
  createTask(db, ctx, { project: "p", id: "X2", title: "x", kind: "code", stage: "live", extra: { fileGlobs: ["src/lib/acp/b.ts"] } });
  hold("X2", ["src/lib/acp/b.ts"]);
  expect(featureLanes(db, feature())!.waiting).toEqual([{ key: "B", why: "files", on: ["X2"] }]);
});

test("syncedLocks: kept inside new globs, dropped give way to what they overlapped, a handoff-narrowed file stays narrow", () => {
  const h = (...rs: string[]) => rs.map((resource) => ({ resource, intentId: "i", acquiredAt: 1 }));
  expect(syncedLocks(h("src/a/*", "src/b.ts"), ["src/a/*", "src/b.ts"], ["src/a/x.ts"])).toEqual(["src/a/x.ts"]);
  expect(syncedLocks(h("src/a/1.ts"), ["src/a/*", "src/c/*"], ["src/a/*"])).toEqual(["src/a/1.ts"]);
  expect(syncedLocks(h("src/a/1.ts"), ["src/a/*"], ["src/a/*", "src/d.ts"])).toEqual(["src/a/1.ts", "src/d.ts"]);
  expect(syncedLocks([], ["src/a/*"], ["src/z.ts"])).toEqual([]);
});

test("复现 active-write-lock-release: an open write dispatch refuses a rewrite that would drop its locks; widening still works", () => {
  for (const status of ["pending", "submitted", "unknown"]) {
    db.query("UPDATE scheduler_intents SET status = ? WHERE id = 'i-i28-A'").run(status);
    const before = feature().rev;
    expect(() => rewriteA(["src/lib/acp/a.ts"])).toThrow(/在途.*锁仍然生效/);
    expect(feature().rev).toBe(before);
    expect(locks("i28-A")).toEqual([...WIDE].sort());
    expect(getTask(db, "i28-A")!.extra.fileGlobs).toEqual(WIDE);
  }
  rewriteA([...WIDE, "src/docs.ts"]);
  expect(locks("i28-A")).toEqual([...WIDE, "src/docs.ts"].sort());
});

test("复现 omitted-bound-globs: dropping a bound node's fileGlobs is refused, not silently ignored", () => {
  const f = feature(), before = f.rev;
  const next = nodes().map((n) => (n.key === "A" ? { key: n.key, taskId: n.taskId, oneLine: n.oneLine, deps: n.deps } : n));
  expect(() => rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: next, reasonKind: "new_issue", reasonText: "省略范围",
    cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } })).toThrow(/不能省略 fileGlobs/);
  expect(feature().rev).toBe(before);
});

test("复现 lane-group-stale-globs: lane groups use a bound card's held locks, like startNow", () => {
  const lanes = computeLanes([
    { key: "A", deps: [], fileGlobs: ["src/a/*"], taskId: "T-A", phase: "active", depsMet: true, satisfied: false, held: ["src/a/1.ts"] },
    { key: "B", deps: [], fileGlobs: ["src/a/2.ts"], taskId: null, phase: "idle", depsMet: true, satisfied: false },
  ]);
  expect(lanes.startNow).toEqual(["B"]);
  expect(lanes.lanes).toEqual([["A"], ["B"]]);
});
