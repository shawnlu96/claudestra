import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  createTransactionOwner, assertTransactionContext, type V2TransactionContext, type V2SchemaContext,
  type V2DomainModule, type V2TransactionScope, type V2TransactionBackend, V2ContractError,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures";
const scope: V2TransactionScope = {
  ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 1000,
  actor: { kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
    orderId: null, projects: ["project"], actions: ["task.set"] },
};
const names = ["task.put", "task.read", "ask.put"];
function setup() {
  const db = new Database(":memory:");
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, {
    "task.put": { mode: "write", sql: "INSERT INTO tasks (teamId, projectId, id) VALUES ($teamId, $projectId, $id)" },
    "task.read": { mode: "read", sql: "SELECT id FROM tasks WHERE teamId = $teamId AND projectId = $projectId" },
    "ask.put": { mode: "write", sql: "INSERT INTO asks (teamId, projectId, id) VALUES ($teamId, $projectId, $id)" },
  }, {
    "task.schema": "CREATE TABLE IF NOT EXISTS tasks (teamId TEXT, projectId TEXT, id TEXT PRIMARY KEY)",
    "ask.schema": "CREATE TABLE IF NOT EXISTS asks (teamId TEXT, projectId TEXT, id TEXT PRIMARY KEY)",
  });
  const domain = (prefix: "task" | "ask"): V2DomainModule<string, number> => ({
    installSchema(context) { context.install(`${prefix}.schema`); },
    applyInTransaction(context, id) { assertTransactionContext(context); return context.run(`${prefix}.put`, { id }); },
  });
  const task = domain("task"), ask = domain("ask");
  db.transaction(() => owner.installSchema(context => { task.installSchema(context); ask.installSchema(context); }))();
  return { db, owner, task, ask };
}
test("schema and domain writes require a caller-owned transaction", () => {
  const { db, owner, task } = setup();
  try {
    expect(() => owner.inCallerTransaction(scope, names, context => task.applyInTransaction(context, "x"))).toThrow("transaction_required");
    expect(() => owner.installSchema(() => {})).toThrow("transaction_required");
    expect(() => assertTransactionContext({ assertActive() {} } as V2TransactionContext)).toThrow("transaction_required");
    expect(db.inTransaction).toBe(false);
  } finally { db.close(); }
});
test("multiple domain writes commit once or roll back together with caller", () => {
  const { db, owner, task, ask } = setup();
  try {
    expect(() => db.transaction(() => owner.inCallerTransaction(scope, names, context => {
      task.applyInTransaction(context, "task"); ask.applyInTransaction(context, "ask"); throw new Error("receipt failed");
    }))()).toThrow("receipt failed");
    expect(db.query("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM asks").get()).toEqual({ n: 0 });
    db.transaction(() => owner.inCallerTransaction(scope, names, context => {
      expect(db.inTransaction).toBe(true);
      expect(task.applyInTransaction(context, "task")).toBe(1);
      expect(ask.applyInTransaction(context, "ask")).toBe(1);
      expect(context.all("task.read")).toEqual([{ id: "task" }]);
      expect(db.inTransaction).toBe(true);
    }))();
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM asks").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});
test("context exposes no submit/raw handle; SQL control strings are not registered operations", () => {
  const { db, owner } = setup();
  try {
    db.transaction(() => owner.inCallerTransaction(scope, names, context => {
      expect(Object.keys(context).sort()).toEqual(["all", "assertActive", "run", "scope"]);
      for (const name of ["COMMIT", "BEGIN", "ROLLBACK", "task.put; COMMIT", "ask.schema", "unknown"]) {
        expect(() => context.run(name)).toThrow("forbidden");
      }
      expect(() => context.all("task.put")).toThrow("forbidden");
      expect(() => context.run("task.read")).toThrow("forbidden");
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.scope.actor.projects)).toBe(true);
      // @ts-expect-error A domain cannot commit the opaque caller transaction.
      const commit = context.commit;
      // @ts-expect-error No raw database handle can be used to bypass statement grants.
      const database = context.database;
      expect(commit).toBeUndefined(); expect(database).toBeUndefined();
    }))();
  } finally { db.close(); }
});
test("leaked contexts stay expired inside a later transaction or after errors", () => {
  const { db, owner } = setup();
  let leaked!: V2TransactionContext, schema!: V2SchemaContext;
  try {
    db.transaction(() => {
      owner.inCallerTransaction(scope, names, context => { leaked = context; });
      owner.installSchema(context => { schema = context; });
      expect(() => leaked.run("task.put", { id: "x" })).toThrow("transaction_closed");
      expect(() => schema.install("task.schema")).toThrow("transaction_closed");
    })();
    db.transaction(() => expect(() => assertTransactionContext(leaked)).toThrow("transaction_closed"))();
    expect(() => db.transaction(() => owner.inCallerTransaction(scope, names, context => {
      leaked = context; throw Error("domain failed");
    }))()).toThrow("domain failed");
    expect(() => leaked.assertActive()).toThrow("transaction_closed");
  } finally { db.close(); }
});
test("statement grants and implicit scope cannot be overridden by domains", () => {
  const { db, owner } = setup();
  try {
    db.transaction(() => owner.inCallerTransaction(scope, ["task.put", "task.read"], context => {
      expect(() => context.run("ask.put", { id: "ask" })).toThrow("forbidden");
      for (const key of ["teamId", "projectId", "epoch", "serviceGeneration", "bootId"]) {
        expect(() => context.run("task.put", { id: "x", [key]: "other" })).toThrow("forbidden");
      }
      expect(() => context.run("task.put")).toThrow("invalid_field");
      expect(() => context.run("task.put", { id: "x", unknown: "hidden" })).toThrow("invalid_field");
      context.run("task.put", { id: "x" });
    }))();
    const other = { ...scope, projectId: "other", actor: { ...scope.actor, projects: ["other"] } };
    db.transaction(() => owner.inCallerTransaction(other, ["task.read"], context => expect(context.all("task.read")).toEqual([])))();
    expect(() => db.transaction(() => owner.inCallerTransaction({ ...scope, projectId: "other" }, names, () => {}))()).toThrow("forbidden");
  } finally { db.close(); }
});
test("audit/fence parameters are injected from immutable trusted scope", () => {
  const db = new Database(":memory:");
  try {
    const owner = createTransactionOwner(db as unknown as V2TransactionBackend, {
      "audit.read": { mode: "read", sql: "SELECT $teamId AS teamId, $projectId AS projectId, $epoch AS epoch, $bootId AS bootId, $personId AS personId" },
    });
    db.transaction(() => owner.inCallerTransaction(scope, ["audit.read"], context => {
      expect(context.all("audit.read")).toEqual([{ teamId: "team", projectId: "project", epoch: 1, bootId: "boot-local", personId: "person" }]);
      expect(() => context.all("audit.read", { personId: "owner" })).toThrow("forbidden");
    }))();
  } finally { db.close(); }
});
test("owner rejects SQL controls, connection escapes, unscoped and multi-statement registration", () => {
  const db = new Database(":memory:");
  try {
    for (const sql of ["COMMIT", "BEGIN", "ROLLBACK", "SAVEPOINT s", "RELEASE s", "ATTACH 'x' AS y", "PRAGMA writable_schema=1",
      "SELECT $teamId, $projectId; COMMIT", "SELECT $teamId, $projectId -- comment", "SELECT /*comment*/ $teamId, $projectId", "SELECT 1"]) {
      expect(() => createTransactionOwner(db as unknown as V2TransactionBackend, { query: { sql, mode: "read" } })).toThrow("transaction_control");
    }
    expect(() => createTransactionOwner(db as unknown as V2TransactionBackend, {}, { bad: "DROP TABLE tasks" })).toThrow("transaction_control");
  } finally { db.close(); }
});
test("async domain work cannot outlive the caller transaction", () => {
  const { db, owner } = setup();
  let leaked!: V2TransactionContext;
  try {
    expect(() => db.transaction(() => owner.inCallerTransaction(scope, names, context => {
      leaked = context; return Promise.resolve(1);
    }))()).toThrow("transaction_control");
    expect(() => leaked.assertActive()).toThrow(V2ContractError);
  } finally { db.close(); }
});
test("schema installation supports immutable triggers without permitting transaction controls", () => {
  const db = new Database(":memory:");
  try {
    const backend = db as unknown as V2TransactionBackend;
    const owner = createTransactionOwner(backend, {}, {
      table: "CREATE TABLE artifacts (id TEXT PRIMARY KEY)",
      immutable: "CREATE TRIGGER artifact_immutable BEFORE UPDATE ON artifacts BEGIN SELECT RAISE(ABORT, 'immutable artifact'); END",
    });
    db.transaction(() => owner.installSchema(context => { context.install("table"); context.install("immutable"); }))();
    db.run("INSERT INTO artifacts VALUES ('artifact')");
    expect(() => db.run("UPDATE artifacts SET id = 'other'")).toThrow("immutable artifact");
    for (const suffix of ["; COMMIT", "; CREATE TABLE escape (id TEXT)"]) {
      expect(() => createTransactionOwner(backend, {}, {
        bad: "CREATE TRIGGER bad BEFORE UPDATE ON artifacts BEGIN SELECT 1; END" + suffix,
      })).toThrow("transaction_control");
    }
  } finally { db.close(); }
});
