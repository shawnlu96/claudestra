import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { V2_COMMAND_FIXTURES, V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { parseCommand } from "../src/lib/shared-ledger-contract-v2-commands.js";
import { parseActor } from "../src/lib/shared-ledger-contract-v2-transfer.js";
import { parseTask, parseWorkflow, parseStep, type V2Step } from "../src/lib/shared-ledger-contract-v2-tasks.js";
import { parseFeature } from "../src/lib/shared-ledger-contract-v2-dag.js";
import {
  createTransactionOwner, type V2Statement, type V2TransactionBackend, type V2TransactionContext, type V2TransactionScope,
} from "../src/lib/shared-ledger-contract-v2-transaction.js";
import { fail } from "../src/lib/shared-ledger-contract-v2-validation.js";
import { createLendDomain } from "../src/shared-ledger/lend/index.js";
import type { LendCommand, LendPorts } from "../src/shared-ledger/lend/checks.js";
import { lendSchema, lendStatements, readLendRow } from "../src/shared-ledger/lend/storage.js";

export const H = "b".repeat(40), H2 = "c".repeat(40), D = "a".repeat(64);
export const worker = { kind: "peer_agent" as const, instanceId: "peer-a", agentId: "worker" };
const where = "team_id = $teamId AND project_id = $projectId";
const fixtureSchema = {
  entities: `CREATE TABLE entities (team_id TEXT, project_id TEXT, kind TEXT, id TEXT, body TEXT,
    PRIMARY KEY(team_id, project_id, kind, id))`,
  events: "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, project_id TEXT, body TEXT)",
  receipts: "CREATE TABLE receipts (team_id TEXT, project_id TEXT, request_id TEXT, body TEXT)",
};
const fixtureStatements: Record<string, V2Statement> = {
  "entity.read": { mode: "read", sql: `SELECT body FROM entities WHERE ${where} AND kind = $kind AND id = $id` },
  "entity.insert": { mode: "write", sql: `INSERT INTO entities VALUES ($teamId, $projectId, $kind, $id, $body)` },
  "entity.update": { mode: "write", sql: `UPDATE entities SET body = $body WHERE ${where} AND kind = $kind AND id = $id AND body = $previous` },
  "event.insert": { mode: "write", sql: "INSERT INTO events (team_id, project_id, body) VALUES ($teamId, $projectId, $body)" },
  "event.seq": { mode: "read", sql: `SELECT max(seq) AS seq FROM events WHERE ${where}` },
  "receipt.insert": { mode: "write", sql: "INSERT INTO receipts VALUES ($teamId, $projectId, $requestId, $body)" },
};
function entity(context: V2TransactionContext, kind: string, id: string): unknown {
  const row = context.all("entity.read", { kind, id })[0] as { body: string } | undefined;
  if (!row) fail("not_found");
  return JSON.parse(row.body);
}
const stepId = (s: { taskId: string; step: string; round: number }) => `${s.taskId}:${s.step}:${s.round}`;
function stepPort(context: V2TransactionContext, old: V2Step | null, next: V2Step): void {
  const common = { kind: "step", id: stepId(next), body: JSON.stringify(next) };
  const n = old ? context.run("entity.update", { ...common, previous: JSON.stringify(old) }) : context.run("entity.insert", common);
  if (n !== 1) fail("conflict");
}
export function command(type: LendCommand["type"], payload: Record<string, unknown> = {}): LendCommand {
  const c = structuredClone(V2_COMMAND_FIXTURES.find(c => c.type === type)!.valid);
  return parseCommand({ ...c, payload: { ...c.payload, ...payload } }) as LendCommand;
}
export function harness(step: "write" | "review" | "fix" = "review", db = new Database(":memory:")) {
  const allStatements = { ...lendStatements, ...fixtureStatements }, names = Object.keys(allStatements);
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, allStatements, { ...lendSchema, ...fixtureSchema });
  const scope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 2000,
    actor: parseActor({ ...V2_DTO_FIXTURES.actor.valid as object,
      actions: ["lend.create", "lend.claim", "lend.renew", "lend.result", "lend.cancel", "migration.commit"] }) };
  const faults = { authorization: false, imported: false, event: false, receipt: false, step: false };
  const ports: LendPorts = {
    loadExecution: c => ({ task: parseTask(entity(c, "task", "task")), workflow: parseWorkflow(entity(c, "workflow", "task")),
      feature: parseFeature(entity(c, "feature", "feature")) }),
    authorize() { if (faults.authorization) fail("authorization_expired"); },
    authorizeImport() { if (faults.imported) fail("migration_blocked"); },
    readStep(c, o) {
      const row = c.all("entity.read", { kind: "step", id: stepId(o) })[0] as { body: string } | undefined;
      return row ? parseStep(JSON.parse(row.body)) : null;
    },
    writeStep(c, old, next) { stepPort(c, old, next); if (faults.step) fail("conflict"); },
    appendEvent(c, cmd, order) {
      c.run("event.insert", { body: JSON.stringify({ command: cmd.type, orderId: order.orderId }) });
      if (faults.event) fail("unavailable");
      return (c.all("event.seq")[0] as { seq: number }).seq;
    },
  };
  const domain = createLendDomain(ports);
  db.transaction(() => owner.installSchema(c => {
    Object.keys(fixtureSchema).forEach(name => c.install(name)); domain.installSchema(c);
  }))();
  const within = <T>(fn: (c: V2TransactionContext) => T, override: Partial<V2TransactionScope> = {}): T =>
    db.transaction(() => owner.inCallerTransaction({ ...scope, ...override }, names, fn))();
  const set = (kind: string, value: unknown, id = kind === "feature" ? "feature" : "task") => {
    db.query("INSERT OR REPLACE INTO entities VALUES (?, ?, ?, ?, ?)").run(scope.teamId, scope.projectId, kind, id, JSON.stringify(value));
  };
  set("task", parseTask({ ...V2_DTO_FIXTURES.task.valid as object, stage: step === "write" ? "build" : step }));
  set("feature", parseFeature({ ...V2_DTO_FIXTURES.feature.valid as object, authorityMode: "execution" }));
  set("workflow", parseWorkflow(V2_DTO_FIXTURES.workflow.valid));
  const read = (kind: string, id = kind === "feature" ? "feature" : "task") => within(c => entity(c, kind, id)) as Record<string, unknown>;
  const apply = (cmd: LendCommand, override: Partial<V2TransactionScope> = {}) => within(c => {
    const out = domain.applyInTransaction(c, cmd);
    c.run("receipt.insert", { requestId: cmd.requestId, body: JSON.stringify(out) });
    if (faults.receipt) fail("unavailable");
    return out;
  }, override);
  const create = () => apply(command("lend.create", { step, ...(step === "review" ? {} : { branch: "lend/task", base: "main" }) })).order;
  const claim = (orderId: string) => apply(command("lend.claim", { claim: { ...V2_DTO_FIXTURES.lendClaim.valid as object, orderId } }));
  const result = (orderId: string, patch: Record<string, unknown> = {}) => command("lend.result", {
    result: { ...V2_DTO_FIXTURES.lendResult.valid as object, orderId, ...patch },
  });
  const order = (orderId: string) => within(c => readLendRow(c, "order", orderId))!;
  const count = (table: string) => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  const connect = (other: Database) => createTransactionOwner(other as unknown as V2TransactionBackend, allStatements);
  return { db, scope, owner, names, domain, ports, faults, within, set, read, apply, create, claim, result, order, count, connect };
}

test("lend schema and named statements install in caller-owned SQLite transaction", () => {
  const h = harness();
  try {
    expect(h.db.inTransaction).toBe(false);
    expect(h.count("v2_lend_orders")).toBe(0);
    expect(() => h.owner.installSchema(h.domain.installSchema)).toThrow("transaction_required");
  } finally { h.db.close(); }
});
