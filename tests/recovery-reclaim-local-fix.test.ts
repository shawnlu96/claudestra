import { expect, test } from "bun:test";
import { repeatedFix } from "./fix-strategy-helpers.js";
import { remoteProbe, peerAuthor } from "./fix-strategy-remote-helpers.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { endWriteLease, heldLease } from "../src/lib/ledger-lend-lease.js";
import { reclaimLend } from "../src/lib/ledger-lend.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { remoteOrder } from "../src/lib/fix-strategy-remote-order.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { setReclaimLocalFixPolicy } from "../src/lib/recovery-reclaim-local-fix.js";

/** The X13 shape: Peer delivered the current head under a held lease, a reviewer asked for a second fix, then PM reclaimed. */
async function reclaimedFix(mode: RecoveryMode, opts: { reclaim?: boolean } = {}) {
  const f = await repeatedFix();
  const p = remoteProbe(f);
  // a card born on the peer: nothing local to restore, so the reclaim leaves author / assignee empty (X13)
  f.db.run("UPDATE tasks SET agent = NULL, assignee = NULL, assigneeKind = NULL WHERE id = 'T1'"); peerAuthor(f);
  const deliver = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "deliver")!;
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, worker, leaseGen, leaseUntil, leaseMs, createdBy, createdAt, updatedAt, branch, base, eventSeq)
    VALUES ('peer-fix', 'T1', 'p', 'Peer', 'codex', 'fix', ?, ?, ?, 'o/r', '{}', '', '', 'done', 'old-worker', 1, 1e12, 10000, 'scheduler', 1, 1, 'feat/T1', 'main', ?)`)
    .run(f.task().specRev, f.task().round - 1, f.task().headSHA!, deliver.seq);
  if (opts.reclaim !== false) reclaimLend(f.db, f.at("pm"), { taskId: "T1", reason: "peer offline" });
  else endWriteLease(f.db, "T1", "lease ended without a reclaim", f.tickDeps.now());
  setReclaimLocalFixPolicy(f.db, () => ({ mode, manualAfterMs: null, source: "config" }));
  return { f, p, intent: p.plan() };
}

const observed = (f: Awaited<ReturnType<typeof repeatedFix>>) =>
  listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "reclaimLocalFix");

test("on: after PM reclaim a same-family fresh session builds a local author with the material's family, binds it and dispatches the fix", async () => {
  const { f, p, intent } = await reclaimedFix("on");
  try {
    expect(heldLease(f.db, f.task())).toBeNull();
    const result = await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(result).toMatchObject({ step: "session" });
    expect(getIntent(f.db, intent.id)?.status).toBe("done");
    expect(p.effects.filter((e) => e.startsWith("create:")).length).toBe(1);
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(author).toMatchObject({ transport: "acp", family: "codex", state: "active" });
    expect(f.task()).toMatchObject({ agent: author.agent, assigneeKind: "agent" });
    expect(f.db.query("SELECT executor, state FROM task_steps WHERE taskId = 'T1' AND step = 'fix' AND round = ?").get(f.task().round))
      .toMatchObject({ executor: author.agent, state: "assigned" });
    const events = listEvents(f.db, { project: "p", target: "T1" });
    expect(events.filter((e) => e.data.op === "fix_strategy_reclaim").length).toBe(0); // PM already reclaimed: never a second time
    expect(remoteOrder(f.db, intent.id)).toBeNull();
    expect(observed(f).length).toBe(0);
  } finally { f.close(); }
});

test("observe: the same fixture records one recovery observation, builds nothing and dispatches nothing", async () => {
  const { f, p, intent } = await reclaimedFix("observe");
  try {
    for (let n = 0; n < 2; n++) await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow("缺held写租约");
    const notes = observed(f);
    expect(notes.length).toBe(1);
    const reclaim = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => (e.data.lend as { op?: string } | undefined)?.op === "reclaim")!;
    expect(notes[0].data).toMatchObject({ round: f.task().round, reclaimSeq: reclaim.seq, family: "codex", intentId: intent.id });
    expect(p.effects).toEqual([]); expect(getIntent(f.db, intent.id)?.status).toBe("pending");
  } finally { f.close(); }
});

test("off: the same fixture refuses exactly as before, recording nothing", async () => {
  const { f, p, intent } = await reclaimedFix("off");
  try {
    await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow("缺held写租约");
    expect(observed(f).length).toBe(0); expect(p.effects).toEqual([]); expect(getIntent(f.db, intent.id)?.status).toBe("pending");
  } finally { f.close(); }
});

for (const mode of ["on", "observe", "off"] as const) {
  test(`${mode}: a card never reclaimed and holding no lease still refuses`, async () => {
    const { f, p, intent } = await reclaimedFix(mode, { reclaim: false });
    try {
      await expect(fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).rejects.toThrow("缺held写租约");
      expect(observed(f).length).toBe(0); expect(p.effects).toEqual([]); expect(getIntent(f.db, intent.id)?.status).toBe("pending");
    } finally { f.close(); }
  });
}
