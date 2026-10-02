import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cardNames } from "../src/lib/ledger-card-names.js";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { getDagVersion, getFeature, type DagNode } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const node = (key: string) => ({ key, oneLine: key, deps: [], fileGlobs: [`src/${key}.ts`] });
const feature = (slug: string) => getFeature(db, `ab12-${slug}`)!;
const current = (slug: string) => { const f = feature(slug); return getDagVersion(db, f.id, f.currentVersion)!.nodes; };
const split = (from: string, to: string, nodes: string[]) => applyFeatureSplit(db, ctx, `ab12-${from}`, {
  targets: [{ slug: to, title: to, nodes }], deps: [],
});
const rewrite = (slug: string, nodes: unknown) => {
  const f = feature(slug);
  return rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes, reasonKind: "new_issue",
    reasonText: "Rewrite nodes for prefix pinning", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
};
/** SL1 之前写下的存量版本：节点没固化 cardSlug（公开输入会忽略 cardSlug，只能直接写库） */
const seedLegacy = (slug: string, nodes: Partial<DagNode>[]) => {
  const f = feature(slug), base = { taskId: null, deps: [], status: "planned", estimate: "", inheritedFrom: null };
  db.query(`INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes)
    VALUES (?, ?, 'new_issue', 'owner', 100, ?)`).run(f.id, f.currentVersion + 1, JSON.stringify(nodes.map((n) => ({ ...base, oneLine: n.key, ...n }))));
  db.query("UPDATE features SET currentVersion = currentVersion + 1, rev = rev + 1 WHERE id = ?").run(f.id);
};
const taskIdOf = (slug: string, key: string) => cardNames(db, feature(slug), key).taskId;

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "i28", title: "i28" });
  initDag(db, ctx, { id: "ab12-i28", rev: 1, nodes: [node("C5"), node("C6")] });
  split("i28", "shared-ledger", ["C5", "C6"]);
});
afterEach(() => closeLedger(":memory:"));

test("legacy unopened node kept in the source feature by a split stays i28-<key>", () => {
  seedLegacy("shared-ledger", [{ key: "C5", cardSlug: "i28" }, { key: "C6", cardSlug: "i28" }, { key: "NEW" }]);
  expect(taskIdOf("shared-ledger", "NEW")).toBe("i28-NEW");
  split("shared-ledger", "third", ["C5", "C6"]);
  // SL1 只给搬走的节点写 cardSlug：留下的 NEW 没有带前缀的兄弟了，会漂成 shared-ledger-NEW
  expect(current("shared-ledger")).toEqual([expect.objectContaining({ key: "NEW", cardSlug: "i28", taskId: null })]);
  expect(taskIdOf("shared-ledger", "NEW")).toBe("i28-NEW");
  expect(taskIdOf("third", "C5")).toBe("i28-C5");
});

test("legacy unopened node stays i28-<key> after a rewrite removes the last prefixed node", () => {
  seedLegacy("shared-ledger", [{ key: "C5", cardSlug: "i28" }, { key: "NEW" }]);
  rewrite("shared-ledger", [node("NEW")]);
  expect(current("shared-ledger")).toEqual([expect.objectContaining({ key: "NEW", cardSlug: "i28" })]);
  expect(taskIdOf("shared-ledger", "NEW")).toBe("i28-NEW");
  rewrite("shared-ledger", [node("NEW"), node("NEXT")]);
  expect(taskIdOf("shared-ledger", "NEW")).toBe("i28-NEW");
  expect(taskIdOf("shared-ledger", "NEXT")).toBe("i28-NEXT");
});

test("a node added by rewrite is pinned and survives removing every other prefixed node", () => {
  rewrite("shared-ledger", [node("C5"), node("C6"), node("NEW")]);
  expect(current("shared-ledger").find((n) => n.key === "NEW")!.cardSlug).toBe("i28");
  rewrite("shared-ledger", [node("NEW")]);
  expect(taskIdOf("shared-ledger", "NEW")).toBe("i28-NEW");
});

test("an existing target's unmarked nodes are pinned before prefixed nodes move in", () => {
  createFeature(db, ctx, { project: "p", slug: "other", title: "other" });
  initDag(db, ctx, { id: "ab12-other", rev: 1, nodes: [node("O1")] });
  expect(taskIdOf("other", "O1")).toBe("other-O1");
  applyFeatureSplit(db, ctx, "ab12-shared-ledger", { targets: [{ id: "other", title: "other", nodes: ["C5"] }], deps: [] });
  expect(current("other")).toEqual([expect.objectContaining({ key: "O1", cardSlug: "other" }), expect.objectContaining({ key: "C5", cardSlug: "i28" })]);
  expect(taskIdOf("other", "O1")).toBe("other-O1");
  expect(taskIdOf("other", "C5")).toBe("i28-C5");
});

test("opened nodes keep their card numbers through rewrite and split (regression)", async () => {
  for (const id of ["i28-C5", "Custom.ID"]) createTask(db, ctx, { project: "p", id, title: id, kind: "code" });
  bindNode(db, ctx, { id: "ab12-shared-ledger", rev: feature("shared-ledger").rev, key: "C5", taskId: "i28-C5" });
  bindNode(db, ctx, { id: "ab12-shared-ledger", rev: feature("shared-ledger").rev, key: "C6", taskId: "Custom.ID" });
  rewrite("shared-ledger", [{ ...node("C5"), taskId: "i28-C5" }, { ...node("C6"), taskId: "Custom.ID" }, node("NEW")]);
  split("shared-ledger", "third", ["C5"]);
  expect(current("third")).toEqual([expect.objectContaining({ key: "C5", taskId: "i28-C5", cardSlug: "i28" })]);
  expect(current("shared-ledger")).toEqual([
    expect.objectContaining({ key: "C6", taskId: "Custom.ID" }), expect.objectContaining({ key: "NEW", taskId: null, cardSlug: "i28" }),
  ]);
  expect(getTask(db, "i28-C5")).toMatchObject({ featureId: "ab12-third" });
  expect(getTask(db, "Custom.ID")).toMatchObject({ featureId: "ab12-shared-ledger" });
  const env: StartEnv = { db, caller: "pm", ledgerDir: "/fake/ledger", worktreeRoot: "/fake/worktrees",
    projectDirs: async () => ["/fake/repo"], agentNames: () => [], exists: () => true,
    branchExists: async () => false, autoReady: () => null, template: () => null };
  expect(await preflightStart(env, { featureId: "ab12-third", key: "C5" })).toEqual({ ok: true, already: { taskId: "i28-C5", key: "C5" } });
  expect(await preflightStart(env, { featureId: "ab12-shared-ledger", key: "C6" })).toEqual({ ok: true, already: { taskId: "Custom.ID", key: "C6" } });
});
