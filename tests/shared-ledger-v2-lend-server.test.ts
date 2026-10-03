import { expect, test } from "bun:test";
import { command, D, H, H2, harness, worker } from "./shared-ledger-v2-lend-server-fixture.test.js";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import type { V2TransactionContext } from "../src/lib/shared-ledger-contract-v2-transaction.js";
import type { LendCommand } from "../src/shared-ledger/lend/checks.js";
import { readLendRow } from "../src/shared-ledger/lend/storage.js";

test("one central order/claim/lease; even a second claim by the holder is refused", () => {
  const h = harness();
  try {
    const o = h.create(), out = h.claim(o.orderId);
    expect(out.order).toMatchObject({ status: "claimed", leaseGen: 1, executorInstanceId: "peer-a", worker });
    expect(out.lease).toMatchObject({ renewedAt: 2000, expiresAt: 602000 });
    expect(() => h.claim(o.orderId)).toThrow("stale_order");
    const other = command("lend.claim", { claim: { ...V2_DTO_FIXTURES.lendClaim.valid as object, orderId: o.orderId,
      executorInstanceId: "peer-b", worker: { ...worker, instanceId: "peer-b" } } });
    expect(() => h.apply(other)).toThrow("stale_order");
    for (const table of ["v2_lend_orders", "v2_lend_claims", "v2_lend_leases"]) expect(h.count(table)).toBe(1);
    expect(h.within(c => readLendRow(c, "claim", o.orderId))!.claimedAt).toBe(2000);
    expect(h.count("events")).toBe(2);
  } finally { h.db.close(); }
});

test("live task cannot have duplicate orders, including after expiry or unknown result", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    const second = { ...command("lend.create"), requestId: "other-request" };
    expect(() => h.apply(second)).toThrow("conflict");
    h.scope.now = 602001;
    expect(() => h.apply(second)).toThrow("conflict");
    h.scope.now = 2001;
    expect(h.apply(h.result(o.orderId, { verdict: "unknown" })).order.status).toBe("unknown");
    expect(() => h.apply(second)).toThrow("conflict");
    expect(() => h.claim(o.orderId)).toThrow("stale_order");
    expect(h.count("events")).toBe(3);
  } finally { h.db.close(); }
});

test("claim pins grant, executor, version and next lease generation before any write", () => {
  const h = harness();
  try {
    const o = h.create();
    for (const [patch, error] of [
      [{ head: H2 }, "stale_order"], [{ specRev: 2 }, "stale_order"], [{ taskId: "other" }, "stale_order"],
      [{ round: 1 }, "stale_order"], [{ leaseGen: 0 }, "stale_lease_gen"], [{ leaseGen: 3 }, "stale_lease_gen"],
      [{ grantId: "other" }, "authorization_mismatch"], [{ grantDigest: "f".repeat(64) }, "authorization_mismatch"],
      [{ executorInstanceId: "peer-b", worker: { ...worker, instanceId: "peer-b" } }, "authorization_mismatch"],
    ] as const) {
      const cmd = command("lend.claim", { claim: { ...V2_DTO_FIXTURES.lendClaim.valid as object, orderId: o.orderId, ...patch } });
      expect(() => h.apply(cmd)).toThrow(error);
    }
    expect(h.count("v2_lend_claims")).toBe(0); expect(h.order(o.orderId)).toEqual(o);
  } finally { h.db.close(); }
});

test("renew uses central clock, exact holder and generation, never revives expired lease", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId); h.scope.now = 17000;
    const renew = command("lend.renew", { orderId: o.orderId });
    expect(h.apply(renew).lease).toMatchObject({ leaseGen: 1, renewedAt: 17000, expiresAt: 617000 });
    expect(h.order(o.orderId).leaseUntil).toBe(617000);
    expect(() => h.apply(command("lend.renew", { orderId: o.orderId, leaseGen: 2 }))).toThrow("stale_lease_gen");
    expect(() => h.apply(command("lend.renew", { orderId: o.orderId, executorInstanceId: "peer-b" }))).toThrow("forbidden");
    h.scope.now = 617000;
    expect(() => h.apply(renew)).toThrow("lease_expired");
    expect(() => h.apply(h.result(o.orderId))).toThrow("lease_expired");
    expect(h.count("v2_lend_results")).toBe(0);
  } finally { h.db.close(); }
});

for (const step of ["review", "write", "fix"] as const) test(`${step} result only changes its order and own step`, () => {
  const h = harness(step);
  try {
    const before = { task: h.read("task"), feature: h.read("feature"), workflow: h.read("workflow") };
    const other = { ...V2_DTO_FIXTURES.step.valid as object, step: "accept", taskId: "task", round: 0 };
    h.set("step", other, "task:accept:0");
    const o = h.create(); h.claim(o.orderId);
    const cmd = h.result(o.orderId, step === "review" ? {} : { verdict: "delivered", head: H2 });
    const out = h.apply(cmd);
    expect(out.order).toMatchObject({ status: "done", head: H, resultDigest: D, resultOperationId: "lend-result" });
    expect(h.read("step", `task:${step}:0`)).toMatchObject({ state: step === "review" ? "done" : "delivered", headTo: step === "review" ? H : H2 });
    expect({ task: h.read("task"), feature: h.read("feature"), workflow: h.read("workflow") }).toEqual(before);
    expect(h.read("step", "task:accept:0")).toEqual(other);
    const events = h.count("events"); h.scope.now = 900000;
    expect(h.apply(cmd).replayed).toBe(true); expect(h.count("events")).toBe(events);
    expect(() => h.apply(h.result(o.orderId, { summary: "changed" }))).toThrow("dedup_mismatch");
  } finally { h.db.close(); }
});

test("result rejects every identity/version mismatch and hidden whole-task fields", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    for (const [patch, error] of [
      [{ orderId: "missing" }, "not_found"], [{ leaseGen: 2 }, "stale_lease_gen"], [{ specRev: 2 }, "stale_order"],
      [{ expectedHead: H2 }, "stale_order"], [{ head: H2 }, "stale_order"], [{ round: 1 }, "stale_order"], [{ taskId: "other" }, "stale_order"],
      [{ worker: { ...worker, agentId: "other" } }, "forbidden"],
      [{ executorInstanceId: "peer-b", worker: { ...worker, instanceId: "peer-b" } }, "forbidden"],
    ] as const) expect(() => h.apply(h.result(o.orderId, patch))).toThrow(error);
    const base = h.result(o.orderId);
    for (const key of ["stage", "homeInstanceId", "authorizationAskId", "patch"]) {
      const extra = { ...base, payload: { result: { ...(base.payload as { result: object }).result, [key]: "done" } } };
      expect(() => h.apply(extra as unknown as LendCommand)).toThrow("invalid_field");
    }
    expect(h.count("v2_lend_results")).toBe(0); expect(h.count("events")).toBe(2);
  } finally { h.db.close(); }
});

test("result rechecks live task and exact step; stale task or reassigned/completed step rolls back", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    const task = h.read("task"), step = h.read("step", "task:review:0");
    for (const patch of [{ head: H2 }, { specRev: 2 }, { round: 1 }, { stage: "merge" }]) {
      h.set("task", { ...task, ...patch });
      expect(() => h.apply(h.result(o.orderId))).toThrow("stale_order");
    }
    h.set("task", task);
    for (const patch of [{ state: "done" }, { executor: { ...worker, agentId: "other" } }, { headFrom: H2 }]) {
      h.set("step", { ...step, ...patch }, "task:review:0");
      expect(() => h.apply(h.result(o.orderId))).toThrow("stale_order");
    }
    expect(h.order(o.orderId).status).toBe("claimed"); expect(h.count("v2_lend_results")).toBe(0);
  } finally { h.db.close(); }
});

test("service actions, source/planning authority, order restriction, live grants and fences fail closed", () => {
  const h = harness();
  try {
    const c = command("lend.create"), feature = h.read("feature");
    for (const authorityMode of ["source", "planning"]) {
      h.set("feature", { ...feature, authorityMode }); expect(() => h.apply(c)).toThrow("execution_not_shared");
    }
    h.set("feature", feature);
    expect(() => h.apply(c, { actor: { ...h.scope.actor, actions: [] } })).toThrow("forbidden");
    expect(() => h.apply(c, { actor: { ...h.scope.actor, instanceId: "peer-a" } })).toThrow("wrong_home");
    h.faults.authorization = true; expect(() => h.apply(c)).toThrow("authorization_expired"); h.faults.authorization = false;
    const o = h.create(); h.claim(o.orderId);
    const result = h.result(o.orderId);
    for (const patch of [{ epoch: 2 }, { bootId: "new-boot" }, { serviceGeneration: 2 }]) {
      expect(() => h.apply(result, patch)).toThrow(patch.serviceGeneration ? "stale_generation" : "stale_epoch");
    }
    const actor = { ...h.scope.actor, kind: "service" as const, serviceId: "proxy", representedPersonId: "person", orderId: "other" };
    expect(() => h.apply(result, { actor })).toThrow("forbidden");
    expect(h.count("v2_lend_results")).toBe(0);
  } finally { h.db.close(); }
});

test("cancellation checks CAS and generation; cancelled order cannot claim, renew or return", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    expect(() => h.apply(command("lend.cancel", { orderId: o.orderId, expectedRev: 2 }))).toThrow("conflict");
    expect(() => h.apply(command("lend.cancel", { orderId: o.orderId, leaseGen: 2 }))).toThrow("stale_lease_gen");
    expect(h.apply(command("lend.cancel", { orderId: o.orderId })).order.status).toBe("cancelled");
    expect(() => h.apply(h.result(o.orderId))).toThrow("stale_order");
    expect(() => h.claim(o.orderId)).toThrow("stale_order");
    expect(() => h.apply(command("lend.renew", { orderId: o.orderId }))).toThrow("stale_order");
  } finally { h.db.close(); }
});

for (const fault of ["step", "event", "receipt"] as const) test(`${fault} failure rolls back order, claim, lease, result, step, event and receipt together`, () => {
  const h = harness();
  try {
    const o = h.create(); h.faults[fault] = true;
    expect(() => h.claim(o.orderId)).toThrow();
    expect(h.order(o.orderId)).toEqual(o);
    expect(h.count("v2_lend_claims")).toBe(0); expect(h.count("v2_lend_leases")).toBe(0);
    expect(h.count("events")).toBe(1); expect(h.count("receipts")).toBe(1);
    h.faults[fault] = false; h.claim(o.orderId);
    const before = h.read("step", "task:review:0"); h.faults[fault] = true;
    expect(() => h.apply(h.result(o.orderId))).toThrow();
    expect(h.order(o.orderId).status).toBe("claimed"); expect(h.count("v2_lend_results")).toBe(0);
    expect(h.read("step", "task:review:0")).toEqual(before);
    expect(h.count("events")).toBe(2); expect(h.count("receipts")).toBe(2);
  } finally { h.db.close(); }
});

test("cross-project lookups and forged or leaked transaction contexts cannot access orders", () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    const other = { projectId: "other", actor: { ...h.scope.actor, projects: ["other"] } };
    expect(h.within(c => readLendRow(c, "order", o.orderId), other)).toBeNull();
    const cmd = h.result(o.orderId), result = (cmd.payload as { result: object }).result;
    expect(() => h.apply({ ...cmd, projectId: "other", payload: { result: { ...result, projectId: "other" } } } as LendCommand, other)).toThrow("not_found");
    const leaked = h.within(c => c);
    expect(() => h.domain.applyInTransaction(leaked, cmd)).toThrow("transaction_closed");
    expect(() => h.domain.applyInTransaction({ scope: h.scope, assertActive() {} } as V2TransactionContext, cmd)).toThrow("transaction_required");
  } finally { h.db.close(); }
});

test("create rejects stale task/workflow CAS and mismatched feature, round or stage", () => {
  const h = harness();
  try {
    for (const patch of [{ expectedRev: 2 }, { expectedSpecRev: 2 }, { expectedWorkflowRev: 2 }]) {
      expect(() => h.apply(command("lend.create", patch))).toThrow("conflict");
    }
    for (const patch of [{ featureId: "other" }, { round: 1 }, { head: H2 }]) {
      expect(() => h.apply(command("lend.create", patch))).toThrow("stale_order");
    }
    expect(h.count("events")).toBe(0); expect(h.count("v2_lend_orders")).toBe(0);
  } finally { h.db.close(); }
});

for (const verdict of ["unknown", "failed"] as const) test(`${verdict} result cannot mark its step successful`, () => {
  const h = harness();
  try {
    const o = h.create(); h.claim(o.orderId);
    const before = h.read("step", "task:review:0");
    h.apply(h.result(o.orderId, { verdict, summary: "保留成果，等待核对" }));
    expect(h.read("step", "task:review:0")).toMatchObject({ state: "assigned", headTo: null, verdict: null, verified: before.verified });
    expect(h.order(o.orderId).status).toBe(verdict === "unknown" ? "unknown" : "done");
  } finally { h.db.close(); }
});

test("async authorization or step adapters cannot escape the caller transaction", () => {
  const h = harness();
  try {
    const authorize = h.ports.authorize;
    h.ports.authorize = () => Promise.resolve();
    expect(() => h.create()).toThrow("transaction_control");
    expect(h.count("v2_lend_orders")).toBe(0);
    h.ports.authorize = authorize;
    const o = h.create(); h.ports.writeStep = () => Promise.resolve();
    expect(() => h.claim(o.orderId)).toThrow("transaction_control");
    expect(h.order(o.orderId).status).toBe("pooled"); expect(h.count("v2_lend_claims")).toBe(0);
  } finally { h.db.close(); }
});

test("result operation ids cannot be reused for another order; conflicting result rolls its step back", () => {
  const h = harness();
  try {
    const first = h.create(); h.claim(first.orderId); h.apply(h.result(first.orderId));
    h.set("task", { ...h.read("task"), round: 1 });
    const second = h.apply({ ...command("lend.create", { round: 1 }), requestId: "second-order" }).order;
    h.apply(command("lend.claim", { claim: { ...V2_DTO_FIXTURES.lendClaim.valid as object, orderId: second.orderId, round: 1 } }));
    const before = h.read("step", "task:review:1");
    expect(() => h.apply(h.result(second.orderId, { round: 1 }))).toThrow("conflict");
    expect(h.order(second.orderId).status).toBe("claimed");
    expect(h.read("step", "task:review:1")).toEqual(before);
    expect(h.count("v2_lend_results")).toBe(1); expect(h.count("events")).toBe(5);
  } finally { h.db.close(); }
});
