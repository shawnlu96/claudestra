import { expect, test } from "bun:test";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor, runningOrder } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { cancelLend, getLendOrder, leaseLend } from "../src/lib/ledger-lend.js";
import { heldLease } from "../src/lib/ledger-lend-lease.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { stoppedReportSeq } from "../src/lib/lend-reclaim-stopped.js";

type Fixture = Awaited<ReturnType<typeof fourRoundFix>>;
const events = (f: Fixture) => listEvents(f.db, { project: "p", target: "T1" });
const opEvents = (f: Fixture, op: string) => events(f).filter((e) => e.data.op === op);

/** Peer A reports its worker stopped through the real lease endpoint; returns the ledger seq of that report. */
function reportStopped(f: Fixture): number {
  leaseLend(f.db, f.at("lend"), "Peer", { v: 1, orderId: "old-running", gen: 1, action: "release", reason: "stopped", detail: "worker 已停" });
  expect(getLendOrder(f.db, "old-running")?.status).toBe("unknown");
  return events(f).findLast((e) => (e.data.lend as { op?: string } | undefined)?.op === "release")!.seq;
}

/** A forged-shape report with chosen gen, written straight to the ledger so ordering and gen can be varied. */
function fakeStopped(f: Fixture, gen: number): number {
  return insertEvent(f.db, f.at("lend"), { project: "p", target: "T1", kind: "note", text: "出借：Peer 报 stopped",
    data: { lend: { orderId: "old-running", peer: "Peer", op: "release", reason: "stopped", gen } } }, false).seq;
}

/** The waiting record an earlier tick (before this rule) left behind. */
function oldWaitingCancel(f: Fixture, intentId: string) {
  insertEvent(f.db, { ...f.at("scheduler"), dedupKey: `scheduler:${intentId}:cancel:old-running` }, { project: "p", target: "T1",
    kind: "scheduler", text: "换家族前撤旧写单，等待干净停止确认", data: { op: "convergence_cancel", intentId, orderId: "old-running",
      gen: 1, needsAck: true, head: f.task().headSHA } }, true);
}

test("writer stopped by peer A before cancel: cancel event needs no ack and the same tick reclaims and swaps family", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
    const seq = reportStopped(f);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(getLendOrder(f.db, "old-running")?.status).toBe("cancelled");
    expect(opEvents(f, "convergence_cancel")[0].data).toMatchObject({ orderId: "old-running", gen: 1, needsAck: false });
    expect(heldLease(f.db, f.task())).toBeNull();
    expect(opEvents(f, "fix_strategy_reclaim")[0].data).toMatchObject({ intentId: intent.id, family: "codex" });
    expect(opEvents(f, "convergence_stopped_exit")[0].data).toMatchObject({ intentId: intent.id, orderId: "old-running", gen: 1, reportSeq: seq });
  } finally { f.close(); }
});

test("an order already waiting for ack is released next tick once its pre-cancel stopped report is found, with the report seq recorded", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
    const seq = reportStopped(f);
    cancelLend(f.db, f.at("pm"), { taskId: "T1", reason: "PM 撤单" });
    oldWaitingCancel(f, intent.id);
    expect(stoppedReportSeq(f.db, "old-running", 1)).toBe(seq);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(heldLease(f.db, f.task())).toBeNull();
    const exits = opEvents(f, "convergence_stopped_exit");
    expect(exits.length).toBe(1);
    expect(exits[0].data).toMatchObject({ intentId: intent.id, orderId: "old-running", gen: 1, reportSeq: seq });
    expect(exits[0].text).toContain(`#${seq}`);
  } finally { f.close(); }
});

for (const variant of ["other-gen", "after-pm-cancel", "after-scheduler-cancel"] as const) {
  test(`stopped report that is ${variant} does not release the wait`, async () => {
    const f = await fourRoundFix();
    try {
      const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
      if (variant === "other-gen") { fakeStopped(f, 2); cancelLend(f.db, f.at("pm"), { taskId: "T1", reason: "PM 撤单" }); }
      if (variant === "after-pm-cancel") { cancelLend(f.db, f.at("pm"), { taskId: "T1", reason: "PM 撤单" }); fakeStopped(f, 1); }
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
      if (variant === "after-scheduler-cancel") fakeStopped(f, 1);
      expect(opEvents(f, "convergence_cancel")[0].data).toMatchObject({ needsAck: true });
      expect(stoppedReportSeq(f.db, "old-running", 1)).toBeNull();
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
      expect(heldLease(f.db, f.task())?.state).toBe("held");
      expect(opEvents(f, "convergence_stopped_exit")).toEqual([]);
    } finally { f.close(); }
  });
}

test("writer that never reported a terminal state still waits for the clean-stop ack exactly as before", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f), intent = p.plan(); peerAuthor(f, "claude"); runningOrder(f);
    for (let n = 0; n < 3; n++) {
      const r = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      expect(r).toMatchObject({ step: "waiting" });
      expect(r.detail).toContain("干净停止确认");
    }
    expect(opEvents(f, "convergence_cancel").map((e) => e.data.needsAck)).toEqual([true]);
    expect(stoppedReportSeq(f.db, "old-running", 1)).toBeNull();
    expect(heldLease(f.db, f.task())?.state).toBe("held");
    expect(opEvents(f, "convergence_stopped_exit")).toEqual([]);
    expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
  } finally { f.close(); }
});
