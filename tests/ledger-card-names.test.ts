import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { answerAsk } from "../src/lib/ledger-asks.js";
import { cardNames } from "../src/lib/ledger-card-names.js";
import { cardNames as legacyCardNames, currentViews, nodeCandidate } from "../src/lib/scheduler-autostart.js";
import { specPathIn } from "../src/lib/scheduler-autostart-deps.js";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { claimNode } from "../src/lib/ledger-autostart.js";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { approveDag, bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { workBoard } from "../src/lib/ledger-work-board.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const node = (key: string) => ({ key, oneLine: key, deps: [], fileGlobs: [`src/${key}.ts`] });
const feature = (slug: string) => getFeature(db, `ab12-${slug}`)!;
const split = (from: string, to: string) => applyFeatureSplit(db, ctx, `ab12-${from}`, {
  targets: [{ slug: to, title: to, nodes: ["C5"] }], deps: [],
});
const rewrite = (slug: string, nodes: unknown) => {
  const f = feature(slug);
  return rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes, reasonKind: "new_issue",
    reasonText: "Update nodes for card identity regression", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
};
const env = (taskId = "i28-C5"): StartEnv => ({
  db, caller: "pm", ledgerDir: "/fake/ledger", worktreeRoot: "/fake/worktrees",
  projectDirs: async () => ["/fake/repo"], agentNames: () => [],
  exists: (path) => path === "/fake/repo/.git" || path === `/fake/ledger/docs/tasks/${taskId}.md`,
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

async function assertConsumers(slug: string, key = "C5", cardSlug = "i28") {
  const f = feature(slug), taskId = `${cardSlug}-${key}`, low = taskId.toLowerCase();
  const names = cardNames(db, f, key);
  expect(names).toEqual({ slug: cardSlug, taskId, agent: `agent-task-${low}`, branch: `feat/${low}` });
  expect(legacyCardNames).toBe(cardNames);
  const result = await preflightStart(env(taskId), { featureId: f.id, key });
  expect(result).toMatchObject({ ok: true, plan: {
    taskId, agent: names.agent, branch: names.branch, specPath: `/fake/ledger/docs/tasks/${taskId}.md`,
  } });
  const paths: string[] = [];
  const candidate = nodeCandidate(db, f, key, featureLanes(db, f), currentViews(db, f), (id) => {
    const path = specPathIn("/fake/ledger", id);
    paths.push(path);
    return path === `/fake/ledger/docs/tasks/${taskId}.md` ? { text: `# ${taskId}\n模板:code\n`, mtimeMs: 0 } : null;
  }, 100_000);
  expect(candidate).toMatchObject({ taskId, key });
  expect(paths).toEqual([`/fake/ledger/docs/tasks/${taskId}.md`]);
  const read: string[] = [];
  const board = workBoard(db, "p", 1000, { registry: [], manualRegistry: [], maxWorkers: 2, specReady: (id) => {
    read.push(id); return id === taskId;
  } });
  expect(read).toContain(taskId);
  if (slug !== cardSlug) expect(read).not.toContain(`${slug}-${key}`);
  expect(board.todo.ready).toContainEqual(expect.objectContaining({ featureId: f.id, nodeKey: key, reason: null }));
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

test("a node added after splitting inherits the unique cardSlug in every consumer", async () => {
  split("i28", "shared-ledger");
  const f = feature("shared-ledger");
  const old = getDagVersion(db, f.id, f.currentVersion)!.nodes;
  rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [...old, node("NEW")], reasonKind: "new_issue",
    reasonText: "Add a new node after split", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  const updated = feature("shared-ledger");
  await assertConsumers("shared-ledger");
  expect(getDagVersion(db, updated.id, updated.currentVersion)!.nodes.find(n => n.key === "NEW")!.cardSlug).toBeUndefined();
  await assertConsumers("shared-ledger", "NEW");
  expect(cardNames(db, updated, "NEW", {})).toEqual(cardNames(db, updated, "NEW"));
  rewriteDag(db, ctx, { id: updated.id, rev: updated.rev,
    nodes: [{ ...node("C5"), oneLine: "Updated after adding NEW" }, node("NEW")], reasonKind: "new_issue",
    reasonText: "Update C5 after adding NEW", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  await assertConsumers("shared-ledger");
  await assertConsumers("shared-ledger", "NEW");
  split("shared-ledger", "third");
  await assertConsumers("third");
});

test("rewriting C5 from ordinary input preserves its identity through a later split", async () => {
  split("i28", "shared-ledger");
  const f = feature("shared-ledger");
  rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [{ ...node("C5"), oneLine: "Updated C5" }],
    reasonKind: "new_issue", reasonText: "Update C5 without carrying internal fields", cancel: new Map(),
    scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  await assertConsumers("shared-ledger");
  split("shared-ledger", "third");
  await assertConsumers("third");
});

test("proposal and owner approval preserve the original card identity", async () => {
  split("i28", "shared-ledger");
  const f = feature("shared-ledger");
  const result = rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [node("C5"), node("NEW")],
    reasonKind: "new_issue", reasonText: "Expand scope after split", cancel: new Map(), scopeChange: true,
    askFrom: { agent: "pm", channelId: null } });
  const ask = result.row.ask!;
  expect(result.row.proposal!.nodes.find(n => n.key === "C5")!.cardSlug).toBe("i28");
  answerAsk(db, ask.id, { choices: ["[button:dag_rewrite_approve]"], labels: ["Approve"], text: "",
    principal: "owner", via: "web_card", at: 101, owner: true });
  expect(approveDag(db, { ...ctx, now: 102 }, { id: f.id }).row.applied).toBe(true);
  await assertConsumers("shared-ledger");
});

test("provided explicit cardSlug avoids loading the current DAG", () => {
  split("i28", "shared-ledger");
  const f = feature("shared-ledger"), n = getDagVersion(db, f.id, f.currentVersion)!.nodes[0];
  const expected = cardNames(db, f, n.key);
  db.exec("DROP TABLE dag_versions");
  expect(cardNames(db, f, n.key, n)).toEqual(expected);
  expect(cardNames(db, f, "NEW", { cardSlug: "explicit" })).toMatchObject({ taskId: "explicit-NEW" });
});

test("unsplit names are byte-for-byte compatible and explicit start overrides remain authoritative", async () => {
  await assertConsumers("i28");
  expect(cardNames(db, feature("i28"), "C5")).toEqual({ slug: "i28", taskId: "i28-C5",
    agent: "agent-task-i28-c5", branch: "feat/i28-c5" });
  const unusual = { ...feature("i28"), id: "foreign.Feature", currentVersion: 0 };
  expect(cardNames(db, unusual, "Long.Key")).toEqual({ slug: "foreign.Feature", taskId: "foreign.Feature-Long.Key",
    agent: "agent-task-foreign-feature-long-key", branch: "feat/foreign.feature-long.key" });
  const result = await preflightStart(env(), { featureId: "ab12-i28", key: "C5", taskId: "Custom.ID", branch: "custom/branch", spec: "spec" });
  expect(result).toMatchObject({ ok: true, plan: { taskId: "Custom.ID", agent: "agent-task-custom-id", branch: "custom/branch" } });
});

for (const [slugs, expected] of [
  [[undefined, undefined], "i28"],
  [["original", undefined], "original"],
  [["original", "original"], "original"],
  [["original", "other"], "i28"],
  [["other", "original"], "i28"],
] as const) {
  test(`current cardSlugs ${JSON.stringify(slugs)} resolve unmarked nodes to ${expected}`, async () => {
    const f = feature("i28"), v = getDagVersion(db, f.id, f.currentVersion)!;
    // Seed internal split metadata: public DAG input intentionally ignores cardSlug.
    const nodes = v.nodes.map((n, i) => ({ ...n, cardSlug: slugs[i] }));
    db.query(`INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes)
      VALUES (?, 2, 'new_issue', 'owner', 100, ?)`).run(f.id, JSON.stringify(nodes));
    db.query("UPDATE features SET currentVersion = 2, rev = rev + 1 WHERE id = ?").run(f.id);
    rewrite("i28", [...nodes, node("NEW")]);
    await assertConsumers("i28", "NEW", expected);
    expect(cardNames(db, feature("i28"), "NEW", {})).toMatchObject({ taskId: `${expected}-NEW` });
    expect(cardNames(db, feature("i28"), "C5").slug).toBe(slugs[0] ?? expected);
  });
}

test("removed historical cardSlugs no longer influence the current version", async () => {
  split("i28", "shared-ledger");
  rewrite("shared-ledger", [node("NEW")]);
  expect(getDagVersion(db, feature("shared-ledger").id, 1)!.nodes[0].cardSlug).toBe("i28");
  await assertConsumers("shared-ledger", "NEW", "shared-ledger");
});

test("a pending rewrite cannot change the current version's inherited slug", () => {
  split("i28", "shared-ledger");
  rewrite("shared-ledger", [node("C5"), node("NEW")]);
  const f = feature("shared-ledger");
  rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [node("NEW")], reasonKind: "new_issue",
    reasonText: "Propose removing the prefix-bearing node", cancel: new Map(), scopeChange: true, askFrom: { agent: "pm", channelId: null } });
  expect(cardNames(db, feature("shared-ledger"), "NEW").taskId).toBe("i28-NEW");
});

test("autostart claims the same inherited card as start_node and spec lookup", async () => {
  split("i28", "shared-ledger");
  rewrite("shared-ledger", [node("C5"), node("NEW")]);
  await assertConsumers("shared-ledger", "NEW");
  const { claim } = claimNode(db, { actor: "scheduler", now: 100_000 }, {
    featureId: feature("shared-ledger").id, key: "NEW", arm: "0123456789abcdef", template: "code",
    svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2 },
  });
  expect(claim).toMatchObject({ taskId: "i28-NEW", agent: "agent-task-i28-new", branch: "feat/i28-new" });
});

test("an already-bound unmarked node keeps its custom task and is never autostarted", async () => {
  split("i28", "shared-ledger");
  rewrite("shared-ledger", [node("C5"), node("NEW")]);
  const f = feature("shared-ledger");
  createTask(db, ctx, { project: "p", id: "Custom.ID", title: "Existing card", kind: "code" });
  bindNode(db, ctx, { id: f.id, rev: f.rev, key: "NEW", taskId: "Custom.ID" });
  const updated = feature("shared-ledger"), views = currentViews(db, updated);
  expect(views.find(n => n.key === "NEW")!.taskId).toBe("Custom.ID");
  expect(views.find(n => n.key === "NEW")!.cardSlug).toBeUndefined();
  expect(await preflightStart(env(), { featureId: f.id, key: "NEW" })).toEqual({ ok: true, already: { taskId: "Custom.ID", key: "NEW" } });
  const read: string[] = [];
  expect(nodeCandidate(db, updated, "NEW", featureLanes(db, updated), views, (id) => { read.push(id); return null; }, 100_000))
    .toMatchObject({ gate: "node", why: "节点已绑 Custom.ID" });
  expect(read).toEqual([]);
});
