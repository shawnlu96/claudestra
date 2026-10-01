import { expect, test } from "bun:test";
import { nodeCounts, productBoard } from "../src/lib/ledger-product-board.js";
import { estimateHours, median, criticalPath, projectPace, featureEta, propagateEtas, HOUR, type EtaNode } from "../src/lib/ledger-product-board-eta.js";
import type { LedgerEvent, LedgerTask, Stage } from "../src/lib/ledger-stages.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { createTask } from "../src/lib/ledger-write.js";
import { handleProductBoardApi } from "../src/bridge/local-api/product-board.js";
import type { Principal } from "../src/lib/principals.js";
const now = 100 * HOUR;
const task = (id: string, stage: Stage): LedgerTask => ({ id, stage, project: "p", kind: "code", updatedAt: 1 } as LedgerTask);
const node = (key: string, stage: Stage | null = null, deps: string[] = [], estimate = "半天", oneLine = key): EtaNode => ({
  key, taskId: stage ? key : null, task: stage ? task(key, stage) : null, deps, estimate, oneLine, status: "planned", inheritedFrom: null,
});
const event = (target: string, stage: Stage, ts: number): LedgerEvent => ({ target, kind: "stage", ts, data: { to: stage }, seq: 1, actor: "owner", project: "p", text: "", dedupKey: null });
const events = new Map<string, LedgerEvent[]>();
const pace = { verified12h: 0, perHour: 0.25, k: 1, samples: 0, fallback: 4 };

test("every estimate syntax, upper ranges, positive numbers and median fallback", () => {
  for (const [s, n] of [["S", 1], ["半天", 4], ["2 小时", 2], ["30 分钟", 0.5], ["设计稿 15 分钟", 0.25],
    ["2 天", 16], ["1–3 天", 24], ["1-2 小时", 2], ["1.5小时", 1.5]] as const) expect(estimateHours(s)).toBe(n);
  for (const s of ["", "不明", "0 小时", "-1 天", "NaN小时"]) expect(estimateHours(s)).toBeNull();
  expect(median([])).toBe(4); expect(median([1, 9, 3])).toBe(3); expect(median([8, 2])).toBe(5);
});
test("six counts partition nodes including deferred done, active blocked, missing and foreign bindings", () => {
  const lost = { ...node("lost", "build"), task: null };
  const nodes = [node("done", "cancelled"), node("active", "review"), node("ready", null, ["done"]),
    node("waiting", null, ["active"]), node("blocked", "blocked"), lost, node("future", "done", [], "S", "（远期）future")];
  expect(nodeCounts(nodes)).toEqual({ total: 7, completed: 1, active: 1, ready: 1, blocked: 3, deferred: 1 });
});
test("critical path, completed prerequisites, parallel branches, half active and blocked, unknown fallback", () => {
  const nodes = [node("done", "verified", [], "2 天"), node("a", null, ["done"], "2 小时"),
    node("b", "build", ["a"], "6 小时"), node("c", "blocked", ["a"], "10 小时"), node("d", null, ["c"], "?"),
    node("future", null, [], "99 天", "（远期）future")];
  expect(criticalPath(nodes, 4)).toBe(11);
  const eta = featureEta(nodes, pace, 4, events, now);
  expect(eta.basis).toMatchObject({ cpHours: 11, remaining: 4, share: 0.5 });
  expect(eta.at).toBe(now + 32 * HOUR);
  expect(featureEta(nodes, { ...pace, perHour: 100, k: 4 }, 4, events, now).at).toBe(now + 44 * HOUR);
  expect(featureEta(nodes, pace, 4, events, now)).toEqual(eta);
});
test("throughput counts first verification only, includes off-DAG investigate, excludes future and old marks", () => {
  const ts = [task("a", "verified"), task("b", "done"), { ...task("c", "done"), kind: "investigate" as const }, task("d", "verified")];
  const es = new Map([
    ["a", [event("a", "verified", now - 13 * HOUR), event("a", "verified", now - HOUR)]],
    ["b", [event("b", "done", now - HOUR)]], ["c", [event("c", "done", now - HOUR)]],
    ["d", [event("d", "verified", now + HOUR)]],
  ]);
  expect(projectPace([], ts, es, now)).toMatchObject({ verified12h: 1, perHour: 0.25, k: 1, fallback: 4 });
  const many = Array.from({ length: 12 }, (_, i) => task(`t${i}`, "verified"));
  expect(projectPace([], many, new Map(many.map((t) => [t.id, [event(t.id, "verified", now - HOUR)]])), now).perHour).toBe(1);
});
test("calibration median, bounds, insufficient samples and parsed project median", () => {
  const ns = [node("a", "verified", [], "1小时"), node("b", "verified", [], "3小时"), node("c", "verified", [], "2小时")];
  for (const [ratio, expected] of [[0.1, 0.25], [10, 4], [2, 2]]) {
    const es = new Map(ns.map((n) => [n.key, [event(n.key, "build", now - HOUR - estimateHours(n.estimate)! * ratio * HOUR), event(n.key, "verified", now - HOUR)]]));
    expect(projectPace(ns, ns.map((n) => n.task!), es, now)).toMatchObject({ k: expected, samples: 3, fallback: 2 });
    expect(projectPace(ns.slice(0, 2), [], es, now).k).toBe(1);
  }
});
test("remaining zero uses last completion; empty/deferred-only DAG has no invented completion", () => {
  const es = new Map([["a", [event("a", "verified", now - HOUR)]], ["b", [event("b", "cancelled", now - 2 * HOUR)]]]);
  expect(featureEta([node("a", "verified"), node("b", "cancelled")], pace, 0, es, now)).toMatchObject({ at: now - HOUR, done: true });
  expect(featureEta([], pace, 0, es, now)).toMatchObject({ at: null, done: true });
});
test("feature dependency transitive ETA in reverse response order and null ETA", () => {
  const eta = featureEta([node("a")], pace, 0, events, now);
  const fs = [{ id: "c", eta: { ...eta, at: 1 } }, { id: "b", eta: { ...eta, at: 2 } }, { id: "a", eta: { ...eta, at: 10 } }, { id: "none", eta: null }];
  propagateEtas(fs, [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "none" }]);
  expect(fs.map((f) => f.eta?.at ?? null)).toEqual([10, 10, 10, null]);
});
test("database projection uses current effective nodes; no DAG uses cards and no ETA; old schema reads safely", () => {
  const db = openLedger(":memory:");
  try {
    const ctx = { actor: "owner", now: 1 };
    const f = createFeature(db, ctx, { project: "p", slug: "a", title: "a" }).row;
    createTask(db, ctx, { project: "p", id: "t", title: "t", kind: "code", stage: "done" });
    db.prepare("UPDATE tasks SET featureId=? WHERE id='t'").run(f.id);
    expect(productBoard(db, "p", now).features[0]).toMatchObject({ hasDag: false, version: 0, counts: { total: 1, completed: 1, active: 0 }, eta: null });
    initDag(db, ctx, { id: f.id, rev: 1, nodes: [{ key: "a", taskId: "t", oneLine: "a" }, { key: "b", oneLine: "b", deps: ["a"], estimate: "S" }] });
    const result = productBoard(db, "p", now);
    expect(result.features[0]).toMatchObject({ hasDag: true, version: 1, counts: { total: 2, completed: 1, ready: 1 } });
    expect(result.features[0]).not.toHaveProperty("nodes");
    createTask(db, ctx, { project: "other", id: "x", title: "private title", kind: "code", stage: "done" });
    db.prepare("INSERT INTO dag_bindings (featureId,version,nodeKey,taskId,boundBy,boundAt) VALUES (?,1,'b','x','owner',1)").run(f.id);
    const bound = productBoard(db, "p", now);
    expect(bound.features[0].counts).toMatchObject({ total: 2, completed: 1, blocked: 1, ready: 0 });
    expect(JSON.stringify(bound)).not.toContain("private title");
    // Only feature_deps may be absent on a previously deployed schema.
    db.prepare("DROP TABLE feature_deps").run();
    expect(productBoard(db, "p", now).deps).toEqual([]);
  } finally { closeLedger(":memory:"); }
});
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "" };
test("API gates before IO, unknown project 404, absent DB exists:false, read-only response", async () => {
  const req = new Request("http://example/api/v1/ledger/p/product"), url = new URL(req.url);
  const forbiddenIO = { db: () => { throw new Error("must not read"); }, projectExists: async () => { throw new Error("must not read"); }, now: () => now };
  expect((await handleProductBoardApi(req, "/ledger/p/product", { ...owner, role: "external", agents: [] }, url, forbiddenIO))!.status).toBe(403);
  const io = { db: () => null, projectExists: async (p: string) => p === "p", now: () => now };
  expect((await handleProductBoardApi(req, "/ledger/q/product", owner, url, io))!.status).toBe(404);
  const res = (await handleProductBoardApi(req, "/ledger/p/product", owner, url, io))!;
  expect(await res.json()).toMatchObject({ ok: true, exists: false, features: [], now });
  const db = openLedger(":memory:");
  try {
    db.exec("PRAGMA query_only=ON");
    const r = (await handleProductBoardApi(req, "/ledger/p/product", owner, url, { ...io, db: () => db }))!;
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ exists: true, features: [], deps: [] });
  } finally { closeLedger(":memory:"); }
});

for (const prefix of ["（远期）", "(远期)"]) {
  test(`${prefix} nodes count as deferred and contribute no remaining work or ETA`, () => {
    const baseline = [node("a", null, [], "S")];
    const future = node("future", "blocked", [], "99 天", `${prefix}future`);
    expect(nodeCounts([...baseline, future])).toEqual({ total: 2, completed: 0, active: 0, ready: 1, blocked: 0, deferred: 1 });
    expect(featureEta([...baseline, future], pace, 0, events, now)).toEqual(featureEta(baseline, pace, 0, events, now));
    expect(projectPace([...baseline, future], [], events, now).fallback).toBe(1);
    expect(featureEta([future], pace, 0, events, now)).toMatchObject({ at: null, done: true, basis: { remaining: 0, cpHours: 0 } });
  });
}
