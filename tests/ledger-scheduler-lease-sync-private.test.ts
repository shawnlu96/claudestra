/**
 * PRIVLOCK1: a private-repo card's locks (`repo:<owner>/<name>/<path>`) follow rewrite_dag like bare paths, and placement then
 * agrees with the lanes. Bare-path behaviour lives in tests/ledger-scheduler-lease-sync.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { convergencePlacement, type RemoteConvergenceContext } from "../src/lib/fix-strategy-remote-context.js";
import { effectiveNodes, getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { cardFileLocks, isFileResource } from "../src/lib/ledger-scheduler-lease-sync.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { narrowHandoffLocks } from "../src/lib/scheduler-merge-handoff.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const R = "repo:acme/cloud/";
const WIDE = [`${R}src/a.ts`, `${R}src/b.ts`, `${R}scripts/protocol-boundary.json`];
const NARROW = [`${R}src/a.ts`, `${R}src/b.ts`];
const DROPPED = `${R}scripts/protocol-boundary.json`;
const feature = () => getFeature(db, "ab12-cs")!;
const nodes = () => { const f = feature(); return effectiveNodes(db, getDagVersion(db, f.id, f.currentVersion)!); };
const locks = (taskId: string) => (db.query("SELECT resource FROM scheduler_resources WHERE taskId = ? AND scope = 'card' ORDER BY resource")
  .all(taskId) as { resource: string }[]).map((r) => r.resource);
const rewriteA = (fileGlobs: string[]) => {
  const f = feature();
  return rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: nodes().map((n) => (n.key === "A" ? { ...n, fileGlobs } : n)), reasonKind: "new_issue",
    reasonText: "去掉协议边界文件", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
};
function hold(taskId: string, resources: string[], status = "done"): void {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt, eventSeq) VALUES (?, ?, 'p', 'write', 'dispatch', 'w', 1, 1, 1, NULL, 3, ?, 'x', 50, 50, 1)`).run(`i-${taskId}`, taskId, status);
  for (const r of resources) db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, ?, ?, 50, 'card')")
    .run(r, taskId, `i-${taskId}`);
}
const context: RemoteConvergenceContext = { remote: null, borrow: [], source: null, spec: null, maxWorkers: 0,
  notify: async () => { throw new Error("placement must not notify"); }, remoteHead: async () => { throw new Error("no git here"); } };
/** The placement gate (fix-strategy-remote-context.ts locksFree) node B's card CS3 meets once opened; not in the ledger so lanes see only node B. */
const placementFree = () => convergencePlacement(db, { ...getTask(db, "TEAMVIS9")!, id: "CS3", extra: { fileGlobs: [DROPPED] } }, context, "claude",
  "write", 100).facts.locksFree;

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "cs", title: "cs" });
  initDag(db, ctx, { id: "ab12-cs", rev: 1, nodes: [{ key: "A", oneLine: "A", deps: [], fileGlobs: WIDE },
    { key: "B", oneLine: "B", deps: [], fileGlobs: [DROPPED] }] });
  createTask(db, ctx, { project: "p", id: "TEAMVIS9", title: "A", kind: "code", stage: "build", extra: { fileGlobs: WIDE } });
  bindNode(db, ctx, { id: "ab12-cs", rev: feature().rev, key: "A", taskId: "TEAMVIS9" });
  hold("TEAMVIS9", [...WIDE, "slot:p:agents:0", "task:s1"]);
});
afterEach(() => closeLedger(":memory:"));

test("isFileResource: well-formed repo: paths count as files; other namespaces and a malformed repo: head do not", () => {
  for (const r of [`${R}src/a.ts`, `${R}src/*`, "repo:acme/other/x.ts", "src/a.ts"]) expect(isFileResource(r)).toBe(true);
  for (const r of ["slot:p:agents:0", "task:s1", "merge:p", "repo:acme", "repo:acme/cloud", "repo:/cloud/x.ts", "REPO:acme/cloud/x.ts"]) {
    expect(isFileResource(r)).toBe(false);
  }
});

test("[验收线 1] 3 → 2 repo: locks on rewrite; the dropped one is free for lanes and placement alike", () => {
  expect(cardFileLocks(db, "TEAMVIS9").map((l) => l.resource)).toEqual([...WIDE].sort());
  expect(featureLanes(db, feature())!.waiting).toEqual([{ key: "B", why: "files", on: ["A"] }]);
  expect(placementFree()).toBe(false);
  rewriteA(NARROW);
  expect(getTask(db, "TEAMVIS9")!.extra.fileGlobs).toEqual(NARROW);
  expect(locks("TEAMVIS9")).toEqual([...NARROW, "slot:p:agents:0", "task:s1"].sort());
  expect(featureLanes(db, feature())!.startNow).toEqual(["B"]);
  expect(placementFree()).toBe(true);
});

test("[验收线 2] another repo and a bare path never overlap a repo: lock; slot: and task: stay untouched", () => {
  createTask(db, ctx, { project: "p", id: "X1", title: "x", kind: "code", stage: "build", extra: { fileGlobs: ["repo:acme/other/src/*"] } });
  hold("X1", ["repo:acme/other/src/*", "src/*"]);
  rewriteA([...WIDE, `${R}src/*`]);
  expect(locks("TEAMVIS9")).toEqual([...WIDE, `${R}src/*`, "slot:p:agents:0", "task:s1"].sort());
  expect(placementFree()).toBe(false);
  rewriteA([`${R}src/a.ts`]);
  expect(locks("TEAMVIS9")).toEqual([`${R}src/a.ts`, "slot:p:agents:0", "task:s1"]);
  expect(placementFree()).toBe(true);
});

test("[验收线 2] widening a private card onto another card's lock in the same repo is refused and names the holder", () => {
  createTask(db, ctx, { project: "p", id: "X2", title: "x", kind: "code", stage: "build", extra: { fileGlobs: [`${R}web/x.ts`] } });
  hold("X2", [`${R}web/x.ts`]);
  const before = feature().rev;
  expect(() => rewriteA([...WIDE, `${R}web/*`])).toThrow(/X2.*repo:acme\/cloud\/web\/x\.ts/);
  expect(feature().rev).toBe(before);
  expect(locks("TEAMVIS9")).toEqual([...WIDE, "slot:p:agents:0", "task:s1"].sort());
});

test("[验收线 3] an open write dispatch refuses narrowing a private card; its repo: locks stay", () => {
  for (const status of ["pending", "submitted", "unknown"]) {
    db.query("UPDATE scheduler_intents SET status = ? WHERE id = 'i-TEAMVIS9'").run(status);
    const before = feature().rev;
    expect(() => rewriteA(NARROW)).toThrow(/在途.*锁仍然生效/);
    expect(feature().rev).toBe(before);
    expect(locks("TEAMVIS9")).toEqual([...WIDE, "slot:p:agents:0", "task:s1"].sort());
    expect(getTask(db, "TEAMVIS9")!.extra.fileGlobs).toEqual(WIDE);
  }
});

/** PRIVLOCK2 supersedes PRIVLOCK1's "locks stay whole": PR paths get the card's repo: head when its locks all name the PR's repository. */
function handOff(pr: string, head = "c".repeat(40)) {
  db.query("UPDATE tasks SET stage = 'merge', headSHA = ?, pr = ? WHERE id = 'TEAMVIS9'").run(head, pr);
  insertEvent(db, { actor: "scheduler", now: 100 }, { project: "p", target: "TEAMVIS9", kind: "scheduler", text: "合并交给仓库方",
    data: { op: "merge_handoff", evidence: { v: 1, pr, head } } }, false);
  return narrowHandoffLocks(db, { actor: "scheduler", now: 110 }, { taskId: "TEAMVIS9", head, pr, files: ["src/a.ts"] });
}

test("the merge handoff narrows a private card to the PR's files under its repo: head when the repository matches", () => {
  expect(handOff("https://github.com/Acme/Cloud/pull/9")).toMatchObject({ narrowed: true, from: [...WIDE].sort(), to: [`${R}src/a.ts`] });
  expect(locks("TEAMVIS9")).toEqual([`${R}src/a.ts`, "slot:p:agents:0", "task:s1"]);
  expect(placementFree()).toBe(true);
});

test("the merge handoff leaves a private card's locks whole when they name another repository or mix in a bare path", () => {
  expect(handOff("https://github.com/acme/other/pull/9")).toMatchObject({ narrowed: false, reason: expect.stringContaining("repo:acme/cloud") });
  expect(locks("TEAMVIS9")).toEqual([...WIDE, "slot:p:agents:0", "task:s1"].sort());
  db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/x.ts', 'TEAMVIS9', 'i-TEAMVIS9', 50, 'card')").run();
  expect(handOff("https://github.com/acme/cloud/pull/9", "d".repeat(40))).toMatchObject({ narrowed: false, reason: expect.stringContaining("裸路径") });
  expect(locks("TEAMVIS9")).toEqual([...WIDE, "slot:p:agents:0", "src/x.ts", "task:s1"].sort());
});
