import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { answerAsk } from "../src/lib/ledger-asks.js";
import { cardNames } from "../src/lib/ledger-card-names.js";
import { getDagVersion, getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { approveDag, bindNode, rewriteDag } from "../src/lib/ledger-dag-write.js";
import { applyFeatureSplit } from "../src/lib/ledger-feature-split.js";
import { planFeatureSplit } from "../src/lib/ledger-feature-split-plan.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
const ctx = { actor: "owner", now: 100 };
const node = (key: string) => ({ key, oneLine: key, deps: [], fileGlobs: [`src/${key}.ts`] });
const feature = (slug: string) => getFeature(db, `ab12-${slug}`)!;
const keys = (slug: string) => { const f = feature(slug); return getDagVersion(db, f.id, f.currentVersion)!.nodes.map((n) => n.key); };
const rewrite = (slug: string, add: string[], scopeChange = false) => {
  const f = feature(slug), old = getDagVersion(db, f.id, f.currentVersion)!.nodes;
  return rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [...old, ...add.map(node)], reasonKind: "new_issue",
    reasonText: "Add nodes to a sibling feature", cancel: new Map(), scopeChange, askFrom: { agent: "pm", channelId: null } });
};

beforeEach(() => {
  db = openLedger(":memory:");
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "i28", title: "i28" });
  initDag(db, ctx, { id: "ab12-i28", rev: 1, nodes: [node("C5"), node("C6"), node("C7")] });
  // 两个兄弟 feature 共用 i28 前缀
  applyFeatureSplit(db, ctx, "ab12-i28", { targets: [{ slug: "alpha", title: "alpha", nodes: ["C5"] }, { slug: "beta", title: "beta", nodes: ["C6"] }], deps: [] });
});
afterEach(() => closeLedger(":memory:"));

test("a sibling adding a key another sibling already has under the same cardSlug is rejected, naming the feature", () => {
  const before = feature("alpha").rev;
  expect(() => rewrite("alpha", ["C6"])).toThrow(/ab12-beta.*C6|C6.*ab12-beta/);
  expect(feature("alpha").rev).toBe(before);
  expect(keys("alpha")).toEqual(["C5"]);
  expect(() => rewrite("i28", ["C5"])).toThrow(/ab12-alpha/);
  expect(() => rewrite("beta", ["C7"])).toThrow(/ab12-i28/);
});

test("the whole write is rejected even when only one of several new keys collides", () => {
  expect(() => rewrite("alpha", ["C9", "C6"])).toThrow(/ab12-beta/);
  expect(keys("alpha")).toEqual(["C5"]);
});

test("different keys are accepted and pinned; the first sibling to add a key wins", () => {
  rewrite("alpha", ["C9"]);
  expect(cardNames(db, feature("alpha"), "C9").taskId).toBe("i28-C9");
  expect(() => rewrite("beta", ["C9"])).toThrow(/ab12-alpha.*C9|C9.*ab12-alpha/);
  rewrite("beta", ["C10"]);
  expect(keys("beta")).toEqual(["C6", "C10"]);
});

test("re-adding a key the same feature already carries is not a collision", () => {
  const f = feature("alpha"), old = getDagVersion(db, f.id, f.currentVersion)!.nodes;
  rewriteDag(db, ctx, { id: f.id, rev: f.rev, nodes: [{ ...old[0], oneLine: "changed" }], reasonKind: "new_issue",
    reasonText: "Change an existing node only", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  expect(keys("alpha")).toEqual(["C5"]);
});

test("an opened sibling node counts as taken", () => {
  createTask(db, ctx, { project: "p", id: "i28-C5", title: "C5", kind: "code" });
  bindNode(db, ctx, { id: "ab12-alpha", rev: feature("alpha").rev, key: "C5", taskId: "i28-C5" });
  expect(() => rewrite("beta", ["C5"])).toThrow(/ab12-alpha.*i28-C5/);
  expect(keys("beta")).toEqual(["C6"]);
});

test("dag-init is rejected when its prefix and key are already taken by another feature", () => {
  createTask(db, ctx, { project: "p", id: "zz-C1", title: "C1", kind: "code" });
  rewriteDag(db, ctx, { id: "ab12-alpha", rev: feature("alpha").rev, nodes: [...getDagVersion(db, "ab12-alpha", feature("alpha").currentVersion)!.nodes, { ...node("Z1"), taskId: "zz-C1" }],
    reasonKind: "new_issue", reasonText: "Bind a card named under another prefix", cancel: new Map(), scopeChange: false, askFrom: { agent: "pm", channelId: null } });
  createFeature(db, ctx, { project: "p", slug: "zz", title: "zz" });
  expect(() => initDag(db, ctx, { id: "ab12-zz", rev: 1, nodes: [node("C1")] })).toThrow(/ab12-alpha.*zz-C1/);
  expect(feature("zz").currentVersion).toBe(0);
  initDag(db, ctx, { id: "ab12-zz", rev: 1, nodes: [node("C2")] });
  expect(feature("zz").currentVersion).toBe(1);
});

test("split refuses to move a node into a target when a sibling already has that key under the same prefix", () => {
  // 存量里已经撞了的数据（SL2 之前写下的）：i28 又有了 C5，不许再把它搬成第三个兄弟
  const f = feature("i28"), nodes = getDagVersion(db, f.id, f.currentVersion)!.nodes;
  db.query(`INSERT INTO dag_versions (featureId, version, reasonKind, proposedBy, createdAt, nodes) VALUES (?, ?, 'new_issue', 'owner', 100, ?)`)
    .run(f.id, f.currentVersion + 1, JSON.stringify([...nodes, { ...nodes[0], key: "C5", oneLine: "C5" }]));
  db.query("UPDATE features SET currentVersion = currentVersion + 1, rev = rev + 1 WHERE id = ?").run(f.id);
  const plan = planFeatureSplit(db, "ab12-i28", { targets: [{ slug: "gamma", title: "gamma", nodes: ["C5"] }], deps: [] });
  expect(plan.rejected.join("\n")).toMatch(/ab12-gamma.*ab12-alpha.*C5/);
  expect(planFeatureSplit(db, "ab12-i28", { targets: [{ slug: "gamma", title: "gamma", nodes: ["C7"] }], deps: [] }).rejected).toEqual([]);
});

test("splits without a same-prefix key collision are accepted", () => {
  createFeature(db, ctx, { project: "p", slug: "delta", title: "delta" });
  initDag(db, ctx, { id: "ab12-delta", rev: 1, nodes: [node("D1")] });
  // delta 的 D1 前缀是 delta，别处没有 delta-D1
  expect(planFeatureSplit(db, "ab12-delta", { targets: [{ slug: "epsilon", title: "epsilon", nodes: ["D1"] }], deps: [] }).rejected).toEqual([]);
  // alpha 已有 i28-C5；搬进去的 C7 别的兄弟都没有
  expect(planFeatureSplit(db, "ab12-i28", { targets: [{ id: "alpha", title: "alpha", nodes: ["C7"] }], deps: [] }).rejected).toEqual([]);
});

test("a pending proposal is voided at approval if a sibling took the key meanwhile", () => {
  const proposed = rewrite("alpha", ["C9"], true);
  rewrite("beta", ["C9"]);
  answerAsk(db, proposed.row.ask!.id, { choices: ["[button:dag_rewrite_approve]"], labels: ["Approve"], text: "",
    principal: "owner", via: "web_card", at: 101, owner: true });
  const r = approveDag(db, { ...ctx, now: 102 }, { id: "ab12-alpha" }).row;
  expect(r.applied).toBe(false);
  expect(r.why).toMatch(/ab12-beta.*C9/);
  expect(keys("alpha")).toEqual(["C5"]);
});
