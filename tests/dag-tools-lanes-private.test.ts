/** PRIVLOCK1: lanes read a private-repo card's held `repo:` locks, and judge overlap per repository like placement does. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { featureLanes, heldFileLocks } from "../src/lib/dag-tools-lanes.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const feature = () => getFeature(db, "ab12-pv")!;
function hold(taskId: string, resources: string[]): void {
  db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion,
    status, reason, createdAt, updatedAt, eventSeq) VALUES (?, ?, 'p', 'write', 'dispatch', 'w', 1, 1, 1, NULL, 3, 'done', 'x', 50, 50, 1)`).run(`i-${taskId}`, taskId);
  for (const r of resources) db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, ?, ?, 50, 'card')")
    .run(r, taskId, `i-${taskId}`);
}

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "pv", title: "pv" });
  initDag(db, ctx, { id: "ab12-pv", rev: 1, nodes: [
    { key: "A", oneLine: "A", deps: [], fileGlobs: ["repo:acme/cloud/src/*"] },
    { key: "SAME", oneLine: "same repo", deps: [], fileGlobs: ["repo:acme/cloud/src/x.ts"] },
    { key: "OTHER", oneLine: "other repo", deps: [], fileGlobs: ["repo:acme/other/src/x.ts"] },
    { key: "BARE", oneLine: "public repo", deps: [], fileGlobs: ["src/x.ts"] },
  ] });
  createTask(db, ctx, { project: "p", id: "PA", title: "A", kind: "code", stage: "build", extra: { fileGlobs: ["repo:acme/cloud/src/*"] } });
  bindNode(db, ctx, { id: "ab12-pv", rev: feature().rev, key: "A", taskId: "PA" });
});
afterEach(() => closeLedger(":memory:"));

test("heldFileLocks lists repo: locks next to bare ones and leaves slot: / task: out", () => {
  hold("PA", ["repo:acme/cloud/src/x.ts", "src/y.ts", "slot:p:agents:0", "task:s1"]);
  expect(heldFileLocks(db, "p").get("PA")).toEqual(["repo:acme/cloud/src/x.ts", "src/y.ts"]);
});

test("a held repo: lock blocks only the node naming that file in the same repo", () => {
  hold("PA", ["repo:acme/cloud/src/x.ts"]);
  const lanes = featureLanes(db, feature())!;
  expect(lanes.waiting).toEqual([{ key: "SAME", why: "files", on: ["A"] }]);
  expect(lanes.startNow.sort()).toEqual(["BARE", "OTHER"]);
});

test("lanes follow the locks actually held, not the wider declared glob", () => {
  hold("PA", ["repo:acme/cloud/src/y.ts"]);
  expect(featureLanes(db, feature())!.startNow.sort()).toEqual(["BARE", "OTHER", "SAME"]);
});
