import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as writes from "../src/lib/ledger-write.js";
import { getTask, LedgerError } from "../src/lib/ledger-store.js";
import { insertEvent, tx } from "../src/lib/ledger-tx.js";
import { runLedger } from "../src/manager/ledger.js";
import { PROJECTION_ACTOR, withExecutorScope, withProjectionScope } from "../src/lib/shared-ledger-v2-write-gate.js";
import { execution, firstFence, fixture, rejected, type Fixture } from "./shared-ledger-v2-stage2-gate-helpers.test.js";
import { absoluteCost, cards, planning, scalingCost } from "./shared-ledger-v2-stage2-gate-cost-fixture.test.js";

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
  let f: Fixture;
  let costs: ReturnType<typeof absoluteCost>, scale: ReturnType<typeof scalingCost>;
  // One shared setup keeps both resident and filtered profile runs under the original cost case's budget.
  beforeAll(() => {
    f = fixture();
    cards(f, 2000);
    costs = absoluteCost(f);
    const small = fixture(), large = fixture();
    try {
      // Equal-size payloads expose full-snapshot cost without changing the thin-card absolute-overhead baseline.
      cards(small, 500, 8192); cards(large, 2000, 8192);
      scale = scalingCost(small, large);
    } finally { small.close(); large.close(); }
  }, 60_000);
  afterAll(() => f?.close());

  test("2000 cards: logs write costs and forbids whole-table gate reads", () => {
      f.setMode(execution);
      // Cost must not follow the card count: no whole-table reads remain on the gated path.
      expect(gateQueries(f, () => writes.setTask(f.db, f.owner, { id: "c1", rev: getTask(f.db, "c1")!.rev, patch: { title: "x" } }))
        .filter(sql => /FROM (main\.)?(tasks|items|meta|features|task_deps|scheduler_intents)( |$)(?!.*WHERE)/.test(sql))).toEqual([]);
  });

  test.skipIf(!process.env.LEDGER_PERF_PROFILE)("2000 cards: execution adds at most 2 ms to a local write and to an executor bookkeeping write", () => {
    const { local, localBase, gated, base, rounds } = costs;
    expect(local - localBase).toBeLessThanOrEqual(2);
    expect((gated - base) / rounds).toBeLessThanOrEqual(2);
  });

  for (const kind of ["local", "settle"] as const) test(`500 vs 2000 cards: ${kind} execution write medians scale by at most 3`, () => {
    const [base, full] = scale;
    console.log(`[S2G3 scaling] ${kind}: 500 cards ${base![kind].toFixed(3)} ms; 2000 cards ${full![kind].toFixed(3)} ms; `
      + `ratio ${(full![kind] / base![kind]).toFixed(3)} (21 execution samples, interleaved with planning)`);
    expect(base![kind]).toBeGreaterThan(0);
    expect(full![kind] / base![kind]).toBeLessThanOrEqual(3);
  });

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
