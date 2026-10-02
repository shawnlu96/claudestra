import { expect, test } from "bun:test";
import { arbitrationFixture, resultDeps, verdictRequest } from "./fix-strategy-remote-helpers.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendResult } from "../src/lib/ledger-lend-result.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import { openLendJournal, recordAsked, advance, getOrder } from "../src/lib/lend-journal.js";
import { orderWireOf } from "../src/lib/order-wire.js";
import { submitLendResult } from "../src/lib/lend-submit.js";

for (const invalid of ["peer", "order", "head", "specRev", "round", "session", "family", "report", "expired", "cancelled", "ordinary"] as const) {
  test(`remote arbitration refuses ${invalid} without a result or report`, async () => {
    const { f, p, intent } = await arbitrationFixture();
    try {
      await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
      const o = remoteOrder(f.db, intent.id)!;
      claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
      const req = verdictRequest(remoteOrder(f.db, intent.id)!);
      if (invalid === "order") req.orderId = "fake";
      if (invalid === "head") req.arbitration!.head = "4".repeat(40);
      if (invalid === "specRev") req.arbitration!.specRev++;
      if (invalid === "round") req.arbitration!.round++;
      if (invalid === "session") req.session.id = "s-one";
      if (invalid === "family") req.session.family = "claude";
      if (invalid === "report") req.report = "   ";
      if (invalid === "expired") f.db.run("UPDATE lend_orders SET leaseUntil = 1 WHERE orderId = ?", [o.orderId]);
      if (invalid === "cancelled") f.db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [o.orderId]);
      if (invalid === "ordinary") delete req.arbitration;
      let reports = 0;
      expect(() => writeLendResult(f.db, f.at("peer:Peer"), invalid === "peer" ? "Fake" : "Peer", req, "sha", {
        ...resultDeps, writeReport: () => { reports++; } })).toThrow();
      expect(reports).toBe(0); expect(getEventByDedup(f.db, `scheduler:${intent.id}:verdict`)).toBeNull();
    } finally { f.close(); }
  });
}

test("identical remote conclusion returns its receipt while different conclusions and extra fields are refused", async () => {
  const { f, p, intent } = await arbitrationFixture();
  try {
    await arbiterStep(f.db, f.at("scheduler"), intent.id, 2, p.deps);
    const o = remoteOrder(f.db, intent.id)!;
    claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
    const req = verdictRequest(remoteOrder(f.db, intent.id)!);
    const first = writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps);
    expect(writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "same", resultDeps)).toEqual(first);
    expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", { ...req, arbitration: { ...req.arbitration!, verdict: "upheld" } }, "different", resultDeps)).toThrow();
    expect(parseLendRequest("result", { ...req, mystery: true }).ok).toBe(false);
    expect(parseLendRequest("result", { ...req, arbitration: { ...req.arbitration!, mystery: true } }).ok).toBe(false);
    expect(parseLendRequest("result", { ...req, report: "   " }).ok).toBe(false);
  } finally { f.close(); }
});

test("the new build still accepts a proto-2 hello, while only declared proto-3 lenders receive convergence work", () => {
  const hello = { v: 1, proto: 2, boot: "old-boot", seq: 1, grant: null, paused: null,
    slots: { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } } };
  expect(parseV2Request("hello", hello).ok).toBe(true);
  expect(parseV2Request("hello", { ...hello, proto: 1 }).ok).toBe(false);
});

test("B submits upheld/overturned only through its bound caller witness and cannot change a submitted conclusion", async () => {
  const db = openLendJournal(":memory:"), now = Date.now(), orderId = "lend:T1:cv:100", head = "1".repeat(40);
  try {
    const order = { ...orderWireOf({ taskId: "T1", specRev: 1, round: 3, head, node: "arbitration", step: "review", dedupKey: orderId,
      inputs: [], outputs: [], acceptance: [], writeBack: "arbiter submit" }),
      convergence: { kind: "arbitration", intentId: "arbiter:d1", disputeSeq: 1, findingId: "finding", excludedSessions: ["author-session"] } };
    recordAsked(db, { orderId, peer: "A", fp: null, family: "codex", preview: {} }, now);
    advance(db, orderId, "asked", "claimed", { leaseGen: 1, leaseUntil: now + 60_000, wire: { order, text: "arbitration" } }, now);
    advance(db, orderId, "claimed", "cloned", { dir: "/isolated/arbitration" }, now);
    advance(db, orderId, "cloned", "started", { agent: "arbiter-worker", sessionId: "fresh-session" }, now);
    const deps = { cwd: "/isolated/arbitration", pid: 10, agentSession: () => "fresh-session", panePid: async () => 2, ancestors: async () => [2] };
    const input = { verdict: "overturned", findings: [], report: "Probe lacks an assertion; finding is overturned." };
    expect(await submitLendResult(db, orderId, input, { ...deps, agentSession: () => "other-session" }, now)).toMatchObject({ ok: false });
    expect(await submitLendResult(db, orderId, input, deps, now)).toMatchObject({ ok: true, duplicate: false });
    expect(getOrder(db, orderId)?.payload?.arbitration).toMatchObject({ verdict: "overturned", head, specRev: 1, round: 3 });
    expect(await submitLendResult(db, orderId, input, deps, now)).toMatchObject({ ok: true, duplicate: true });
    expect(await submitLendResult(db, orderId, { ...input, verdict: "upheld" }, deps, now)).toMatchObject({ ok: false });
  } finally { db.close(); }
});
