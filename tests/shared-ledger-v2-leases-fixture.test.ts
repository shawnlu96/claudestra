import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  createTransactionOwner, fail, parseActor, parseFeature, parseGeneration, parseTask,
  type V2TransactionContext, type V2TransactionBackend, type V2TransactionScope, type V2Statement,
} from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES, V2_FIXTURE_FENCE, V2_FIXTURE_SCOPE } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { createLeaseDomain } from "../src/shared-ledger/leases/domain";
import { createGenerationDomain } from "../src/shared-ledger/leases/generation";
import { leaseSchema, leaseStatements } from "../src/shared-ledger/leases/schema";
import type { LeaseCommand } from "../src/shared-ledger/leases/types";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const scoped = "teamId = $teamId AND projectId = $projectId";
const fixtureStatements: Record<string, V2Statement> = {
  "fixture.get": { mode: "read", sql: `SELECT data FROM fixture_rows WHERE ${scoped} AND kind = $kind AND id = $id` },
  "fixture.put": { mode: "write", sql: `INSERT INTO fixture_rows (teamId, projectId, kind, id, data)
    VALUES ($teamId, $projectId, $kind, $id, $data) ON CONFLICT (teamId, projectId, kind, id) DO UPDATE SET data = excluded.data` },
  "fixture.tasks": { mode: "read", sql: `SELECT id, data FROM fixture_rows WHERE ${scoped} AND kind = 'task'` },
};
export const baseScope: V2TransactionScope = { ...V2_FIXTURE_SCOPE, ...V2_FIXTURE_FENCE, now: 1000,
  actor: parseActor({ ...parseActor(V2_DTO_FIXTURES.actor.valid), actions: ["lease.acquire", "lease.renew", "lease.release", "home.change"] }),
};
export function setupLeaseTest(options: { leaseMs?: number; renewMs?: number } = {}) {
  const db = new Database(":memory:"); databases.push(db);
  const statements = { ...leaseStatements, ...fixtureStatements };
  const owner = createTransactionOwner(db as unknown as V2TransactionBackend, statements, { ...leaseSchema,
    "fixture.schema": `CREATE TABLE fixture_rows (teamId TEXT, projectId TEXT, kind TEXT, id TEXT, data TEXT,
      PRIMARY KEY (teamId, projectId, kind, id))`,
  });
  const get = (ctx: V2TransactionContext, kind: string, id: string) => {
    const row = ctx.all("fixture.get", { kind, id })[0] as { data: string } | undefined;
    if (!row) fail("not_found");
    return JSON.parse(row.data);
  };
  const put = (ctx: V2TransactionContext, kind: string, id: string, data: unknown) =>
    ctx.run("fixture.put", { kind, id, data: JSON.stringify(data) });
  const domain = createLeaseDomain({
    readTask: (ctx, id) => get(ctx, "task", id), readFeature: (ctx, id) => get(ctx, "feature", id),
    workflowRev: (ctx, id) => get(ctx, "workflow", id).rev,
    advanceFeature(ctx, previous, epoch, homeInstanceId) {
      const current = parseFeature(get(ctx, "feature", previous.id));
      if (current.epoch !== previous.epoch || current.rev !== previous.rev) fail("conflict");
      put(ctx, "feature", previous.id, { ...current, epoch, homeInstanceId, updatedAt: ctx.scope.now });
      if (homeInstanceId !== current.homeInstanceId) {
        for (const row of ctx.all("fixture.tasks") as { id: string; data: string }[]) {
          const task = parseTask(JSON.parse(row.data));
          if (task.featureId === current.id) put(ctx, "task", row.id, { ...task, homeInstanceId });
        }
      }
    },
    assertHomeAuthorization(ctx, command) {
      const approved = get(ctx, "approval", command.payload.authorizationAskId);
      if (approved.owner !== ctx.scope.actor.personId || approved.home !== command.payload.nextHomeInstanceId) fail("forbidden");
    },
    settlement: (ctx, featureId) => get(ctx, "settlement", featureId),
  }, options);
  const recovery = { highWater: 0, authorized: true, reconciled: true };
  const generation = createGenerationDomain({
    assertRecoveryAuthorized() { if (!recovery.authorized) fail("forbidden"); },
    generationHighWater: () => recovery.highWater,
    reserveGeneration(_ctx, expected, next) {
      if (recovery.highWater !== expected) fail("stale_generation");
      recovery.highWater = next;
    },
    assertRestoreReconciled() { if (!recovery.reconciled) fail("unknown_operation"); },
  });
  function transact<T>(fn: (ctx: V2TransactionContext) => T, overrides: Partial<V2TransactionScope> = {}): T {
    return db.transaction(() => owner.inCallerTransaction({ ...baseScope, ...overrides }, Object.keys(statements), fn))();
  }
  function seed(overrides: Partial<V2TransactionScope> = {}) {
    transact(ctx => {
      put(ctx, "feature", "feature", { ...parseFeature(V2_DTO_FIXTURES.feature.valid),
        teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, authorityMode: "execution" });
      put(ctx, "task", "task", { ...parseTask(V2_DTO_FIXTURES.task.valid), teamId: ctx.scope.teamId, projectId: ctx.scope.projectId });
      put(ctx, "workflow", "task", { rev: 1 });
      put(ctx, "settlement", "feature", { workersSettled: true, lendSettled: true, unknownCount: 0 });
      put(ctx, "approval", "approval", { owner: "person", home: "peer-a" });
    }, overrides);
  }
  db.transaction(() => owner.installSchema(ctx => { domain.installSchema(ctx); ctx.install("fixture.schema"); }))();
  transact(ctx => generation.initialize(ctx, parseGeneration(V2_DTO_FIXTURES.generation.valid)));
  seed();
  function command(type: LeaseCommand["type"], payload: Record<string, unknown> = {}, overrides: Partial<V2TransactionScope> = {}): LeaseCommand {
    const s = { ...baseScope, ...overrides };
    const bodies = {
      "lease.acquire": { taskId: "task", expectedRev: 1, expectedSpecRev: 1, expectedWorkflowRev: 1, homeInstanceId: "local" },
      "lease.renew": { taskId: "task", homeInstanceId: "local" },
      "lease.release": { taskId: "task", reason: "cancel" },
      "home.change": { featureId: "feature", expectedRev: 1, nextEpoch: s.epoch + 1, nextHomeInstanceId: "peer-a",
        authorizationAskId: "approval", oldHomeStopped: true, workersSettled: true, lendSettled: true, unknownReconciled: true },
    };
    return { teamId: s.teamId, projectId: s.projectId, serviceGeneration: s.serviceGeneration, epoch: s.epoch, bootId: s.bootId,
      requestId: "request", type, payload: { ...bodies[type], ...payload } } as LeaseCommand;
  }
  const apply = (type: LeaseCommand["type"], payload: Record<string, unknown> = {}, overrides: Partial<V2TransactionScope> = {}) =>
    transact(ctx => domain.applyInTransaction(ctx, command(type, payload, overrides)), overrides);
  return { db, owner, domain, generation, recovery, transact, command, apply, get, put, seed };
}
test("lease module installs through the frozen transaction contract", () => {
  const h = setupLeaseTest();
  expect(h.domain.policy).toEqual({ leaseMs: 60000, renewMs: 15000 });
  expect(h.db.inTransaction).toBe(false);
});
