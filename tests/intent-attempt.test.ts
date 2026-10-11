import { expect, test } from "bun:test";
import { attemptKey, disputeSeqOf } from "../src/lib/intent-attempt.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { getIntent, getWorkflow, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { gateBlock, gateRefusalFacts, specDigestOf } from "../src/lib/scheduler-dispatch-block.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { arbiterStep } from "../src/lib/review-arbiter-runtime.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import { claimLend } from "../src/lib/ledger-lend.js";
import { writeLendResult } from "../src/lib/ledger-lend-result.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { arbitrationFixture, resultDeps, verdictRequest } from "./fix-strategy-remote-helpers.js";
import { P1 } from "./scheduler-auto-helpers.js";
import { scenario } from "./scheduler-review-swap.test.js";

type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
const row = (id: string, status: SchedulerIntent["status"], taskId = "T1") => ({ id, taskId, status });
const born = (f: Fixture) => listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.kind === "task")!.seq;
const cancel = (f: Fixture, id: string) => settleIntent(f.db, f.at("scheduler"), { id, from: "pending", to: "cancelled", receipt: "执行时按台账重算，已不是这个计划" });

test("attemptKey: no cancelled attempt keeps the key byte-for-byte; each cancelled attempt of the same key moves it on", () => {
  const base = "fix-swap:s7:r2";
  expect(attemptKey(base, "T1", [])).toBe(base);
  expect(attemptKey(base, "T1", [row(base, "done"), row(base, "pending")])).toBe(base);
  expect(attemptKey(base, "T1", [row(base, "cancelled")])).toBe(`${base}:a1`);
  expect(attemptKey(base, "T1", [row(base, "cancelled"), row(`${base}:a1`, "cancelled")])).toBe(`${base}:a2`);
  expect(attemptKey(base, "T1", [row(base, "cancelled"), row(`${base}:a1`, "done")])).toBe(`${base}:a1`);
});

test("attemptKey: other rounds, other cards, other prefixes and look-alike keys never count", () => {
  const base = "fix-swap:s7:r2";
  expect(attemptKey(base, "T1", [row("fix-swap:s7:r1", "cancelled"), row("fix-swap:s7:r1:a1", "cancelled"), row(base, "cancelled", "T2"),
    row("review-swap:s7:r2", "cancelled"), row("arbiter:s7:d2", "cancelled"), row("fix-swap:s7:r20", "cancelled"),
    row("fix-swap:s7:r2x", "cancelled"), row("t68:s7:fix:a1", "cancelled")])).toBe(base);
  expect(attemptKey("arbiter:s7:d12", "T1", [row("arbiter:s7:d123", "cancelled"), row("arbiter:s7:d12", "cancelled")])).toBe("arbiter:s7:d12:a1");
});

test("fix_swap: a cancelled fix-swap:s<born>:r2 replans as :a1 (then :a2) and planIntent accepts it instead of dedup_mismatch", async () => {
  const f = await repeatedFix();
  try {
    const p = convergenceProbe(f), base = `fix-swap:s${born(f)}:r${f.task().round}`;
    const first = p.plan();
    expect(first).toMatchObject({ id: base, action: "fix_swap" });
    cancel(f, first.id);
    const second = p.plan();
    expect(second).toMatchObject({ id: `${base}:a1`, action: "fix_swap", status: "pending" });
    cancel(f, second.id);
    expect(p.plan()).toMatchObject({ id: `${base}:a2`, action: "fix_swap", status: "pending" });
    expect(getIntent(f.db, base)?.status).toBe("cancelled");
  } finally { f.close(); }
});

test("arbitrate: a cancelled arbiter:s<born>:d<seq> replans as :a1 and planIntent accepts it", async () => {
  const f = await repeatedFix();
  try {
    expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "fix", "--head", "3".repeat(40),
      "--disputes", JSON.stringify([{ findingId: P1.findingId, reason: "probe has no failing assertion" }]))).toMatchObject({ ok: true });
    await f.tick();
    expect(await f.review("changes", "3".repeat(40), [P1])).toMatchObject({ ok: true });
    const p = convergenceProbe(f), first = p.plan();
    const dispute = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "finding_dispute")!;
    expect(first).toMatchObject({ id: `arbiter:s${born(f)}:d${dispute.seq}`, action: "arbitrate" });
    cancel(f, first.id);
    const second = p.plan();
    expect(second).toMatchObject({ id: `${first.id}:a1`, action: "arbitrate", status: "pending" });
    expect(await arbiterStep(f.db, f.at("scheduler"), second.id, 2, p.deps)).toMatchObject({ step: "ready" });
  } finally { f.close(); }
});

test("disputeSeqOf: the arbiter key with or without its attempt gives the dispute seq; any other shape is null", () => {
  expect(disputeSeqOf("arbiter:s7:d50")).toBe(50);
  expect(disputeSeqOf("arbiter:s7:d50:a1")).toBe(50);
  expect(disputeSeqOf("arbiter:s7:d50:a12")).toBe(50);
  for (const bad of ["arbiter:s7:d", "arbiter:s7:d50:a", "arbiter:s7:d50:x1", "fix-swap:s7:r2", "arbiter:s7:d5x", "x:arbiter:s7:d50"]) {
    expect(disputeSeqOf(bad)).toBeNull();
  }
});

test("remote arbitrate: an :a1 intent passes the dispute check, pools, and its delivered verdict settles the arbitration", async () => {
  const { f, p, intent } = await arbitrationFixture();
  try {
    cancel(f, intent.id);
    const retry = p.plan();
    expect(retry).toMatchObject({ id: `${intent.id}:a1`, action: "arbitrate" });
    expect(await arbiterStep(f.db, f.at("scheduler"), retry.id, 2, p.deps)).toMatchObject({ step: "pooled" });
    const o = remoteOrder(f.db, retry.id)!;
    claimLend(f.db, f.at("peer:Peer"), "Peer", { v: 1, orderId: o.orderId, worker: "new-arbiter" }, () => p.context.borrow[0]);
    writeLendResult(f.db, f.at("peer:Peer"), "Peer", verdictRequest(remoteOrder(f.db, retry.id)!, "upheld"), "same-body", resultDeps);
    expect(await arbiterStep(f.db, f.at("scheduler"), retry.id, 2, p.deps)).toMatchObject({ step: "arbitrated" });
    expect(getIntent(f.db, retry.id)?.status).toBe("done");
    expect(listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "arbitration_result")?.data)
      .toMatchObject({ intentId: retry.id, verdict: "upheld" });
  } finally { f.close(); }
});

test("review_swap: a cancelled review-swap:s<born>:r<round> replans as :a1 and planIntent accepts it", async () => {
  const p = await scenario();
  const f = p.f;
  try {
    const persist = () => {
      const next = planScheduler(p.snapshot());
      if (next.kind !== "intent") throw new Error(JSON.stringify(next));
      const causalSeq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
      return planIntent(f.db, f.at("scheduler"), { ...next, recipient: next.recipient ?? undefined, taskId: "T1", taskRev: f.task().rev,
        workflowRev: getWorkflow(f.db, "T1")!.rev, causalSeq }).intent;
    };
    const base = `review-swap:s${born(f)}:r${f.task().round}`;
    const first = persist();
    expect(first).toMatchObject({ id: base, action: "review_swap" });
    cancel(f, first.id);
    expect(persist()).toMatchObject({ id: `${base}:a1`, action: "review_swap", status: "pending" });
  } finally { f.close(); }
});

test("gate blocked on the same material: the real planner keeps a cancelled fix-swap waiting; only changed material gets :a1", async () => {
  const f = await repeatedFix();
  try {
    const first = convergenceProbe(f).plan();
    cancel(f, first.id);
    // repeatedFix is a local author with no write lease: the base planner's remoteWork is null, so its own gate wait never fires.
    const s0 = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
    const spec = "规格：只改 src/lib/x.ts", last = s0.events.at(-1)!;
    const refused = { ...last, seq: last.seq + 1, kind: "scheduler" as const, data: { op: "gate_refused", reason: "外发闸（x）：拒收",
      ...gateRefusalFacts(s0.task, s0.events, first.id, spec) } };
    const blocked = { ...s0, events: [...s0.events, refused], gate: { specDigest: specDigestOf(spec), lease: "none" as const } };
    expect(gateBlock(blocked.task, blocked.events, blocked.gate)?.state).toBe("blocked");
    expect(planScheduler(blocked)).toMatchObject({ kind: "wait", code: "dispatch_blocked_gate" });
    const unknown = { ...blocked, gate: { ...blocked.gate, specDigest: null } };
    expect(planScheduler(unknown)).toMatchObject({ kind: "wait", code: "dispatch_blocked_gate" });
    const changed = { ...blocked, gate: { ...blocked.gate, specDigest: specDigestOf(`${spec}（修订）`) } };
    expect(gateBlock(changed.task, changed.events, changed.gate)?.state).toBe("retry");
    expect(planScheduler(changed)).toMatchObject({ id: `${first.id}:a1`, action: "fix_swap" });
  } finally { f.close(); }
});

test("gate blocked from the ledger: a refusal read back by autoSnapshot keeps the cancelled fix-swap waiting", async () => {
  const f = await repeatedFix();
  try {
    const first = convergenceProbe(f).plan();
    cancel(f, first.id);
    const s0 = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
    insertEvent(f.db, f.at("scheduler"), { project: "p", kind: "scheduler", target: "T1",
      data: { op: "gate_refused", reason: "外发闸（x）：拒收", ...gateRefusalFacts(s0.task, s0.events, first.id, "规格") } }, false);
    const s = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2 });
    expect(gateBlock(s.task, s.events, s.gate)?.state).toBe("blocked");
    expect(planScheduler(s)).toMatchObject({ kind: "wait", code: "dispatch_blocked_gate" });
    expect(() => convergenceProbe(f).plan()).toThrow("dispatch_blocked_gate");
    expect(getIntent(f.db, `${first.id}:a1`)).toBeNull();
  } finally { f.close(); }
});
