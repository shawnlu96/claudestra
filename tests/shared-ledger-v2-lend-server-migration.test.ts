import { expect, test } from "bun:test";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { parseMigrationManifest, type V2MigrationManifest } from "../src/lib/shared-ledger-contract-v2-transfer.js";
import { parseLendResult } from "../src/lib/shared-ledger-contract-v2-lend.js";
import { v2ManifestDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { readLendRow } from "../src/shared-ledger/lend/storage.js";
import { command, D, H, harness, worker } from "./shared-ledger-v2-lend-server-fixture.test.js";

function seal(m: V2MigrationManifest): V2MigrationManifest { m.manifestDigest = v2ManifestDigest(m); return m; }
function manifest(status: "claimed" | "done" | "cancelled" | "released" | "pooled" = "claimed"): V2MigrationManifest {
  const m = parseMigrationManifest(V2_DTO_FIXTURES.migrationManifest.valid);
  m.tasks[0]!.stage = "review";
  m.steps[0] = { ...m.steps[0]!, step: "review", executor: worker, headFrom: H };
  m.mappings.find(x => x.kind === "order")!.sourceId = "order";
  m.lendOrders[0] = { ...m.lendOrders[0]!, status, leaseGen: 7 };
  m.lendClaims[0]!.leaseGen = 7; m.lendLeases[0]!.leaseGen = 7;
  if (status === "done") {
    m.lendResults = [parseLendResult({ ...V2_DTO_FIXTURES.lendResult.valid as object, leaseGen: 7 })];
    m.lendOrders[0]!.resultDigest = D; m.lendOrders[0]!.resultOperationId = "lend-result";
  }
  if (status === "pooled") {
    m.lendOrders[0] = { ...m.lendOrders[0]!, worker: null, leaseGen: 0, leaseUntil: null };
    m.lendClaims = []; m.lendLeases = [];
  }
  return seal(m);
}

test("active import preserves original order id, generation, claim and exact deadline; never issues an order/event", () => {
  const h = harness();
  try {
    const m = manifest(), before = structuredClone(m.lendOrders[0]);
    const out = h.within(c => h.domain.importInTransaction(c, m));
    expect(out).toEqual([before]); expect(h.order("order")).toEqual(before);
    expect(h.within(c => readLendRow(c, "claim", "order"))).toEqual(m.lendClaims[0]);
    expect(h.within(c => readLendRow(c, "lease", "order"))).toEqual(m.lendLeases[0]);
    expect(h.order("order")).toMatchObject({ leaseGen: 7, leaseUntil: 61000, createdAt: 1000, updatedAt: 1000 });
    expect(h.count("events")).toBe(0); expect(h.count("receipts")).toBe(0);
    expect(() => h.claim("order")).toThrow("stale_order");
    h.within(c => h.domain.importInTransaction(c, m));
    expect(h.count("v2_lend_orders")).toBe(1); expect(h.count("v2_lend_claims")).toBe(1);
    const drift = structuredClone(m); drift.lendOrders[0]!.updatedAt = 2001; seal(drift);
    expect(() => h.within(c => h.domain.importInTransaction(c, drift))).toThrow("dedup_mismatch");
    expect(h.order("order")).toEqual(before);
    expect(h.apply(command("lend.renew", { orderId: "order", leaseGen: 7 })).lease!.leaseGen).toBe(7);
  } finally { h.db.close(); }
});

for (const status of ["done", "cancelled", "released"] as const) test(`${status} imports remain settled with old evidence, no new claim`, () => {
  const h = harness();
  try {
    const m = manifest(status); m.evidence.oldOrders = "settled"; seal(m);
    h.within(c => h.domain.importInTransaction(c, m));
    expect(h.order("order")).toEqual(m.lendOrders[0]);
    expect(() => h.claim("order")).toThrow("stale_order");
    expect(() => h.apply(command("lend.renew", { orderId: "order", leaseGen: 7 }))).toThrow("stale_order");
    if (status === "done") {
      expect(h.within(c => readLendRow(c, "result", "order"))).toEqual(m.lendResults[0]);
      expect(h.apply(h.result("order", { leaseGen: 7 })).replayed).toBe(true);
      expect(h.count("events")).toBe(0);
    }
  } finally { h.db.close(); }
});

test("pooled import preserves generation zero and can be claimed exactly once", () => {
  const h = harness();
  try {
    const m = manifest("pooled"); h.within(c => h.domain.importInTransaction(c, m));
    expect(h.order("order").leaseGen).toBe(0);
    expect(h.claim("order").order.leaseGen).toBe(1);
    expect(() => h.claim("order")).toThrow("stale_order");
  } finally { h.db.close(); }
});

test("import rejects missing/rebound lease, reset identity, stale fence, expired order and unapproved migration", () => {
  const h = harness();
  try {
    const mutations: Array<(m: V2MigrationManifest) => void> = [
      m => { m.lendClaims = []; }, m => { m.lendLeases = []; },
      m => { m.lendLeases[0]!.expiresAt--; }, m => { m.lendClaims[0]!.grantId = "other"; },
      m => { m.lendLeases[0]!.worker = { ...worker, agentId: "other" }; },
      m => { m.mappings.find(x => x.kind === "order")!.sourceId = "old-order"; },
      m => { m.steps[0]!.executor = { ...worker, agentId: "other" }; },
      m => { m.steps[0]!.state = "done"; }, m => { m.lendOrders[0]!.status = "done"; },
    ];
    for (const mutate of mutations) {
      const m = manifest(); mutate(m); seal(m);
      expect(() => h.within(c => h.domain.importInTransaction(c, m))).toThrow("migration_blocked");
      expect(h.count("v2_lend_orders")).toBe(0);
    }
    h.scope.now = 61000;
    expect(() => h.within(c => h.domain.importInTransaction(c, manifest()))).toThrow("migration_blocked");
    h.scope.now = 2000;
    expect(() => h.within(c => h.domain.importInTransaction(c, manifest()), { epoch: 2 })).toThrow("stale_epoch");
    h.faults.imported = true;
    expect(() => h.within(c => h.domain.importInTransaction(c, manifest()))).toThrow("migration_blocked");
  } finally { h.db.close(); }
});

test("import shares the caller transaction and conflicts never partially import a group", () => {
  const h = harness();
  try {
    expect(() => h.within(c => { h.domain.importInTransaction(c, manifest()); throw Error("migration receipt failure"); })).toThrow("migration receipt failure");
    for (const table of ["v2_lend_orders", "v2_lend_claims", "v2_lend_leases"]) expect(h.count(table)).toBe(0);
    const m = manifest();
    m.lendOrders.push({ ...m.lendOrders[0]!, orderId: "order-two" });
    m.lendClaims.push({ ...m.lendClaims[0]!, orderId: "order-two" });
    m.lendLeases.push({ ...m.lendLeases[0]!, orderId: "order-two" });
    m.mappings.push({ ...m.mappings.find(x => x.kind === "order")!, sourceId: "order-two", id: "order-two" }); seal(m);
    expect(() => h.within(c => h.domain.importInTransaction(c, m))).toThrow("conflict");
    expect(h.count("v2_lend_orders")).toBe(0); expect(h.count("v2_lend_claims")).toBe(0);
  } finally { h.db.close(); }
});
