import { expect, test } from "bun:test";
import { fourRoundFix, repeatedFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor, runningOrder, resultDeps, hello } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { reclaimForFamilySwap } from "../src/lib/lend-reclaim-scheduler.js";
import { getLendOrder, reclaimLend, cancelLend } from "../src/lib/ledger-lend.js";
import { getWriteLease, heldLease, holdWriteLease } from "../src/lib/ledger-lend-lease.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { setSelfHealPolicy } from "../src/lib/fix-swap-halfbuilt-sample.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
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

test("PM cancellation of a previously claimed writer cannot bypass scheduler clean-exit confirmation", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f); peerAuthor(f, "claude"); runningOrder(f); const intent = p.plan();
    cancelLend(f.db, f.at("pm"), { taskId: "T1", reason: "pause writer" });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(heldLease(f.db, f.task())?.state).toBe("held");
    expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
    const req: ResultRequest = { v: 1, orderId: "old-running", gen: 1, cancelAck: { clean: true, workerAbsent: true },
      report: "named worker killed; fresh liveness probe confirms no window", session: { id: "", family: "claude" },
      verdict: { v: 1, orderId: "old-running", head: f.task().headSHA!, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "cancel.md" } };
    expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", { ...req, gen: 2 }, "wrong-gen", resultDeps)).toThrow();
    expect(() => writeLendResult(f.db, f.at("peer:Peer"), "Peer", { ...req, session: { id: "fabricated", family: "claude" } }, "fake", resultDeps)).toThrow();
    const receipt = writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "absent", resultDeps);
    expect(writeLendResult(f.db, f.at("peer:Peer"), "Peer", req, "absent", resultDeps)).toEqual(receipt);
    expect(getEventByDedup(f.db, "convergence-cancel:old-running")?.data).toMatchObject({ session: null, workerAbsent: true, clean: true });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(heldLease(f.db, f.task())).toBeNull();
  } finally { f.close(); }
});

test("a previously claimed cancelled writer appearing during the remote-head check still prevents reclaim", async () => {
  const f = await fourRoundFix();
  try {
    const p = remoteProbe(f); peerAuthor(f, "claude"); const intent = p.plan();
    p.context.remoteHead = async () => { runningOrder(f, "cancelled"); return { ok: true, head: f.task().headSHA! }; };
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
    expect(heldLease(f.db, f.task())?.state).toBe("held");
  } finally { f.close(); }
});

// SWAPFIX1 9b: a retry after a formal earlier reclaim, with the lease already ended.
const policy = (mode: "on" | "observe" | "off") => () => ({ mode, manualAfterMs: null, source: "config" as const });

/** The first family-swap intent reclaims the lease, its author tree is refused (unknown), PM cancels it; a new intent is planned. */
async function reclaimedThenCancelled(mode: "on" | "observe" | "off" = "on") {
  const f = await fourRoundFix(), p = remoteProbe(f); peerAuthor(f, "claude");
  setSelfHealPolicy(f.db, policy(mode));
  const first = p.plan(), open = p.deps.authorTree!;
  p.deps.authorTree = async () => ({ manual: "首轮作者工作树不可用" });
  expect(await fixSwapStep(f.db, f.at("scheduler"), first.id, p.deps)).toMatchObject({ step: "manual" });
  expect(heldLease(f.db, f.task())).toBeNull();
  settleIntent(f.db, f.at("pm"), { id: first.id, from: "unknown", to: "cancelled", receipt: "PM 核对：工作树已处理" });
  p.deps.authorTree = open;
  return { f, p, first, second: p.plan() };
}
const reclaims = (f: Awaited<ReturnType<typeof fourRoundFix>>) =>
  listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fix_strategy_reclaim");
const refusal = (f: Awaited<ReturnType<typeof fourRoundFix>>, p: ReturnType<typeof remoteProbe>, id: string) =>
  fixSwapStep(f.db, f.at("scheduler"), id, p.deps).then(() => "acted", (e: Error) => e.message);

test("cancelled family swap after reclaim retries with a new intent and creates codex without reclaiming twice", async () => {
  const { f, p, first, second } = await reclaimedThenCancelled();
  try {
    expect(second.id).not.toBe(first.id);
    expect(await fixSwapStep(f.db, f.at("scheduler"), second.id, p.deps)).toMatchObject({ step: "session" }); // [验收线 1]
    expect(reclaims(f).length).toBe(1);
    expect(getEventByDedup(f.db, `scheduler:${second.id}:reclaim`)).toBeNull();
    const created = p.effects.filter((s) => s.startsWith("create:"));
    expect(created.length).toBe(1);
    expect(p.raw().agents[created[0].slice(7)].runtime).toBe("codex");
    expect(getIntent(f.db, second.id)?.status).toBe("done");
    const sample = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fix_swap_selfheal");
    expect(sample.map((e) => e.data)).toMatchObject([{ mechanism: "lendReclaimIntent", action: "reclaim-resume", head: f.task().headSHA, intentId: second.id }]);
  } finally { f.close(); }
});

test("ended lease without formal matching reclaim refuses family swap", async () => {
  for (const broken of ["pm-reclaim", "forged", "lease-reason"] as const) {
    const f = await fourRoundFix(), p = remoteProbe(f); peerAuthor(f, "claude");
    try {
      setSelfHealPolicy(f.db, policy("on"));
      const id = broken !== "lease-reason" ? p.plan().id : (await reclaimedThenCancelledOn(f, p)).id;
      if (broken !== "lease-reason") reclaimLend(f.db, f.at("pm"), { taskId: "T1", reason: "manual" }); // ended by PM, no scheduler reclaim
      if (broken !== "lease-reason") f.db.run("UPDATE scheduler_intents SET taskRev = ? WHERE id = ?", [f.task().rev, id]); // keep the intent current
      if (broken === "lease-reason") f.db.run("UPDATE lend_write_leases SET reason = 'PM 手动收回' WHERE taskId = 'T1'");
      if (broken === "forged") { // a reclaim-shaped event that is not the earlier intent's own formal reclaim record
        const t = f.task(), lease = getWriteLease(f.db, "T1")!;
        insertEvent(f.db, { ...f.at("scheduler"), dedupKey: "forged:reclaim" }, { project: "p", target: "T1", kind: "scheduler", text: "x",
          data: { op: "fix_strategy_reclaim", intentId: "fake-intent", round: t.round, specRev: t.specRev, head: t.headSHA, reason: lease.reason, peer: lease.peer } }, true);
      }
      expect(await refusal(f, p, id)).toContain("remote author has no held write lease（不续用前次收回："); // [验收线 1]
      expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
    } finally { f.close(); }
  }
});

/** The reclaimedThenCancelled steps on an existing fixture; returns the second intent. */
async function reclaimedThenCancelledOn(f: Awaited<ReturnType<typeof fourRoundFix>>, p: ReturnType<typeof remoteProbe>) {
  const first = p.plan(), open = p.deps.authorTree!;
  p.deps.authorTree = async () => ({ manual: "首轮作者工作树不可用" });
  await fixSwapStep(f.db, f.at("scheduler"), first.id, p.deps);
  settleIntent(f.db, f.at("pm"), { id: first.id, from: "unknown", to: "cancelled", receipt: "PM 核对：工作树已处理" });
  p.deps.authorTree = open;
  return p.plan();
}

test("ended lease with live or unknown writer refuses replacement", async () => {
  for (const status of ["pooled", "claimed", "unknown", "prev-unknown"] as const) {
    const f = await fourRoundFix(), p = remoteProbe(f); peerAuthor(f, "claude");
    try {
      setSelfHealPolicy(f.db, policy("on"));
      const id = (await reclaimedThenCancelledOn(f, p)).id;
      const prev = reclaims(f)[0].data.intentId;
      if (status === "prev-unknown") f.db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?", [prev]);
      else runningOrder(f, status);
      expect(await refusal(f, p, id)).toContain("remote author has no held write lease（不续用前次收回："); // [验收线 1]
      expect(p.effects.filter((s) => s.startsWith("create:")).length).toBe(0);
    } finally { f.close(); }
  }
});

test("lease reacquired or remote head changed during retry refuses local author creation", async () => {
  for (const race of ["lease", "head"] as const) {
    const { f, p, second } = await reclaimedThenCancelled();
    try {
      p.context.remoteHead = async () => {
        if (race === "lease") { holdWriteLease(f.db, f.task(), { peer: "Peer", fp: "abcd-bbbb-cccc-dddd", repo: "o/r", branch: "feat/T1" }, 1); return { ok: true, head: f.task().headSHA! }; }
        return { ok: true, head: "9".repeat(40) };
      };
      expect(await refusal(f, p, second.id)).toContain("不续用前次收回"); // [验收线 1]
      expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
      expect(reclaims(f).length).toBe(1);
      expect(getIntent(f.db, second.id)?.status).toBe("pending");
    } finally { f.close(); }
  }
});

test("retry retires stale peer author before binding the replacement", async () => {
  const { f, p, second } = await reclaimedThenCancelled();
  try {
    f.db.run("UPDATE scheduler_sessions SET state = 'active', retireIntentId = NULL WHERE taskId = 'T1' AND transport = 'peer'");
    expect(await fixSwapStep(f.db, f.at("scheduler"), second.id, p.deps)).toMatchObject({ step: "session" }); // [验收线 1]
    const rows = f.db.query("SELECT transport, state, retireIntentId, createIntentId FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author'").all() as Record<string, unknown>[];
    expect(rows.find((r) => r.transport === "peer")).toMatchObject({ state: "retired", retireIntentId: second.id });
    expect(rows.find((r) => r.createIntentId === second.id)).toMatchObject({ state: "active", transport: "acp" });
  } finally { f.close(); }
});

test("off and observe keep the old refusal; observe records the would-be resume once", async () => {
  for (const mode of ["off", "observe"] as const) {
    const { f, p, second } = await reclaimedThenCancelled(mode);
    try {
      for (let n = 0; n < 2; n++) expect(await refusal(f, p, second.id)).toBe("remote author has no held write lease"); // [验收线 4]
      const notes = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "lendReclaimIntent");
      expect(notes.length).toBe(mode === "observe" ? 1 : 0);
      expect(listEvents(f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "fix_swap_selfheal")).toBe(false);
      expect(p.effects.some((s) => s.startsWith("create:"))).toBe(false);
    } finally { f.close(); }
  }
});
