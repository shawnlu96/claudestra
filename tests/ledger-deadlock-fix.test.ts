import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { reconcileFindings, openFindings } from "../src/lib/ledger-audit-store.js";
import { readWaitGraph } from "../src/lib/ledger-deadlock-read.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";

let db: Database, dir: string, path: string;
const ctx = { actor: "owner", now: 100 };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dlk1-fix-"));
  path = join(dir, "ledger.sqlite");
  db = openLedger(path);
  db.run("INSERT INTO ledger_instance (key,value) VALUES ('origin','ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["agent-pm"] });
  setMeta(db, ctx, { project: "p", key: "docsDir", value: join(dir, "docs") });
});
afterEach(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
function card(id: string): void {
  createTask(db, ctx, { project: "p", id, title: id, kind: "code", stage: "build" });
}
function dag(slug: string, nodes: unknown[]): void {
  createFeature(db, ctx, { project: "p", slug, title: slug });
  initDag(db, ctx, { id: `ab12-${slug}`, rev: 1, nodes });
}
function pair(prefix: string): void {
  const a = `${prefix}A`, b = `${prefix}B`;
  card(a); card(b);
  addDep(db, ctx, { from: b, to: a, when: "先上线" });
  dag(prefix.toLowerCase(), [{ key: a, taskId: a }, { key: b, taskId: b, deps: [a] }]);
}
function audit(now = 1000) {
  return auditLedger({ project: "p", pms: ["agent-pm"], tasks: [], agents: [], reviewers: [], held: [], ownerInbox: [],
    waitGraph: readWaitGraph(db, "p") }, now, () => ({ mode: "off", manualAfterMs: null, source: "default" }));
}
function deps(): LedgerDeps {
  return { db, actor: "owner", actorProject: "p", projectIds: ["p"], now: () => 2000,
    loadRegistry: async () => ({ socket: join(dir, "unused.sock"), agents: {} }), saveRegistry: async () => {},
    auditSources: { registry: async () => [], windows: async () => [], turn: async () => "idle",
      fileTimes: async () => ({ lastWriteAt: null, startedAt: null }), reviewers: () => [], heldPath: join(dir, "held.json") } };
}
test("cycle-ack: real runLedger ACK marks cycle notified and prevents repeat pending", async () => {
  const base = audit();
  reconcileFindings(db, "p", [], base.evaluated, 1);
  pair("Z");
  const r = audit();
  const rec = reconcileFindings(db, "p", r.findings, r.evaluated, 1000);
  expect(rec.pending).toHaveLength(1);
  const result = await runLedger(["audit", "--ack", rec.pending.map(f => f.key).join(",")], deps());
  expect(result).toMatchObject({ ok: true, acked: 1 });
  expect(openFindings(db, "p")[0].notifiedAt).toBe(2000);
  expect(reconcileFindings(db, "p", r.findings, r.evaluated, 3000).pending).toEqual([]);
});
test("truncated-resolve: 21 real cycles retain omitted old finding and report incomplete", () => {
  pair("Z");
  const old = audit();
  reconcileFindings(db, "p", old.findings, old.evaluated, 1000);
  for (let i = 0; i < 20; i++) pair(`A${String(i).padStart(2, "0")}`);
  const g = readWaitGraph(db, "p");
  expect(g.truncated).toBe(true);
  expect(g.cycles).toHaveLength(20);
  expect(g.edges).toContainEqual(expect.objectContaining({ from: "ZA", to: "ZB" }));
  const r = audit(2000);
  expect(r.evaluated).not.toContain("wait_cycle");
  expect(r.skipped).toContainEqual({ rule: "wait_cycle", reason: expect.stringContaining("截断") });
  expect(reconcileFindings(db, "p", r.findings, r.evaluated, 2000).resolved).not.toContain(old.findings[0].key);
  expect(openFindings(db, "p").find(f => f.key === old.findings[0].key)?.resolvedAt).toBeNull();
});
test("chain-cut: real CLI JSON preserves all 30 nodes and every edge source", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `TASK-${String(i).padStart(2, "0")}`);
  ids.forEach(card);
  dag("long", ids.map((id, i) => ({ key: id, taskId: id, deps: i < 29 ? [ids[i + 1]] : [] })));
  addDep(db, ctx, { from: ids[0], to: ids[29], when: "闭环" });
  const g = readWaitGraph(db, "p");
  expect(g.truncated).toBe(false);
  expect(g.cycles[0].nodes).toHaveLength(30);
  const result = await runLedger(["audit", "--project", "p", "--dry-run", "--json"], deps());
  const projects = result.projects as { waitGraph?: typeof g }[];
  expect(projects[0].waitGraph).toEqual(g);
  expect(projects[0].waitGraph?.cycles[0].edges).toHaveLength(30);
});
