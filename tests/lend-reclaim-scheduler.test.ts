import { expect, test } from "bun:test";
import { fourRoundFix, repeatedFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor, runningOrder, resultDeps, hello } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { reclaimForFamilySwap } from "../src/lib/lend-reclaim-scheduler.js";
import { getLendOrder, reclaimLend } from "../src/lib/ledger-lend.js";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { writeLendResult } from "../src/lib/ledger-lend-result.js";
import type { ResultRequest } from "../src/lib/lend-wire.js";
import { beatLend } from "../src/lib/ledger-lend-peers.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";

test("four-round remote swap cancels a running order, waits for clean confirmation, and only then reclaims and places new family", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(getLendOrder(f.db, "old-running")?.status).toBe("cancelled");
    expect(heldLease(f.db, f.task())?.state).toBe("held");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    const req: ResultRequest = { v: 1, orderId: "old-running", gen: 1, cancelAck: { clean: true }, report: "exited without publication",
      session: { id: "old-peer-session", family: "claude" }, verdict: { v: 1, orderId: "old-running", head: f.task().headSHA!,
        verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" } };
    writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "clean", resultDeps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(heldLease(f.db, f.task())).toBeNull();
    const event = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "fix_strategy_reclaim");
    expect(event?.data).toMatchObject({ intentId: intent.id, round: 4, family: "codex" });
    expect(event?.data.reason).toContain(intent.id); expect(p.effects.some((s) => s.startsWith("kill:"))).toBe(false);
    expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", { ...req, cancelAck: undefined }, "old-delivery", resultDeps)).toThrow();
  } finally { f.close(); }
});

test("scheduler cannot reclaim a fresh-session intent, PM reclaim remains separate", async () => {
  const f = await repeatedFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f);
    expect(await reclaimForFamilySwap(f.db, f.at("scheduler"), intent.id, p.context, () => {}).catch((e) => e.code)).toBe("forbidden");
    expect(() => reclaimLend(f.db, f.at("scheduler"), { taskId: "T1", reason: "arbitrary" })).toThrow();
    expect(heldLease(f.db, f.task())?.state).toBe("held");
    expect(reclaimLend(f.db, f.at("pm"), { taskId: "T1", reason: "manual" }).lease?.state).toBe("held");
  } finally { f.close(); }
});

for (const invalid of ["actor", "stale", "manual", "head", "intent", "remote-head"] as const) {
  test(`scheduler reclaim refuses ${invalid} without ending the lease`, async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
      await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      if (invalid === "stale") f.db.run("UPDATE tasks SET round = round + 1, rev = rev + 1 WHERE id = 'T1'");
      if (invalid === "manual") f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
      if (invalid === "head") f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["6".repeat(40)]);
      if (invalid === "intent") f.db.run("UPDATE scheduler_intents SET action = 'dispatch' WHERE id = ?", [intent.id]);
      if (invalid === "remote-head") p.context.remoteHead = async () => ({ ok: true, head: "9".repeat(40) });
      const result = await reclaimForFamilySwap(f.db, f.at(invalid === "actor" ? "pm" : "scheduler"), intent.id, p.context, () => {})
        .catch(() => "refused");
      expect(result).not.toBeNull(); expect(heldLease(f.db, f.task())?.state).toBe("held");
    } finally { f.close(); }
  });
}

test("old peer sees ordinary cancelled, cannot confirm clean reclaim, and PM notice is success-deduped per card round", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f, "unknown"); hello(f, "Peer", 2);
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    const response = beatLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orders: [{ orderId: "old-running", gen: 1,
      phase: "working", lastActivityAt: 1, excerpt: "", ended: null }] }, new Map());
    expect(response.orders[0].verdict).toBe("cancelled");
    let attempts = 0;
    p.context.notify = async (text) => { if (++attempts === 1) throw new Error("offline"); p.notices.push(text); };
    for (let n = 0; n < 3; n++) expect((await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).detail).toContain("proto<3");
    expect(attempts).toBe(2); expect(p.notices.length).toBe(1); expect(heldLease(f.db, f.task())?.state).toBe("held");
    expect(getIntent(f.db, intent.id)?.status).toBe("pending");
    hello(f, "Peer", 3);
    const modern = beatLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orders: [{ orderId: "old-running", gen: 1,
      phase: "working", lastActivityAt: 1, excerpt: "", ended: null }] }, new Map());
    expect(modern.orders[0].verdict).toBe("convergence_cancelled");
  } finally { f.close(); }
});
