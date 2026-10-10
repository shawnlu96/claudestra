/**
 * CVREBOR1: a write lease ended by the scheduler's formal CONV2 family-swap reclaim is resumed only through the explicit
 * `--reborrow --conv-end` entry. The CONV end is produced by the real scheduler path (plan → materials → cancel → real clean ack
 * over the peer CLI → reclaim → PM settle), never by hand-written reason strings or a fabricated PM reclaim.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, getTask, listEvents } from "../src/lib/ledger-store.js";
import { getLendOrder } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { readReborrowBinding } from "../src/lib/lend-reborrow-marker.js";
import { convergenceEvent } from "../src/lib/fix-strategy-lifecycle.js";
import { harness } from "./lend-harness.js";
import { testChildEnv } from "./test-env.js";
import { advance, getOrder, recordAsked } from "../src/lib/lend-journal.js";
import { claimOrder, driveLeased } from "../src/lib/lend-drive.js";
import {
  resources, lab, db, dbPath, fp, endSeq, reviewed, branch, oldId, intentId, origin, target,
  parse, argv, cli, peer, base, conv, orders, snapshot, claim, deliver, hello, tamper, ctx, convEnd, setup,
} from "./lend-reborrow-conv-fixture.js";

afterEach(async () => { closeLedger(dbPath); await resources.dispose(); });

describe.each(["codex", "claude"] as const)("formal CONV end, original family %s", (family) => {
  beforeEach(async () => { await setup(family); await convEnd(); }, 60_000);

  test("old --reclaim entry refuses; --conv-end dry-run is read-only, apply signs one v2 successor bound to the CONV end", () => {
    const before = snapshot();
    expect(cli(...base(), "--reclaim", String(endSeq), "--apply").ok).toBe(false);
    const dry = conv();
    expect(dry).toMatchObject({ ok: true, dryRun: true, source: "conv", intentId, originalFamily: family, convFamily: target(),
      reviewedHead: reviewed, remoteHead: reviewed, gen: 1, previousOrderId: oldId });
    expect(snapshot()).toBe(before);
    const r = conv("--apply");
    expect(r).toMatchObject({ ok: true, head: reviewed, supersedes: oldId, base: "main", family: target(), peer: "mate" });
    const o = getLendOrder(db, r.orderId)!;
    expect(o.wire.acceptance).toContain(`[lend-reborrow:v2 src=conv old=${oldId} gen=1 end=${endSeq} from=${family} to=${target()}]`);
    expect(o.wire.acceptance.some((l) => l.includes("lend-reborrow:v1"))).toBe(false);
    expect(o.reborrowBasis).toEqual({ ledgerHead: reviewed, reclaimSeq: endSeq, previousOrderId: oldId });
    // The frozen history of every round (not only the last report) rides the order through the outbound gate.
    const sent = JSON.stringify(o.wire);
    expect(sent).toContain("CONV 冻结材料");
    for (const round of [1, 2, 3, 4]) expect(sent).toContain(`review-${round}.md`);
    expect(getTask(db, "T1")).toMatchObject({ headSHA: reviewed, stage: "fix", round: 4 });
    expect(getWriteLease(db, "T1")).toMatchObject({ state: "held", peer: "mate", branch });
    const audit = listEvents(db, { target: "T1" }).find((e) => (e.data.lend as any)?.op === "write_reborrow_conv")!.data.lend as any;
    expect(audit).toMatchObject({ sourceKind: "conv_fix_strategy_reclaim", originalFamily: family, convFamily: target(), orderFamily: target(),
      previousOrderId: oldId, previousGen: 1, intentId, ledgerHead: reviewed });
    expect(listEvents(db, { target: "T1" }).filter((e) => (e.data.lend as any)?.op === "reclaim")).toHaveLength(0);
    expect(listEvents(db, { target: "T1" }).filter((e) => e.kind === "review").map((e) => e.data.reviewerSessionId))
      .toEqual(["review-session-1", "review-session-2", "review-session-3", "review-session-4"]);
    expect(conv("--apply")).toMatchObject({ ok: true, duplicate: true, orderId: o.orderId });
    expect(orders().filter((x) => x.supersedes === oldId)).toHaveLength(1);
    expect(claim(o.orderId)).toMatchObject({ ok: true, order: { head: reviewed, pr: 7 }, write: { base: "main" } });
    const head = lab.commit(lab.seed, "after-recovery.txt"); lab.git(lab.seed, "push", "-q", lab.bare, branch);
    expect(deliver(o.orderId, head, target()).ok).toBe(true);
    expect(getTask(db, "T1")).toMatchObject({ stage: "review", headSHA: head });
  }, 60_000);

  test("same seq on the other source, a user family other than the CONV target, and flag misuse all refuse", () => {
    const before = snapshot();
    expect(cli(...base(), "--conv-end", String(endSeq), "--reclaim", String(endSeq)).ok).toBe(false);
    expect(cli(...base(), "--conv-end", `0${endSeq}`).ok).toBe(false);
    expect(cli(...base(), "--conv-end", "-1").ok).toBe(false);
    expect(cli(...base(), "--conv-end", String(endSeq - 1)).ok).toBe(false);
    expect(cli("lend-offer", "T1", "--peer", "mate", "--repo", "o/r", "--conv-end", String(endSeq)).ok).toBe(false);
    expect(conv("--apply", "--family", family).ok).toBe(false);
    expect(snapshot()).toBe(before);
    const r = conv("--apply"); expect(r.ok).toBe(true);
    expect(cli(...base(), "--reclaim", String(endSeq), "--apply").ok).toBe(false);
  }, 60_000);
});

describe("refusals with zero order / lease / business writes", () => {
  beforeEach(async () => { await setup("codex"); }, 60_000);
  const zero = (fn: () => Record<string, any>) => { const before = snapshot(); expect(fn().ok).toBe(false); expect(snapshot()).toBe(before); };

  test("unsettled intent (still submitted) refuses; the command never settles it", async () => {
    await convEnd(false);
    expect(getIntent(db, intentId)?.status).toBe("submitted");
    zero(() => conv("--apply"));
    expect(getIntent(db, intentId)?.status).toBe("submitted");
  }, 60_000);

  test.each([
    "reason-only", "fake-pm-reclaim", "later-bad-proof", "wrong-actor", "wrong-intent", "wrong-spec", "wrong-round", "wrong-head",
    "wrong-gen", "wrong-time", "no-ack", "no-materials", "materials-family", "live-order", "unknown-intent", "assigned-step",
    "author-session", "writer-after", "revoked", "expired-grant", "no-capacity", "fp-drift", "other-peer", "non-pm",
  ])("%s", async (bad) => {
    await convEnd();
    const end = () => listEvents(db, { target: "T1" }).find((e) => e.seq === endSeq)!;
    const patch = (seq: number, data: object) => tamper("UPDATE events SET data = json_patch(data, ?) WHERE seq = ?", [JSON.stringify(data), seq]);
    if (bad === "reason-only") tamper("DELETE FROM events WHERE seq = ?", [endSeq]);
    if (bad === "fake-pm-reclaim") {
      tamper("UPDATE events SET dedupKey = NULL, kind = 'note', actor = 'owner', data = json_set(data, '$.lend', json(?)) WHERE seq = ?",
        [JSON.stringify({ op: "reclaim", peer: "mate" }), endSeq]);
    }
    if (bad === "later-bad-proof") db.run("INSERT INTO events (ts,actor,project,target,kind,data) VALUES (?, 'pm','p','T1','scheduler',?)",
      [Date.now(), JSON.stringify({ ...end().data })]);
    if (bad === "wrong-actor") tamper("UPDATE events SET actor = 'owner' WHERE seq = ?", [endSeq]);
    if (bad === "wrong-intent") patch(endSeq, { intentId: "fix-swap:other" });
    if (bad === "wrong-spec") patch(endSeq, { specRev: 99 });
    if (bad === "wrong-round") patch(endSeq, { round: 99 });
    if (bad === "wrong-head") patch(endSeq, { head: "e".repeat(40) });
    if (bad === "wrong-gen") db.run("UPDATE lend_orders SET leaseGen = 2 WHERE orderId = ?", [oldId]);
    if (bad === "wrong-time") db.run("UPDATE lend_write_leases SET updatedAt = updatedAt + 1 WHERE taskId = 'T1'");
    if (bad === "no-ack") tamper("DELETE FROM events WHERE dedupKey = ?", [`convergence-cancel:${oldId}`]);
    if (bad === "no-materials") tamper("DELETE FROM events WHERE dedupKey = ?", [`scheduler:${intentId}:materials`]);
    if (bad === "materials-family") tamper("UPDATE events SET data = json_set(data, '$.family', ?) WHERE dedupKey = ?", [origin, `scheduler:${intentId}:materials`]);
    if (bad === "live-order") db.run("UPDATE lend_orders SET status = 'unknown' WHERE orderId = ?", [oldId]);
    if (bad === "unknown-intent") db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?", [intentId]);
    if (bad === "assigned-step") db.run(`INSERT INTO task_steps (taskId, step, round, executorKind, executor, state, createdAt, updatedAt)
      VALUES ('T1','fix',4,'agent','x','assigned',1,1)`);
    if (bad === "author-session") db.run(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES ('T1','author','new-local','new-session','claude','tmux','active',?,1,1)`, [intentId]);
    if (bad === "writer-after") db.run("UPDATE lend_orders SET createdAt = ? WHERE orderId = ?", [Date.now() + 60_000, oldId]);
    if (bad === "revoked") db.run("UPDATE lend_peers SET grant = NULL");
    if (bad === "expired-grant") hello({ codex: 4, claude: 4 }, Date.now() - 1);
    if (bad === "no-capacity") hello({ codex: 4, claude: 0 });
    if (bad === "fp-drift") db.run("UPDATE lend_peers SET fp = ?", ["0".repeat(64)]);
    if (bad === "other-peer") { zero(() => cli(...base(), "--conv-end", String(endSeq), "--peer", "other")); return; }
    if (bad === "non-pm") { zero(() => parse(Bun.spawnSync(argv(...base(), "--conv-end", String(endSeq), "--apply"),
      { cwd: lab.root, env: testChildEnv({ ...lab.env, CLAUDESTRA_AGENT: "agent-task-one" }), stdout: "pipe", stderr: "pipe" }))); return; }
    zero(() => conv("--apply"));
  }, 60_000);

  // r1 P1 conv-material: the frozen file itself is evidence; a path in the materials event alone proves nothing.
  const materialPath = () => String(listEvents(db, { target: "T1" }).find((e) => e.dedupKey === `scheduler:${intentId}:materials`)!.data.material);
  test("frozen CONV material missing or rewritten refuses", async () => {
    await convEnd();
    const path = materialPath();
    rmSync(path); zero(() => conv("--apply"));
    writeFileSync(path, "not the convergence material"); zero(() => conv("--apply"));
  }, 60_000);

  test("frozen CONV material rewritten while the source is read outside the lock refuses at the canonical CAS", async () => {
    await convEnd();
    writeFileSync(join(lab.root, "material-flag"), materialPath());
    zero(() => conv("--apply"));
  }, 60_000);

  // r1 P1 conv-effect: settling the intent does not reconcile an external effect it already started.
  test.each(["creating", "worktree", "archive"])("unreconciled %s effect of the CONV intent refuses after the intent is settled", async (effect) => {
    await convEnd(false);
    convergenceEvent(db, ctx("scheduler"), getIntent(db, intentId)!, effect, { agent: "agent-cv-t1-fix", family: target(), dir: join(lab.root, "tree") });
    settleIntent(db, ctx("owner"), { id: intentId, from: "submitted", to: "cancelled", receipt: "PM 结清，但创建效果未对账" });
    zero(() => conv("--apply"));
  }, 60_000);

  test("audit append failure rolls the order and lease back", async () => {
    await convEnd();
    db.run(`CREATE TRIGGER reject_conv BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.lend.op')='write_reborrow_conv'
      BEGIN SELECT RAISE(ABORT,'rollback probe'); END`);
    zero(() => conv("--apply"));
  }, 60_000);

  test("facts drifting while the source is read outside the lock refuse at the canonical CAS", async () => {
    await convEnd();
    const keep = () => JSON.stringify([orders(), getWriteLease(db, "T1"), getTask(db, "T1")]), before = keep();
    writeFileSync(join(lab.root, "drift-flag"), "1");
    const r = conv("--apply");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toContain("发生变化");
    expect(keep()).toBe(before);
  }, 60_000);

  test("two real CLI processes create exactly one successor", async () => {
    await convEnd();
    const run = async () => {
      const child = Bun.spawn(argv(...base(), "--conv-end", String(endSeq), "--apply"), { cwd: lab.root, env: lab.env, stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return parse({ stdout: Buffer.from(out), stderr: Buffer.from(err) });
    };
    const result = await Promise.all([run(), run()]);
    expect(result.every((r) => r.ok)).toBe(true);
    expect(result[0].orderId).toBe(result[1].orderId);
    expect(orders().filter((o) => o.supersedes === oldId)).toHaveLength(1);
  }, 60_000);

  test("v2 binding round-trips strictly and damaged CONV evidence voids the audit basis", async () => {
    await convEnd();
    const r = conv("--apply"); expect(r.ok).toBe(true);
    const o = getLendOrder(db, r.orderId)!;
    const v2 = o.wire.acceptance.find((l) => l.startsWith("[lend-reborrow:v2"))!;
    expect(readReborrowBinding([v2])).toEqual({ orderId: oldId, gen: 1, reclaimSeq: endSeq, conv: { from: "codex", to: "claude" } });
    // Any damage to the persisted CONV evidence voids the basis, so cardMoved refuses the successor.
    tamper("UPDATE events SET data = json_set(data, '$.family', 'codex') WHERE dedupKey = ?", [`scheduler:${intentId}:materials`]);
    expect(getLendOrder(db, r.orderId)?.reborrowBasis).toBeNull();
  }, 60_000);
});

describe("provider claim boundary for a v2 successor", () => {
  beforeEach(async () => { await setup("codex"); await convEnd(); }, 60_000);

  test.each(["clean", "unknown-worker", "pending-payload", "family-mismatch", "journal-drift", "pre-start", "old-provider"])("%s", async (bad) => {
    const r = conv("--apply"); expect(r.ok).toBe(true);
    const h = harness({ entry: { peer: "mate", fp, families: { codex: 2, claude: 2 }, roles: ["write"], repos: ["o/r"] }, peer: { name: "mate", fp } });
    try {
      const o = getLendOrder(db, r.orderId)!, old = getLendOrder(db, oldId)!;
      recordAsked(h.db, { orderId: oldId, peer: "mate", fp, family: bad === "family-mismatch" ? "claude" : "codex", preview: {} });
      advance(h.db, oldId, "asked", "claimed", { leaseGen: 1, wire: { order: { ...old.wire }, text: old.text, write: { branch, base: "main" } } });
      advance(h.db, oldId, "claimed", "cancelled", { ...(bad === "pending-payload" ? { payload: { waiting: true } } : {}) });
      recordAsked(h.db, { orderId: o.orderId, peer: "mate", fp, family: "claude", preview: {
        taskId: o.taskId, head: o.head, repo: o.repo, pr: o.pr, step: o.step } });
      h.d.context = async () => ({ contacts: [{ name: "mate", fp }], projects: [] });
      h.d.selfFp = () => fp; h.d.worker.alive = async () => bad === "unknown-worker" ? "unknown" : "no_window";
      h.d.reborrowCheckpoints = async () => {
        if (bad === "journal-drift") h.db.run("UPDATE lend_orders SET reason = 'drifted' WHERE orderId = ?", [oldId]);
      };
      if (bad === "old-provider") {
        // The v1-only parser shipped before this card: a strict v2 marker is a refusal there, never an ordinary order.
        const lib = join(import.meta.dir, "../src/lib/");
        const source = lab.git(lib, "show", "c075720b:src/lib/lend-reborrow-marker.ts");
        expect(source).toContain("lend-reborrow:v1");
        const file = join(lab.root, "old-reborrow-marker.ts"); writeFileSync(file, source.replaceAll('from "./', `from "${lib}`));
        const legacy = await import(file);
        expect(() => legacy.readReborrowBinding(o.wire.acceptance)).toThrow();
        expect(legacy.readReborrowBinding(["ordinary acceptance"])).toBeNull();
        return;
      }
      h.d.call = async (_p, ep, body) => ({ status: 200, body: peer(ep === "result" ? "write" : ep, body) });
      await claimOrder(getOrder(h.db, o.orderId)!, h.d);
      if (bad === "pre-start") {
        // Claim passed; the old worker reappears before clone/start. The next drive pass (also a restart's re-entry) must refuse.
        expect(getOrder(h.db, o.orderId)?.state).toBe("claimed");
        h.d.worker.alive = async () => "running";
        await driveLeased(getOrder(h.db, o.orderId)!, h.d);
      }
      const ok = bad === "clean";
      expect(getOrder(h.db, o.orderId)?.state).toBe(ok ? "claimed" : "released");
      expect(getLendOrder(db, o.orderId)?.status).toBe(ok ? "claimed" : "released");
      expect(getWriteLease(db, "T1")?.state).toBe(ok ? "held" : "ended");
      if (!ok) expect(String(getOrder(h.db, o.orderId)?.reason)).toContain("续借拒领");
    } finally { h.db.close(); }
  }, 60_000);
});
