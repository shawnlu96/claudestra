import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cardNames } from "../src/lib/ledger-card-names.js";
import { cardNames as legacyCardNames } from "../src/lib/scheduler-autostart.js";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { rewriteDag } from "../src/lib/ledger-dag-write.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { workBoard } from "../src/lib/ledger-work-board.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const node = (key: string) => ({ key, oneLine: key, deps: [], fileGlobs: [`src/${key}.ts`] });
const feature = (slug: string) => getFeature(db, `ab12-${slug}`)!;
const split = (from: string, to: string) => applyFeatureSplit(db, ctx, `ab12-${from}`, {
  targets: [{ slug: to, title: to, nodes: ["C5"] }], deps: [],
});
const env = (): StartEnv => ({
  db, caller: "pm", ledgerDir: "/fake/ledger", worktreeRoot: "/fake/worktrees",
  projectDirs: async () => ["/fake/repo"], agentNames: () => [],
  exists: (path) => path === "/fake/repo/.git" || path === "/fake/ledger/docs/tasks/i28-C5.md",
  branchExists: async () => false, autoReady: () => null, template: () => null,
});
beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "i28", title: "i28" });
  initDag(db, ctx, { id: "ab12-i28", rev: 1, nodes: [node("C5"), node("C6")] });
});
afterEach(() => closeLedger(":memory:"));

async function assertConsumers(slug: string) {
  const names = cardNames(db, feature(slug), "C5");
  expect(names).toEqual({ slug: "i28", taskId: "i28-C5", agent: "agent-task-i28-c5", branch: "feat/i28-c5" });
  expect(legacyCardNames).toBe(cardNames);
  const result = await preflightStart(env(), { featureId: feature(slug).id, key: "C5" });
  expect(result).toMatchObject({ ok: true, plan: {
    taskId: names.taskId, agent: names.agent, branch: names.branch, specPath: "/fake/ledger/docs/tasks/i28-C5.md",
  } });
  const read: string[] = [];
  const board = workBoard(db, "p", 1000, { registry: [], manualRegistry: [], maxWorkers: 2, specReady: (id) => {
    read.push(id); return id === "i28-C5";
  } });
  expect(read).toContain("i28-C5");
  expect(read).not.toContain(`${slug}-C5`);
  expect(board.todo.ready).toContainEqual(expect.objectContaining({ featureId: feature(slug).id, nodeKey: "C5", reason: null }));
}

test("unopened C5 keeps original card across autostart, start_node and board after split", async () => {
  split("i28", "shared-ledger");
  expect(getDagVersion(db, feature("shared-ledger").id, 1)!.nodes[0]).toMatchObject({ cardSlug: "i28", taskId: null });
  expect(getDagVersion(db, feature("i28").id, 2)!.nodes[0].cardSlug).toBeUndefined();
  await assertConsumers("shared-ledger");
});

test("A to B to C preserves the earliest cardSlug in persisted snapshots and consumers", async () => {
  split("i28", "shared-ledger");
  split("shared-ledger", "third");
  expect(getDagVersion(db, feature("third").id, 1)!.nodes[0].cardSlug).toBe("i28");
  await assertConsumers("third");
});

test("a node added after splitting uses the destination slug", async () => {
  split("i28", "shared-ledger");
  const f = feature("shared-ledger");
  const old = getDagVersion(db, f.id, f.currentVersion)!.nodes;
  rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [...old, node("NEW")], reasonKind: "new_issue",
    reasonText: "Add a new node after split", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  const updated = feature("shared-ledger");
  expect(getDagVersion(db, updated.id, updated.currentVersion)!.nodes.find(n => n.key === "NEW")!.cardSlug).toBeUndefined();
  expect(cardNames(db, updated, "NEW")).toEqual({ slug: "shared-ledger", taskId: "shared-ledger-NEW",
    agent: "agent-task-shared-ledger-new", branch: "feat/shared-ledger-new" });
  const result = await preflightStart(env(), { featureId: updated.id, key: "NEW", spec: "new specification" });
  expect(result).toMatchObject({ ok: true, plan: { taskId: "shared-ledger-NEW" } });
});

test("unsplit names are byte-for-byte compatible and explicit start overrides remain authoritative", async () => {
  expect(cardNames(db, feature("i28"), "C5")).toEqual({ slug: "i28", taskId: "i28-C5",
    agent: "agent-task-i28-c5", branch: "feat/i28-c5" });
  const unusual = { ...feature("i28"), id: "foreign.Feature", currentVersion: 0 };
  expect(cardNames(db, unusual, "Long.Key")).toEqual({ slug: "foreign.Feature", taskId: "foreign.Feature-Long.Key",
    agent: "agent-task-foreign-feature-long-key", branch: "feat/foreign.feature-long.key" });
  const result = await preflightStart(env(), { featureId: "ab12-i28", key: "C5", taskId: "Custom.ID", branch: "custom/branch", spec: "spec" });
  expect(result).toMatchObject({ ok: true, plan: { taskId: "Custom.ID", agent: "agent-task-custom-id", branch: "custom/branch" } });
});
