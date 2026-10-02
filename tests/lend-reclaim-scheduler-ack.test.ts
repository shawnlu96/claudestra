import { expect, test } from "bun:test";
import { harness, polled, wire, TEXT, FP, sha } from "./lend-harness.js";
import { recordAsked, advance, getOrder } from "../src/lib/lend-journal.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
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

for (const state of ["claimed", "cloned", "creating"] as const) {
  test(`pre-session cancellation confirms worker absence without inventing a session: ${state}`, async () => {
    const h = harness({ entry: { roles: ["write"] } }), orderId = `pre-session-${state}`, now = h.d.now();
    try {
      recordAsked(h.db, { orderId, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(orderId), step: "fix" } }, now);
      advance(h.db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now,
        wire: { order: { ...wire(orderId), step: "fix" }, text: TEXT, write: { branch: "lend/T93-abcd", base: "main" } } }, now);
      if (state !== "claimed") advance(h.db, orderId, "claimed", "cloned", { dir: "/lend/work/pre-session",
        ...(state === "creating" ? { agent: workerName(orderId) } : {}) }, now);
      if (state === "creating") h.registry.set(workerName(orderId), { sessionId: "unrecorded-real-session", cwd: "/lend/work/pre-session" });
      h.d.renewal = () => ({ at: now, res: { ok: false, status: 200, code: "convergence_cancelled", error: "family swap" } });
      h.A.result = (body) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: body.orderId,
        sha256: sha(JSON.stringify(body)), eventSeq: 10, taskId: "T93", key: "key", sig: "sig" } } });
      h.d.verifyReceipt = async () => true;
      const kill = h.d.worker.kill;
      h.d.worker.kill = async () => ({ ok: false, reason: "unconfirmed" });
      await driveLeased(getOrder(h.db, orderId)!, h.d);
      expect(h.ops()).not.toContain("result");
      h.d.worker.kill = kill;
      for (const status of ["unknown", "running", "no_host"] as const) {
        h.d.worker.alive = async () => status;
        await driveLeased(getOrder(h.db, orderId)!, h.d);
        expect(h.ops()).not.toContain("result");
      }
      h.d.worker.alive = async () => "no_window";
      await driveLeased(getOrder(h.db, orderId)!, h.d);
      expect(h.ops()).toContain("result");
      expect(h.log.killed).toContain(workerName(orderId));
      expect(getOrder(h.db, orderId)?.state).toBe("cancelled");
      expect(getOrder(h.db, orderId)?.sessionId).toBeNull();
      const body = h.calls.find((c) => c.op === "result")!.body;
      expect(parseLendRequest("result", body).ok).toBe(true);
      expect(parseLendRequest("result", { ...body, cancelAck: { clean: true } }).ok).toBe(false);
      expect(parseLendRequest("result", { ...body, cancelAck: { clean: false, workerAbsent: true } }).ok).toBe(false);
      expect(parseLendRequest("result", { ...body, session: { id: "invented", family: "codex" } }).ok).toBe(false);
      const { cancelAck: _ack, ...ordinary } = body;
      expect(parseLendRequest("result", ordinary).ok).toBe(false);
      expect(body).toMatchObject({ cancelAck: { clean: true, workerAbsent: true }, session: { id: "" } });
    } finally { h.db.close(); }
  });
}
