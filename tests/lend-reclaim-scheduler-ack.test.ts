import { expect, test } from "bun:test";
import { harness, polled, wire, TEXT, FP, sha } from "./lend-harness.js";
import { recordAsked, advance, getOrder } from "../src/lib/lend-journal.js";
import { driveLeased, workerName } from "../src/lib/lend-drive.js";

test("B cannot acknowledge a convergence cancellation before worker exit; failed acknowledgement retries with the same bound session", async () => {
  const h = harness({ entry: { roles: ["write"] } }), orderId = "cancel-old-writing", agent = workerName(orderId);
  try {
    const now = h.d.now();
    recordAsked(h.db, { orderId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(orderId), step: "fix" } }, now);
    advance(h.db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now,
      wire: { order: { ...wire(orderId), step: "fix" }, text: TEXT, write: { branch: "lend/T93-abcd", base: "main" } } }, now);
    advance(h.db, orderId, "claimed", "cloned", { dir: "/lend/work/cancel-old-writing" }, now);
    advance(h.db, orderId, "cloned", "started", { agent, sessionId: "old-bound-session" }, now);
    h.registry.set(agent, { sessionId: "old-bound-session", cwd: "/lend/work/cancel-old-writing" });
    h.d.renewal = () => ({ at: now, res: { ok: false, status: 200, code: "convergence_cancelled", error: "cancelled for family swap" } });
    h.d.worker.kill = async () => ({ ok: false, reason: "still running" });
    await driveLeased(getOrder(h.db, orderId)!, h.d);
    expect(h.ops()).not.toContain("result"); expect(getOrder(h.db, orderId)?.state).toBe("started");
    h.d.worker.kill = async () => { h.registry.delete(agent); return { ok: true }; };
    h.A.result = () => "throw";
    await driveLeased(getOrder(h.db, orderId)!, h.d);
    expect(getOrder(h.db, orderId)?.state).toBe("started");
    const failedBody = h.calls.find((c) => c.op === "result")!.body;
    h.A.result = (body) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: body.orderId, sha256: sha(JSON.stringify(body)),
      eventSeq: 10, taskId: "T93", key: "key", sig: "sig" } } });
    h.d.verifyReceipt = async () => false;
    await driveLeased(getOrder(h.db, orderId)!, h.d);
    expect(getOrder(h.db, orderId)?.state).toBe("started");
    h.d.verifyReceipt = async () => true;
    await driveLeased(getOrder(h.db, orderId)!, h.d);
    const sent = h.calls.filter((c) => c.op === "result");
    expect(sent.at(-1)!.body).toEqual(failedBody);
    expect(sent.at(-1)!.body).toMatchObject({ orderId, gen: 1, cancelAck: { clean: true }, session: { id: "old-bound-session" } });
    expect(getOrder(h.db, orderId)?.state).toBe("cancelled");
  } finally { h.db.close(); }
});
