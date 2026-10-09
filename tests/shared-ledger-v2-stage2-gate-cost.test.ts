import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as writes from "../src/lib/ledger-write.js";
import { getTask, LedgerError } from "../src/lib/ledger-store.js";
import { insertEvent, tx } from "../src/lib/ledger-tx.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { runLedger } from "../src/manager/ledger.js";
import { PROJECTION_ACTOR, withExecutorScope, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { execution, firstFence, fixture, rejected, type Fixture } from "./shared-ledger-v2-stage2-gate-helpers.test.js";

const planning = { authorityMode: "planning" as const, sharedPlanning: true };
function cards(f: Fixture, n: number) {
  const insert = f.db.prepare(`INSERT INTO tasks (id,project,title,kind,stage,rev,extra,createdAt,updatedAt)
    SELECT ?, project, title, kind, stage, 1, ?, createdAt, updatedAt FROM tasks WHERE id='T'`);
  f.db.transaction(() => { for (let i = 0; i < n; i++) insert.run(`c${i}`, i % 2 ? "{}" : JSON.stringify({ sharedFeatureId: `G${i % 7}` })); })();
}
const average = (n: number, fn: (i: number) => void): number => {
  let total = 0;
  for (let i = 0; i < n + 3; i++) {
    const t0 = performance.now();
    fn(i);
    if (i >= 3) total += performance.now() - t0;
  }
  return total / n;
};
// The gate's own statements (tracker objects, card lookup, projection scan); the store's spaced "WHERE id = ?" is not one of them.
const gateSql = /temp\.|gate_|pragma_schema_version|json_object|SELECT \* FROM tasks WHERE id=\?|SELECT \* FROM tasks$/;
function gateQueries(f: Fixture, fn: () => void): string[] {
  const query = spyOn(f.db, "query"), prepare = spyOn(f.db, "prepare");
  try {
    fn();
    return [...query.mock.calls, ...prepare.mock.calls].map(([sql]) => String(sql)).filter(sql => gateSql.test(sql));
  } finally { query.mockRestore(); prepare.mockRestore(); }
}

describe("S2G2 gate cost", () => {
  test("2000 cards: execution adds at most 2 ms to a local write and to an executor bookkeeping write", () => {
    const f = fixture();
    try {
      cards(f, 2000);
      f.workflow();
      let base = 0, gated = 0;
      const rounds = 20;
      for (let i = 0; i < rounds; i++) {
        f.setMode(planning);
        f.plan(`a${i}`);
        let t0 = performance.now();
        settleIntent(f.db, f.scheduler, { id: `a${i}`, from: "pending", to: "cancelled" });
        base += performance.now() - t0;
        f.plan(`b${i}`);
        f.setMode(execution);
        t0 = performance.now();
        f.scope(() => settleIntent(f.db, f.scheduler, { id: `b${i}`, from: "pending", to: "cancelled" }));
        gated += performance.now() - t0;
      }
      f.setMode(planning);
      const localBase = average(30, i => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: `p${i}` } }));
      f.setMode(execution);
      const local = average(30, i => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: `e${i}` } }));
      console.log(`[S2G2 cost] 2000 cards: local write ${local.toFixed(3)} ms (planning ${localBase.toFixed(3)} ms); `
        + `executor settle ${(gated / rounds).toFixed(3)} ms (planning ${(base / rounds).toFixed(3)} ms)`);
      expect(local - localBase).toBeLessThanOrEqual(2);
      expect((gated - base) / rounds).toBeLessThanOrEqual(2);
      // Cost must not follow the card count: no whole-table reads remain on the gated path.
      expect(gateQueries(f, () => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: "x" } }))
        .filter(sql => /FROM (main\.)?(tasks|items|meta|features|task_deps|scheduler_intents)( |$)(?!.*WHERE)/.test(sql))).toEqual([]);
    } finally { f.close(); }
  }, 60_000);

  test("off: no mode file, or no execution / migrating feature, runs no gate query", () => {
    const f = fixture();
    try {
      rmSync(join(f.dir, "shared-ledger-modes.json"), { force: true });
      expect(gateQueries(f, () => writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "off" } }))).toEqual([]);
      f.setMode(planning);
      expect(gateQueries(f, () => {
        writes.setTask(f.db, f.owner, { id: "T", rev: 2, patch: { title: "planning" } });
        writes.appendEvent(f.db, f.owner, { project: "p", target: "T", kind: "note" });
      })).toEqual([]);
      expect(gateQueries(f, () => writes.appendEvent(f.db, f.owner, { project: "p", target: "T", kind: "note", text: "again" }))
        .concat(f.db.query("SELECT name FROM temp.sqlite_master").all().map(r => JSON.stringify(r)))).toEqual([]);
    } finally { f.close(); }
  });
});

describe("S2G2 malformed sharedFeatureId", () => {
  const warnings: string[] = []; // Observed once per card id per process, so the three runs on card T share one warning.
  for (const value of ["bad/feature", 7, ""]) test(`${JSON.stringify(value)} is written as an unshared card and observed`, async () => {
    const f = fixture(), warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.db.query("UPDATE tasks SET extra=? WHERE id='T'").run(JSON.stringify({ sharedFeatureId: value }));
      f.setMode(execution);
      expect(writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "stage one" } }).row.title).toBe("stage one");
      expect(writes.moveStage(f.db, f.owner, { taskId: "T", from: "spec", to: "restate" }).row.stage).toBe("restate");
      warnings.push(...warn.mock.calls.flat().map(String).filter(text => text.includes("sharedFeatureId 畸形")));
      expect(warnings).toEqual(["[shared-ledger-write-gate] 卡 T 的 sharedFeatureId 畸形，按非共享卡处理"]);
      expect(JSON.parse((f.db.query("SELECT extra FROM tasks WHERE id='T'").get() as { extra: string }).extra)).toEqual({ sharedFeatureId: value });
      const show = await runLedger(["show", "T"], { db: f.db, actor: "owner", projectIds: ["p"], now: () => 1,
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} }) as Record<string, unknown>;
      expect(show.diagnostics).toEqual(["sharedFeatureId 畸形"]);
    } finally { warn.mockRestore(); f.close(); }
  });
  test("a well-formed card has no diagnostics field and stays protected", async () => {
    const f = fixture();
    try {
      const show = await runLedger(["show", "T"], { db: f.db, actor: "owner", projectIds: ["p"], now: () => 1,
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} }) as Record<string, unknown>;
      expect(Object.keys(show)).toEqual(["ok", "task", "metrics", "events"]);
      f.setMode(execution);
      rejected(f, () => writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "blocked" } }));
    } finally { f.close(); }
  });
  test("featureId column keeps a malformed-extra card protected", () => {
    const f = fixture(), warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      f.db.query("INSERT INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES ('F','p','feature','active','owner',1,1)").run();
      f.db.query("UPDATE tasks SET extra=?,featureId='F' WHERE id='T'").run(JSON.stringify({ sharedFeatureId: "bad/feature" }));
      f.setMode(execution);
      rejected(f, () => writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "blocked" } }));
    } finally { warn.mockRestore(); f.close(); }
  });
});

describe("S2G2 refusal codes", () => {
  test("v2_unmapped and stale_claim surface as LedgerError conflict naming the original code", () => {
    const f = fixture();
    try {
      f.workflow(); f.setMode(execution);
      for (const [fn, name] of [
        [() => withExecutorScope(f.db, { featureId: "F", taskId: "T", fence: firstFence, claimFence: null }, () => {}), "v2_unmapped"],
        [() => f.scope(() => f.plan(), { ...firstFence, epoch: 2, leaseId: "new" }, firstFence), "stale_claim"],
      ] as const) {
        let caught: unknown;
        try { fn(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(LedgerError);
        expect(caught).toMatchObject({ code: "conflict" });
        expect((caught as Error).message).toContain(name);
      }
    } finally { f.close(); }
  });
});

describe("S2G2 projection sequence", () => {
  const project = (f: Fixture, db: Database, centerSeq: number) => tx(db, () => withProjectionScope(db, { featureId: "F", centerSeq }, () => {
    db.query("UPDATE tasks SET title=? WHERE id='T'").run(`snapshot ${centerSeq}`);
    insertEvent(db, { actor: PROJECTION_ACTOR }, { project: "p", target: "T", kind: "task", data: { op: "center-projection" } }, true);
  }));
  test("rolled-back projections do not raise the floor; other connections' commits do", () => {
    const f = fixture(), other = new Database(f.path);
    try {
      f.setMode(execution);
      project(f, f.db, 3);
      expect(() => tx(f.db, () => { project(f, f.db, 5); throw new Error("abort"); })).toThrow("abort");
      writes.appendEvent(f.db, f.owner, { project: "p", target: "", kind: "note" });
      project(f, f.db, 4);
      other.run("PRAGMA busy_timeout=5000");
      project(f, other, 9);
      rejected(f, () => project(f, f.db, 8));
      project(f, f.db, 10);
      rejected(f, () => project(f, f.db, 10));
    } finally { other.close(); f.close(); }
  });
});

test("S2G2 tracking survives a mid-session schema change", () => {
  const f = fixture();
  try {
    writes.createTask(f.db, f.owner, { project: "p", id: "local", title: "local", kind: "code" });
    f.setMode(execution);
    writes.setTask(f.db, f.owner, { id: "local", rev: 1, patch: { title: "tracked" } });
    f.db.run("ALTER TABLE tasks ADD COLUMN gateProbe TEXT");
    rejected(f, () => tx(f.db, () => f.db.query("UPDATE tasks SET gateProbe='x' WHERE id='T'").run()));
  } finally { f.close(); }
});
