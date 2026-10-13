/**
 * team-project-PDSTATE1 验收线 4：productBoard（内存库，建法同 tests/ledger-product-board.test.ts）的每个 feature 都带
 * state / complete / frontier / counts.waiting，结果过网页的 assertProductBoard；frontier 不合法的 body 被拒；frontier 文件是纯函数。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { productBoard } from "../src/lib/ledger-product-board.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { assertProductBoard } from "../web/lib/api/product-board-types.js";

const HOUR = 60 * 60 * 1000, now = 100 * HOUR;

function board() {
  const db = openLedger(":memory:");
  const ctx = { actor: "owner", now: now - HOUR };
  const dag = createFeature(db, ctx, { project: "p", slug: "dag", title: "有 DAG" }).row;
  const flat = createFeature(db, ctx, { project: "p", slug: "flat", title: "没 DAG" }).row;
  createTask(db, ctx, { project: "p", id: "t-done", title: "完成的卡", kind: "code", stage: "verified" });
  createTask(db, ctx, { project: "p", id: "t-run", title: "在跑的卡", kind: "code", stage: "build", assigneeKind: "agent", assignee: "agent-x" });
  createTask(db, ctx, { project: "p", id: "t-flat", title: "游离卡", kind: "code", stage: "verified" });
  db.prepare("UPDATE tasks SET featureId=? WHERE id='t-flat'").run(flat.id);
  initDag(db, ctx, { id: dag.id, rev: 1, nodes: [{ key: "a", taskId: "t-done", oneLine: "a" }, { key: "b", taskId: "t-run", oneLine: "b", deps: ["a"] },
    { key: "c", oneLine: "c", deps: ["b"] }, { key: "d", oneLine: "d", deps: ["a"] }] });
  return productBoard(db, "p", now);
}

test("每个 feature 都带 state / complete / frontier / counts.waiting，并能过 assertProductBoard", () => {
  try {
    const result = board();
    expect(result.features).toHaveLength(2);
    for (const f of result.features) {
      expect(typeof f.state).toBe("string");
      expect(typeof f.complete).toBe("boolean");
      expect(Array.isArray(f.frontier)).toBe(true);
      expect(typeof f.counts.waiting).toBe("number");
    }
    const [dag, flat] = [result.features.find((f) => f.hasDag)!, result.features.find((f) => !f.hasDag)!];
    expect(dag).toMatchObject({ state: "run", complete: false, counts: { total: 4, completed: 1, active: 1, ready: 1, waiting: 1, blocked: 0 } });
    expect(dag.frontier.map((x) => x.key)).toEqual(["b", "d"]);
    expect(dag.frontier[0]).toMatchObject({ taskId: "t-run", title: "在跑的卡", stage: "build", member: "本机" });
    expect(dag.frontier[1]).toMatchObject({ taskId: null, title: "d", stage: "planned", member: null, sinceMs: null });
    expect(flat).toMatchObject({ state: "done", complete: true, frontier: [], counts: { total: 1, completed: 1, waiting: 0 } });
    const wire = JSON.parse(JSON.stringify({ ...result, now }));
    expect(() => assertProductBoard(wire)).not.toThrow();
  } finally { closeLedger(":memory:"); }
});

test("assertProductBoard：新字段缺省放行（旧后端）、认不出的 state 放行、类型不对的拒", () => {
  try {
    const base = JSON.parse(JSON.stringify(board())), i = base.features.findIndex((f: { hasDag: boolean }) => f.hasDag);
    const withFeature = (patch: (f: Record<string, unknown>) => void) => {
      const b = structuredClone(base); patch(b.features[i]); return b;
    };
    expect(() => assertProductBoard(withFeature((f) => {
      delete f.state; delete f.complete; delete f.frontier; delete f.lastActivityAt; delete (f.counts as Record<string, unknown>).waiting;
    }))).not.toThrow();
    expect(() => assertProductBoard(withFeature((f) => { f.state = "some-future-state"; }))).not.toThrow();
    const item = base.features[i].frontier[0];
    for (const bad of [
      (f: Record<string, unknown>) => { f.frontier = "b"; },
      (f: Record<string, unknown>) => { f.frontier = [null]; },
      (f: Record<string, unknown>) => { f.frontier = [{ ...item, key: 1 }]; },
      (f: Record<string, unknown>) => { f.frontier = [{ ...item, round: -1 }]; },
      (f: Record<string, unknown>) => { f.frontier = [{ ...item, sinceMs: "1" }]; },
      (f: Record<string, unknown>) => { f.frontier = [{ ...item, member: 0 }]; },
      (f: Record<string, unknown>) => { f.state = 3; },
      (f: Record<string, unknown>) => { f.complete = "yes"; },
      (f: Record<string, unknown>) => { (f.counts as Record<string, unknown>).waiting = -1; },
      (f: Record<string, unknown>) => { f.lastActivityAt = "now"; },
    ]) expect(() => assertProductBoard(withFeature(bad))).toThrow("Invalid product feature");
  } finally { closeLedger(":memory:"); }
});

test("frontier 文件是纯函数：不 import bun:sqlite，参数里没有 db", () => {
  const src = readFileSync(new URL("../src/lib/ledger-product-board-frontier.ts", import.meta.url), "utf8");
  expect(src).not.toContain("bun:sqlite");
  expect(src).not.toMatch(/\bDatabase\b/);
  expect(src).not.toMatch(/\bdb\b/);
});
