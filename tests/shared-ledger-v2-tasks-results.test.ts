import { expect, test } from "bun:test";
import { parseLendOrder, parseLendResult } from "../src/lib/shared-ledger-contract-v2";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures";
import { command, harness } from "./shared-ledger-v2-tasks-harness.test";

function resultHarness(type: "task.deliver" | "task.review") {
  const h = harness(), review = type === "task.review";
  h.db.run("UPDATE tasks SET stage=? WHERE id='task'", [review ? "review" : "build"]);
  const result = { ...parseLendResult(V2_DTO_FIXTURES.lendResult.valid),
    verdict: review ? "pass" as const : "delivered" as const, artifactIds: ["artifact"], summary: "Result",
    head: review ? "b".repeat(40) : "c".repeat(40) };
  const order = { ...parseLendOrder(V2_DTO_FIXTURES.lendOrder.valid), status: "done" as const,
    step: review ? "review" as const : "write" as const, branch: "feat/example", base: "main",
    resultDigest: result.resultDigest, resultOperationId: result.operationId };
  h.put("order", "order", order); h.put("result", "order", result);
  const payload = { round: 0, orderId: "order", leaseGen: 1, head: result.head,
    ...(review ? { verdict: "pass", reportArtifactId: "artifact" } : { artifactIds: ["artifact"], summary: "Result" }) };
  return { ...h, type, order, result, payload };
}
for (const type of ["task.deliver", "task.review"] as const) {
  test(`${type} binds versions/order/round/head/lease, and mismatch has no side effects`, () => {
    const h = resultHarness(type);
    const mutations = [
      [{ expectedRev: 2 }, "conflict"], [{ expectedSpecRev: 2 }, "conflict"], [{ expectedWorkflowRev: 2 }, "conflict"],
      [{ round: 1 }, "conflict"], [{ orderId: "old" }, "stale_order"], [{ leaseGen: 2 }, "stale_lease_gen"],
      [{ orderId: null, leaseGen: null }, "stale_order"], [{ head: "d".repeat(40) }, type === "task.review" ? "conflict" : "stale_order"],
    ] as const;
    for (const [patch, error] of mutations) {
      const before = h.snapshot();
      expect(() => h.run(command(type, { ...h.payload, ...patch }))).toThrow(error);
      expect(h.snapshot()).toEqual(before);
    }
    const committed = h.run(command(type, h.payload)); expect(committed.result.rev).toBe(2);
    const saved = h.task();
    if (type === "task.deliver") {
      expect(saved.head).toBe(h.result.head); expect(JSON.parse(saved.delivery).orderId).toBe("order");
      expect(saved.stage).toBe("build");
    } else expect(JSON.parse(saved.review)).toEqual({ verdict: "pass", reviewedHead: h.result.head, reportArtifactId: "artifact" });
  });
  test(`${type} refuses stale persisted order and result evidence`, () => {
    const h = resultHarness(type);
    for (const patch of [{ taskId: "other" }, { featureId: "other" }, { specRev: 2 }, { round: 1 },
      { head: "e".repeat(40) }, { homeInstanceId: "peer-b" }, { status: "cancelled" }, { step: "fix" }]) {
      h.put("order", "order", { ...h.order, ...patch });
      const before = h.snapshot(); expect(() => h.run(command(type, h.payload))).toThrow("stale_order"); expect(h.snapshot()).toEqual(before);
    }
    h.put("order", "order", h.order);
    for (const patch of [{ orderId: "old" }, { expectedHead: "e".repeat(40) }, { head: "e".repeat(40) },
      { taskId: "other" }, { round: 1 }, { specRev: 2 }, { resultDigest: "f".repeat(64) }, { operationId: "old" }]) {
      h.put("result", "order", { ...h.result, ...patch });
      const before = h.snapshot(); expect(() => h.run(command(type, h.payload))).toThrow("stale_order"); expect(h.snapshot()).toEqual(before);
    }
    h.put("result", "order", { ...h.result, leaseGen: 2 });
    expect(() => h.run(command(type, h.payload))).toThrow("stale_lease_gen");
    h.put("result", "order", { ...h.result, epoch: 2 });
    expect(() => h.run(command(type, h.payload))).toThrow("stale_epoch");
  });
}
test("local delivery accepts a new head under rev CAS; local review must name that exact head", () => {
  const h = harness(); h.db.run("UPDATE tasks SET stage='build' WHERE id='task'");
  h.run(command("task.deliver", { orderId: null, leaseGen: null, head: "c".repeat(40), round: 0 }));
  h.run(command("task.stage", { expectedRev: 2, from: "build", to: "review", round: 0 }, "stage-review"));
  const review = { expectedRev: 3, round: 1, orderId: null, leaseGen: null, head: "c".repeat(40) };
  expect(() => h.run(command("task.review", { ...review, head: "b".repeat(40) }))).toThrow("conflict");
  h.run(command("task.review", review)); expect(h.task().rev).toBe(4);
});
