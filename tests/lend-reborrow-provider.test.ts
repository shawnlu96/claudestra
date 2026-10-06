import { afterEach, expect, test } from "bun:test";
import { harness, FP, polled, wire, TEXT, sha } from "./lend-harness.js";
import { advance, getOrder, recordAsked, patchOrder } from "../src/lib/lend-journal.js";
import { claimOrder, driveLeased, workerName } from "../src/lib/lend-drive.js";
import { reborrowMarker } from "../src/lib/lend-reborrow-marker.js";
import { reborrowClaimProblem } from "../src/lib/lend-reborrow-provider.js";
import type { WorkerLiveness } from "../src/lib/worker-liveness.js";
const oldId = "lend:T93:s1:r0:a0", nextId = "lend:T93:s1:r1:a0", branch = "lend/T93-abcd";
const opened: ReturnType<typeof harness>[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.db.close(); });
function setup() {
  const h = harness({ entry: { roles: ["write"] }, writeOpen: true }); opened.push(h);
  const order = { ...wire(oldId), node: "write", step: "write" };
  const binding = reborrowMarker({ orderId: oldId, gen: 1, reclaimSeq: 9 });
  const next = { ...order, orderId: nextId, node: "fix", step: "fix", acceptance: [binding] };
  recordAsked(h.db, { orderId: oldId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(oldId), step: "write" } });
  advance(h.db, oldId, "asked", "claimed", { leaseGen: 1, wire: { order, text: TEXT, write: { branch, base: "main" } } });
  advance(h.db, oldId, "claimed", "cancelled", {});
  recordAsked(h.db, { orderId: nextId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(nextId), step: "fix" } });
  h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: next, text: TEXT, sha256: sha(TEXT),
    write: { branch, base: "main" }, lease: { gen: 1, expiresAt: 9e15, ms: 600_000 } } });
  h.d.reborrowCheckpoints = async () => {};
  return { h, next };
}
test("normal claim and both restart boundaries recheck the provider journal", async () => {
  const { h } = setup(); let checks = 0;
  h.d.reborrowCheckpoints = async () => { checks++; };
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("claimed");
  await driveLeased(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("cloned");
  await driveLeased(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("started");
  expect(checks).toBe(3);
});
test.each(["running", "unknown", "no_host"] as WorkerLiveness[])("%s old worker refuses formal claim before clone/start", async (state) => {
  const { h } = setup();
  h.liveness.set(workerName(oldId), state);
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)).toMatchObject({ state: "released", reason: expect.stringContaining("续借拒领") });
  expect(h.calls.at(-1)?.body).toMatchObject({ action: "release", reason: "not_started" });
  expect(h.log.created).toHaveLength(0);
});
test.each(["payload", "work", "missing", "gen", "peer", "fp", "started", "stopped", "settle", "unpreserved"])("%s cannot be papered over by A cancellation", async (bad) => {
  const { h } = setup();
  if (bad === "payload") patchOrder(h.db, oldId, ["cancelled"], { payload: { pending: true } });
  if (bad === "work") patchOrder(h.db, oldId, ["cancelled"], { work: { head: "a".repeat(40), summary: "pending", selfCheck: "pending" } });
  if (bad === "missing") h.db.run("DELETE FROM lend_orders WHERE orderId = ?", [oldId]);
  if (bad === "gen") patchOrder(h.db, oldId, ["cancelled"], { leaseGen: 2 });
  if (bad === "peer" || bad === "fp") h.db.run(`UPDATE lend_orders SET ${bad} = 'other' WHERE orderId = ?`, [oldId]);
  if (bad === "started" || bad === "stopped") h.db.run("UPDATE lend_orders SET state = ? WHERE orderId = ?", [bad, oldId]);
  if (bad === "settle") patchOrder(h.db, oldId, ["cancelled"], { settle: { notify: "stopped", removeDir: false } });
  if (bad === "unpreserved") h.d.reborrowCheckpoints = async () => { throw new Error("unpreserved"); };
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("released");
  expect(h.log.created).toHaveLength(0);
});
test.each(["claimed", "cloned"] as const)("restarted %s refuses drift before starting", async (stage) => {
  const { h } = setup();
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  if (stage === "cloned") await driveLeased(getOrder(h.db, nextId)!, h.d);
  h.liveness.set(workerName(oldId), "running");
  await driveLeased(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("released");
  expect(h.log.created).toHaveLength(0);
});
test("production default probes retained git and refuses absent source; ordinary orders skip probe", async () => {
  const { h, next } = setup(); delete h.d.reborrowCheckpoints;
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("released");
  const row = getOrder(h.db, nextId)!;
  row.wire!.order = { ...next, acceptance: ["ordinary"] };
  expect(await reborrowClaimProblem(row, h.d)).toBeNull();
});
test("journal drift during checkpoint verification refuses", async () => {
  const { h } = setup();
  h.d.reborrowCheckpoints = async () => { patchOrder(h.db, oldId, ["cancelled"], { leaseGen: 3 }); };
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("released");
});
test("damaged/duplicate marker on the real claim path releases instead of falling through", async () => {
  const { h, next } = setup(); next.acceptance.push(next.acceptance[0]);
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)?.state).toBe("released");
});

test("cancelled journal cannot hide an unresolved provider refusal", async () => {
  const { h } = setup();
  h.d.failure = () => ({ kind: "error", message: "provider refused", askId: "refusal" } as never);
  await claimOrder(getOrder(h.db, nextId)!, h.d);
  expect(getOrder(h.db, nextId)).toMatchObject({ state: "released", reason: expect.stringContaining("不自动重试") });
  expect(h.log.created).toHaveLength(0);
});
