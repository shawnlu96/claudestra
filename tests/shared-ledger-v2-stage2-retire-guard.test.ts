import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION } from "../src/lib/ledger-store.js";
import { runMigrations, schemaVersion } from "../src/lib/sqlite-migrate.js";
import { createTask } from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { releaseFinishedCardLeases } from "../src/lib/ledger-scheduler-lease.js";
import { retireStep } from "../src/lib/scheduler-retire-deps.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { configureSchedulerV2Retire } from "../src/lib/scheduler-v2-retire.js";
import { guardProjectionTasks, installProjectionGuard, isProjectionGuarded, withProjectionWriter,
  PROJECTION_GUARD_DDL, PROJECTION_GUARD_TABLE_DDL, PROJECTION_GUARD_TRIGGER_DDL } from "../src/lib/scheduler-v2-retire-guard.js";

const cleanup: (() => void)[] = [];
afterEach(() => { configureSchedulerV2Retire(null); while (cleanup.length) cleanup.pop()!(); });
const owner = { actor: "owner", now: 10 }, scheduler = { actor: "scheduler", now: 100 };

function fixture(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), "s2v-guard-")), path = join(dir, "ledger.sqlite");
  if (legacy) createBaselineLedger(dir, path);
  const db = legacy ? new Database(path) : openLedger(path);
  if (legacy) expect(schemaVersion(db)).toBe(23);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const registry = join(dir, "registry.json"); writeFileSync(registry, '{"agents":{}}');
  return { db, path, dir, registry };
}

/** Run the exact pre-S2V openLedger and scheduler schema, with imports redirected to this clone. */
function createBaselineLedger(dir: string, path: string): void {
  const base = "2978bad33cff52371de3f4e2363c3b4e8831b634";
  const read = (name: string): string => {
    const result = Bun.spawnSync(["git", "show", `${base}:src/lib/${name}.ts`], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0); return result.stdout.toString();
  };
  const schemaPath = join(dir, "baseline-schema.ts"), storePath = join(dir, "baseline-store.ts");
  writeFileSync(schemaPath, read("ledger-scheduler-schema"));
  const source = read("ledger-store").replace(/from "(\.\/[^"]+)"/g, (_match, name: string) =>
    `from ${JSON.stringify(name === "./ledger-scheduler-schema.js" ? schemaPath : join(import.meta.dir, "../src/lib", name))}`);
  writeFileSync(storePath, source);
  const script = `const s = await import(${JSON.stringify(storePath)}); s.openLedger(${JSON.stringify(path)}); s.closeLedger(${JSON.stringify(path)});`;
  const result = Bun.spawnSync([process.execPath, "--no-env-file", "--config=/dev/null", "-e", script], {
    env: { ...process.env, CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime") }, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function task(db: Database, id: string, stage = "review") {
  createTask(db, owner, { project: "p", id, title: id, kind: "code" });
  db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
}
function intent(db: Database, id: string, taskId: string, action = "dispatch", status = "done") {
  db.query(`INSERT INTO scheduler_intents
    (id,taskId,project,node,action,causalSeq,taskRev,specRev,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,'p','write',?,0,1,1,2,?,'test',0,0)`).run(id, taskId, action, status);
}
function lock(db: Database, taskId: string, intentId: string, resource: string, scope = "card") {
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt,scope) VALUES ('p',?,?,?,?,?)")
    .run(resource, taskId, intentId, 7, scope);
}
const rows = (db: Database, taskId: string) => db.query("SELECT * FROM scheduler_resources WHERE taskId = ? ORDER BY resource").all(taskId);
const business = (db: Database) => ["tasks", "events", "scheduler_intents", "scheduler_resources"]
  .map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());

function seedCleanup(db: Database) {
  for (const [id, stage] of [["A", "spec"], ["B", "review"], ["C", "review"], ["D", "done"], ["E", "done"], ["W", "done"]]) {
    task(db, id, stage);
    if (id !== "A") intent(db, `center:${id}`, id, "dispatch", id === "W" ? "submitted" : "done");
  }
  for (const id of ["B", "C"]) lock(db, id, `center:${id}`, `slot:${id}`);
  for (const id of ["D", "E", "W"]) lock(db, id, `center:${id}`, `${id}.ts`);
  setWorkflow(db, owner, { taskId: "A", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "wait" });
}

async function realCleanup(db: Database) {
  const planned = planIntent(db, scheduler, { id: "ensure:A", taskId: "A", taskRev: getTask(db, "A")!.rev,
    workflowRev: getWorkflow(db, "A")!.rev, causalSeq: (db.query("SELECT MAX(seq) AS seq FROM events").get() as { seq: number }).seq,
    node: "write", action: "ensure_session", reason: "test", resources: ["task:A"] });
  expect(planned.intent.action).toBe("ensure_session");
  // No sessions/candidate effects: the real retire entry still runs project-wide reconciliation and stranded-lock release.
  const config = { projects: { p: { repo: "/synthetic", requiredChecks: [] } } } as unknown as SchedulerConfig;
  expect(await retireStep(db, config, async () => { throw new Error("unexpected external command"); }, () => {}, undefined)).toEqual([]);
  settleIntent(db, scheduler, { id: "ensure:A", from: "pending", to: "submitted" });
  settleIntent(db, scheduler, { id: "ensure:A", from: "submitted", to: "done" });
  expect(rows(db, "A")).toEqual([]);
}

for (const legacy of [false, true]) {
  test(`${legacy ? "v23 upgrade" : "fresh"}: real cross-card plan, retireStep and settle preserve projection resources`, async () => {
    const f = fixture(legacy); seedCleanup(f.db);
    let db = f.db;
    const before = business(db);
    if (legacy) { db.close(); db = openLedger(f.path); expect(business(db)).toEqual(before); }
    guardProjectionTasks(db, ["B", "D", "W"], []);
    const protectedRows = ["B", "D", "W"].map((id) => rows(db, id));
    await realCleanup(db);
    expect(["B", "D", "W"].map((id) => rows(db, id))).toEqual(protectedRows);
    expect(rows(db, "C")).toEqual([]); expect(rows(db, "E")).toEqual([]);
    expect(db.query("SELECT status FROM scheduler_intents WHERE id = 'center:W'").get()).toEqual({ status: "submitted" });
    releaseFinishedCardLeases(db, "W");
    expect(rows(db, "W")).toEqual(protectedRows[2]);
  });
}

test("regression control: no guard lets real project-wide cleanup delete another card's locks", async () => {
  const f = fixture(); seedCleanup(f.db);
  await realCleanup(f.db);
  expect(rows(f.db, "B")).toEqual([]); expect(rows(f.db, "D")).toEqual([]);
});

test("guard silently ignores each protected DELETE/UPDATE row and permits local intent locks", () => {
  const { db } = fixture();
  for (const id of ["B", "C"]) { task(db, id); intent(db, `center:${id}`, id); lock(db, id, `center:${id}`, `slot:${id}`); }
  guardProjectionTasks(db, ["B"], []);
  const before = rows(db, "B");
  expect(db.query("UPDATE scheduler_resources SET acquiredAt = 9").run().changes).toBe(1);
  expect(rows(db, "B")).toEqual(before);
  expect(db.query("DELETE FROM scheduler_resources").run().changes).toBe(1);
  expect(rows(db, "B")).toEqual(before); expect(rows(db, "C")).toEqual([]);
  expect(db.query("DELETE FROM scheduler_resources WHERE taskId = 'B'").run().changes).toBe(0);
  expect(db.query("UPDATE scheduler_resources SET taskId = 'C' WHERE taskId = 'B'").run().changes).toBe(0);
  for (const action of ["ensure_session", "retire"]) {
    intent(db, `local:${action}`, "B", action, "submitted"); lock(db, "B", `local:${action}`, `task:${action}`, "intent");
    settleIntent(db, scheduler, { id: `local:${action}`, from: "submitted", to: "done" });
    expect(rows(db, "B")).toEqual(before);
  }
});

test("projection writer is transactional, nested, and leaves no privilege after success or throw", () => {
  const { db } = fixture(); task(db, "B"); intent(db, "center:B", "B"); lock(db, "B", "center:B", "slot:B");
  guardProjectionTasks(db, ["B", "B"], []); const before = rows(db, "B");
  expect(isProjectionGuarded(db, "B")).toBe(true); expect(isProjectionGuarded(db, "missing")).toBe(false);
  expect(() => withProjectionWriter(db, () => { db.query("DELETE FROM scheduler_resources").run(); throw new Error("rollback"); })).toThrow("rollback");
  expect(rows(db, "B")).toEqual(before); expect(db.query("SELECT * FROM v2_projection_writer").all()).toEqual([]);
  withProjectionWriter(db, () => {
    withProjectionWriter(db, () => expect(db.query("SELECT * FROM v2_projection_writer").all()).toHaveLength(2));
    expect(db.query("SELECT * FROM v2_projection_writer").all()).toHaveLength(1);
    expect(db.query("UPDATE scheduler_resources SET acquiredAt = 9").run().changes).toBe(1);
    expect(db.query("DELETE FROM scheduler_resources").run().changes).toBe(1);
  });
  expect(rows(db, "B")).toEqual([]); expect(db.query("SELECT * FROM v2_projection_writer").all()).toEqual([]);
  expect(() => withProjectionWriter(db, () => Promise.resolve())).toThrow("synchronous");
  expect(db.query("SELECT * FROM v2_projection_writer").all()).toEqual([]);
  guardProjectionTasks(db, [], ["B"]); expect(isProjectionGuarded(db, "B")).toBe(false);
});

test("v23 has no guard: appended migration adds exactly one version and preserves every old business field", () => {
  const f = fixture(true); seedCleanup(f.db);
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'v2_projection_%'").all()).toEqual([]);
  const before = business(f.db); f.db.close();
  const db = openLedger(f.path);
  expect(LEDGER_SCHEMA_VERSION).toBe(24); expect(schemaVersion(db)).toBe(24); expect(business(db)).toEqual(before);
  expect(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'v2_projection_%'").all()).toHaveLength(4);
  expect(db.query("PRAGMA table_info(v2_projection_guard)").all().map((c: any) => c.name)).toEqual(["taskId"]);
  expect(db.query("PRAGMA table_info(v2_projection_writer)").all().map((c: any) => c.name)).toEqual(["token"]);
  guardProjectionTasks(db, ["B"], []); installProjectionGuard(db); installProjectionGuard(db);
  expect(business(db)).toEqual(before); expect(isProjectionGuarded(db, "B")).toBe(true);
  closeLedger(f.path); const reopened = openLedger(f.path);
  expect(schemaVersion(reopened)).toBe(24); expect(business(reopened)).toEqual(before); expect(isProjectionGuarded(reopened, "B")).toBe(true);
});

test("first connection repairs missing triggers; cache identity is retained", () => {
  const f = fixture(); task(f.db, "B"); guardProjectionTasks(f.db, ["B"], []);
  for (const t of PROJECTION_GUARD_TRIGGER_DDL) f.db.query(`DROP TRIGGER ${t.name}`).run();
  expect(openLedger(f.path)).toBe(f.db);
  closeLedger(f.path); const db = openLedger(f.path);
  expect(db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'v2_projection_%'").all()).toHaveLength(2);
  expect(isProjectionGuarded(db, "B")).toBe(true);
});

test("missing guard tables are restored only after close/open without altering business rows", () => {
  const f = fixture(); task(f.db, "B"); const before = business(f.db);
  f.db.query("DROP TABLE v2_projection_guard").run(); f.db.query("DROP TABLE v2_projection_writer").run();
  closeLedger(f.path);
  // Dangling triggers make the old schema repair fail before its updates; rejection is a safe recovery outcome.
  expect(() => openLedger(f.path)).toThrow("no such table: main.v2_projection_guard");
  const raw = new Database(f.path); expect(business(raw)).toEqual(before);
  installProjectionGuard(raw); raw.close();
  const db = openLedger(f.path);
  expect(business(db)).toEqual(before); expect(isProjectionGuarded(db, "B")).toBe(false);
});

for (const legacy of [false, true]) for (const wrongTarget of [false, true]) {
  test(`forged trigger fails closed and rolls back repair (v23=${legacy}, wrongTarget=${wrongTarget})`, () => {
    const f = fixture(legacy); installProjectionGuard(f.db); task(f.db, "B"); intent(f.db, "center:B", "B"); lock(f.db, "B", "center:B", "slot:B");
    guardProjectionTasks(f.db, ["B"], []); const before = business(f.db);
    for (const t of PROJECTION_GUARD_TRIGGER_DDL) f.db.query(`DROP TRIGGER ${t.name}`).run();
    f.db.query(`CREATE TRIGGER ${PROJECTION_GUARD_TRIGGER_DDL[0].name} BEFORE DELETE ON ${wrongTarget ? "tasks" : "scheduler_resources"}
      BEGIN SELECT 1; END`).run();
    if (legacy) f.db.close(); else closeLedger(f.path);
    expect(() => openLedger(f.path)).toThrow("Invalid projection guard trigger");
    const raw = new Database(f.path);
    expect(business(raw)).toEqual(before); expect(isProjectionGuarded(raw, "B")).toBe(true);
    expect(schemaVersion(raw)).toBe(legacy ? 23 : 24);
    expect(raw.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(PROJECTION_GUARD_TRIGGER_DDL[1].name)).toBeNull();
    raw.query(`DROP TRIGGER ${PROJECTION_GUARD_TRIGGER_DDL[0].name}`).run(); raw.close();
    expect(isProjectionGuarded(openLedger(f.path), "B")).toBe(true);
  });
}

test("installer never clears guard or writer rows; DDL uses individual prepared statements", () => {
  const { db } = fixture(); task(db, "B"); guardProjectionTasks(db, ["B"], []);
  db.query("INSERT INTO v2_projection_writer VALUES ('preexisting')").run();
  expect(() => installProjectionGuard(db)).toThrow("Projection writer must be empty");
  expect(db.query("SELECT * FROM v2_projection_writer").all()).toEqual([{ token: "preexisting" }]);
  expect(isProjectionGuarded(db, "B")).toBe(true); expect(PROJECTION_GUARD_DDL).toHaveLength(4);
  expect(PROJECTION_GUARD_TABLE_DDL).toHaveLength(2);
});

test("writer residue rejects reopening without clearing rows or caching the failed connection", () => {
  const f = fixture(); task(f.db, "B"); intent(f.db, "center:B", "B"); lock(f.db, "B", "center:B", "slot:B");
  guardProjectionTasks(f.db, ["B"], []); const before = business(f.db);
  f.db.query("INSERT INTO v2_projection_writer VALUES ('residue')").run();
  f.db.query(`DROP TRIGGER ${PROJECTION_GUARD_TRIGGER_DDL[1].name}`).run();
  closeLedger(f.path);
  expect(() => openLedger(f.path)).toThrow("Projection writer must be empty");
  const raw = new Database(f.path);
  expect(business(raw)).toEqual(before); expect(isProjectionGuarded(raw, "B")).toBe(true);
  expect(raw.query("SELECT * FROM v2_projection_writer").all()).toEqual([{ token: "residue" }]);
  expect(raw.query("SELECT name FROM sqlite_master WHERE name = ?").get(PROJECTION_GUARD_TRIGGER_DDL[1].name)).toBeNull();
  raw.query("DELETE FROM v2_projection_writer").run(); raw.close();
  const reopened = openLedger(f.path);
  expect(reopened.query("DELETE FROM scheduler_resources WHERE taskId = 'B'").run().changes).toBe(0);
  expect(business(reopened)).toEqual(before);
});

for (const [table, column] of [["v2_projection_guard", "taskId"], ["v2_projection_writer", "token"]]) {
  test(`a same-name ${table} view is rejected without changing business rows`, () => {
    const f = fixture(); task(f.db, "B"); intent(f.db, "center:B", "B"); lock(f.db, "B", "center:B", "slot:B");
    const before = business(f.db);
    f.db.query(`DROP TABLE ${table}`).run();
    f.db.query(`CREATE VIEW ${table} AS SELECT 'B' AS ${column}`).run();
    expect(() => installProjectionGuard(f.db)).toThrow(`Invalid projection guard table: ${table}`);
    expect(business(f.db)).toEqual(before);
    closeLedger(f.path); expect(() => openLedger(f.path)).toThrow();
    const raw = new Database(f.path);
    try {
      expect(business(raw)).toEqual(before);
      expect(raw.query("SELECT type FROM sqlite_master WHERE name = ?").get(table)).toEqual({ type: "view" });
      expect(raw.query(`SELECT * FROM ${table}`).all()).toEqual([{ [column]: "B" }]);
    } finally { raw.close(); }
  });
}

test("raw connection without scheduler schema retains the no-op lease release", () => {
  const db = new Database(":memory:");
  try {
    expect(isProjectionGuarded(db, "B")).toBe(false);
    expect(() => releaseFinishedCardLeases(db, "B")).not.toThrow();
    expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]);
  } finally { db.close(); }
});

test("raw v23 connection without guards retains real slot, finished-card and stranded-lock cleanup", async () => {
  const f = fixture(true);
  try {
    seedCleanup(f.db);
    await realCleanup(f.db);
    for (const id of ["B", "C", "D", "E"]) expect(rows(f.db, id)).toEqual([]);
    task(f.db, "F", "done"); intent(f.db, "center:F", "F"); lock(f.db, "F", "center:F", "F.ts");
    releaseFinishedCardLeases(f.db, "F"); expect(rows(f.db, "F")).toEqual([]);
    expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'v2_projection_%'").all()).toEqual([]);
  } finally { f.db.close(); }
});


test("regression control: modifying only migration seven leaves an existing v23 ledger unguarded", () => {
  const f = fixture(true), steps = [...LEDGER_MIGRATIONS.slice(0, -1)], old = steps[6];
  steps[6] = (db) => {
    if (typeof old === "function") old(db); else for (const sql of old) db.prepare(sql).run();
    installProjectionGuard(db);
  };
  runMigrations(f.db, { label: "old-step-only", migrations: steps, tables: ["tasks", "events"] });
  expect(schemaVersion(f.db)).toBe(23);
  expect(f.db.query("SELECT name FROM sqlite_master WHERE name LIKE 'v2_projection_%'").all()).toEqual([]);
  f.db.close();
});
