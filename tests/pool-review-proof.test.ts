/**
 * dispatch-recovery-POOLRV1: a pooled review is a merge source only with its real tickets. Real temp ledger and lend CLI on A, a
 * real lending side B (journal + lend-tools take_review / submit_verdict, synthetic key; pool-review-proof-helpers.ts), the
 * production auto tick planning the merge. Refused with zero merge intents: drifted head / round / specRev / gen, non-review /
 * claimed / unknown / cancelled orders, missing receipts, CLI or legacy results without a ticket, no take, wrong / late / no pin,
 * tampered body, missing or altered archive, same family, no_order.
 */
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoReviewWriter } from "../src/lib/scheduler-auto-review.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { claimsPoolReview, poolReviewRefusal } from "../src/lib/pool-review-proof.js";
import { aResultDeps, B_WORKER, lendSide } from "./pool-review-proof-helpers.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };
const FINDING = { findingId: "note-1", family: "storage", severity: "P2", probe: "raw probe", description: "machine description" };
const REPORT = "〔原始报告〕\r\nsecond line【通过】\n";

type Opts = { pinned?: "b" | "other" | "late" | "none"; take?: boolean; legacy?: boolean; tamper?: boolean };

/** An auto card whose round-1 review was pooled to mate and answered by B's real worker tools; the card sits in merge. */
async function pooledReview(o: Opts = {}) {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const b = lendSide(f.dir);
  const pin = o.pinned ?? "b";
  const pinned = pin === "none" ? null : pin === "other" ? { publicKey: instanceKeySync(join(f.dir, "other-key"))!.publicKey, pinnedAt: b.pinned.pinnedAt }
    : pin === "late" ? { ...b.pinned, pinnedAt: new Date(8.64e15).toISOString() } : b.pinned;
  const a = aResultDeps(f.dir, pinned);
  const lend = { borrow: async () => borrow, notifyPm: async () => {}, result: a.result };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", typeof body === "string" ? body : JSON.stringify(body));
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect(await tick()).toMatchObject({ step: "pool_pooled" });
  const [order] = listLendOrders(f.db, "T1");
  const claim = await peer("claim", { v: 1, orderId: order.orderId, worker: B_WORKER });
  expect(claim.ok).toBe(true);
  const send = (body: Record<string, unknown>) => {
    let out = body;
    if (o.legacy) { const { ticket: _t, ...rest } = body; out = rest; }
    if (o.tamper) out = { ...out, report: "## 改过的报告" };
    return peer("write", out);
  };
  const answer = await b.answer(claim as never, { verdict: "changes", findings: [FINDING], report: REPORT }, send, { take: o.take });
  const merges = () => (f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action = 'merge'").get() as { n: number }).n;
  const facts = () => {
    const r = currentReviewFacts(f.task(), listEvents(f.db, { project: "p", target: "T1" }));
    if (r.kind !== "facts") throw new Error("no review facts");
    return r.facts;
  };
  const proof = () => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!);
  const lendData = () => listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.kind === "review")?.data.lend as Record<string, any> | undefined;
  return { f, o: order, b, a, answer, tick, merges, facts, proof, lendData, peer, resend: () => peer("write", answer.sent[0]) };
}

/** Answered normally; P2 changes don't block the gate, so the card moves to merge on the next ticks. */
async function answered(o: Opts = {}) {
  const p = await pooledReview(o);
  expect(p.answer.r).toMatchObject({ ok: true });
  expect(await p.tick()).toMatchObject({ step: "pool_done" });
  expect(await p.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  return p;
}

describe("POOLRV1 pool review proof on a real ledger and the production planner", () => {
  test("a normally answered pool order: proof holds, the planner plans the merge once, a replayed verdict changes nothing", async () => {
    const p = await answered();
    try {
      expect(poolReviewRefusal(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!, p.facts())).toBeNull();
      expect(p.proof()).toMatchObject({ reviewer: "peer:mate", reviewerFamily: "codex", head: H1 });
      const receipt = p.o.orderId;
      expect(await p.tick()).toMatchObject({ step: "merge_queue" });
      expect(p.merges()).toBe(1);
      const again = await p.resend();
      expect(again).toMatchObject({ ok: true });
      expect(listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review")).toHaveLength(1);
      await p.tick();
      expect(p.merges()).toBe(1);
      expect(p.proof().eventSeq).toBe(p.facts().eventSeq);
      expect(receipt).toBe(listLendOrders(p.f.db, "T1")[0].orderId);
    } finally { p.f.close(); }
  });

  test("the archive holds the received request byte for byte: report (CRLF, brackets), finding description and ticket, bound to the event", async () => {
    const p = await answered();
    try {
      const lend = p.lendData()!;
      expect(lend.ticketRefusal).toBeUndefined();
      expect(lend.ticket).toMatchObject({ orderId: p.o.orderId, worker: B_WORKER, session: "b-sess-1", key: p.b.key.publicKey });
      expect(lend.raw.sha256).toBe(listLendOrders(p.f.db, "T1")[0].resultSha);
      expect(lend.raw.path).toBe(join(p.a.rawDir, `${lend.raw.sha256}.json`));
      const bytes = readFileSync(lend.raw.path, "utf8");
      expect(bytes).toBe(JSON.stringify(p.answer.sent[0])); // exactly what B sent, not rebuilt
      const body = JSON.parse(bytes);
      expect(body.report).toBe(REPORT);
      expect(body.verdict.findings[0].description).toBe("machine description");
      expect(body.ticket).toEqual(lend.ticket);
    } finally { p.f.close(); }
  });

  const refused: [string, Opts, RegExp][] = [
    ["a legacy / CLI result without a ticket enters but is no AUTO source", { legacy: true }, /缺 submit_verdict 票据/],
    ["a ticket checked against another pinned key", { pinned: "other" }, /钉住的对方钥匙/],
    ["a key pinned only after the claim (re-pinned)", { pinned: "late" }, /晚于这一单的领单/],
    ["no pinned key readable", { pinned: "none" }, /读不到这个 peer 钉住的钥匙/],
    ["a body changed after signing (same ticket)", { tamper: true }, /payloadSha/],
  ];
  for (const [why, o, msg] of refused) {
    test(`${why} → refused, zero merge intents`, async () => {
      const p = await answered(o);
      try {
        expect(poolReviewRefusal(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!, p.facts())).toMatch(msg);
        const out = await p.tick();
        expect(["replan", "manual"]).toContain(out.step);
        expect(p.merges()).toBe(0);
        expect(p.proof).toThrow();
      } finally { p.f.close(); }
    });
  }

  test("no take_review → B sends no ticket; A enters the verdict as before but it is no AUTO source, no merge", async () => {
    const p = await answered({ take: false });
    try {
      expect(p.answer.sent[0]).not.toHaveProperty("ticket");
      expect(poolReviewRefusal(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!, p.facts())).toMatch(/缺 submit_verdict 票据/);
      await p.tick();
      expect(p.merges()).toBe(0);
      expect(p.proof).toThrow();
    } finally { p.f.close(); }
  });

  const archive: [string, (path: string) => void, RegExp][] = [
    ["archive deleted", (path) => unlinkSync(path), /原件缺失/],
    ["archive altered", (path) => writeFileSync(path, readFileSync(path, "utf8").replace("second", "SECOND")), /原件缺失、被改/],
    ["archive readable by others", (path) => chmodSync(path, 0o644), /原件缺失、被改/],
  ];
  for (const [why, hurt, msg] of archive) {
    test(`${why} → refused, zero merge intents`, async () => {
      const p = await answered();
      try {
        hurt(p.lendData()!.raw.path);
        expect(poolReviewRefusal(p.f.db, p.f.task(), getWorkflow(p.f.db, "T1")!, p.facts())).toMatch(msg);
        await p.tick();
        expect(p.merges()).toBe(0);
        expect(p.proof).toThrow();
      } finally { p.f.close(); }
    });
  }

  test("the same body resent twice at once after entry: one review event, one receipt, one merge", async () => {
    const p = await pooledReview({ take: true });
    try {
      const [x, y] = await Promise.all([p.resend(), p.resend()]);
      expect(x.receipt).toEqual(y.receipt);
      expect(listEvents(p.f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "review")).toHaveLength(1);
      await p.tick(); await p.tick(); await p.tick(); await p.tick();
      expect(p.merges()).toBe(1);
    } finally { p.f.close(); }
  });

  const tampered: [string, string][] = [
    ["order head drifted", "UPDATE lend_orders SET head = 'b' || substr(head, 2)"],
    ["order round drifted", "UPDATE lend_orders SET round = round + 1"],
    ["order specRev drifted", "UPDATE lend_orders SET specRev = specRev + 1"],
    ["order is not a review", "UPDATE lend_orders SET step = 'fix'"],
    ["order claimed, not done", "UPDATE lend_orders SET status = 'claimed'"],
    ["order unknown", "UPDATE lend_orders SET status = 'unknown'"],
    ["order cancelled", "UPDATE lend_orders SET status = 'cancelled'"],
    ["receipt missing", "UPDATE lend_orders SET receipt = NULL"],
    ["receipt names another event", "UPDATE lend_orders SET receipt = json_set(receipt, '$.eventSeq', 1)"],
    ["receipt unsigned", "UPDATE lend_orders SET receipt = json_set(receipt, '$.sig', '')"],
    ["result digest differs", "UPDATE lend_orders SET resultSha = 'x'"],
    ["order not offered by the scheduler", "UPDATE lend_orders SET createdBy = 'owner'"],
    ["claim ticket of another worker", "UPDATE lend_orders SET worker = 'w2'"],
    ["claim ticket of another lease generation", "UPDATE lend_orders SET leaseGen = 2"],
    ["scheduler review intent cancelled", "UPDATE scheduler_intents SET status = 'cancelled' WHERE action = 'review'"],
  ];
  for (const [why, sql] of tampered) {
    test(`${why} → merge plan refused, merge run proof refused, zero merge intents`, async () => {
      const p = await answered();
      try {
        p.f.db.run(sql);
        const out = await p.tick();
        // Either the planner already stops the card (manual) or the ledger refuses the merge plan (replan): never a merge.
        expect(["replan", "manual"]).toContain(out.step);
        if (out.step === "replan") expect(out.detail).toMatch(/合并前|出借池审查回执不成立/);
        expect(p.merges()).toBe(0);
        expect(p.proof).toThrow();
      } finally { p.f.close(); }
    });
  }

  test("same family as the head's actual author → refused; no exemption without a formal MODELX record", async () => {
    const p = await answered();
    try {
      const why = poolReviewRefusal(p.f.db, p.f.task(), { authorFamily: "codex" }, p.facts());
      expect(why).toMatch(/实际作者家族相同/);
      p.f.db.run("UPDATE task_workflows SET authorFamily = 'codex'");
      p.f.db.run("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (1, 'scheduler', 'p', 'T1', 'escalate', 'x', ?)",
        [JSON.stringify({ op: "model_refusal_exempt" })]);
      expect(poolReviewRefusal(p.f.db, p.f.task(), { authorFamily: "codex" }, p.facts())).toMatch(/实际作者家族相同/);
      expect(p.proof).toThrow();
    } finally { p.f.close(); }
  });

  test("no_order: a peer-looking verdict that lend-write never entered is refused, not treated as local", async () => {
    const p = await answered();
    try {
      const claim = listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.kind === "note" && (e.data.lend as any)?.op === "claim")!;
      const forged = { ...p.facts(), eventSeq: claim.seq };
      expect(poolReviewRefusal(p.f.db, p.f.task(), { authorFamily: "claude" }, forged)).toMatch(/no_order/);
      const session = { ...p.facts(), eventSeq: claim.seq, reviewer: "pm-reviewer", reviewerSessionId: `lend:mate:${p.o.orderId}` };
      expect(poolReviewRefusal(p.f.db, p.f.task(), { authorFamily: "claude" }, session)).toMatch(/no_order/);
      const born = listEvents(p.f.db, { project: "p", target: "T1" }).find((e) => e.kind === "task")!;
      const local = { ...p.facts(), eventSeq: born.seq, reviewer: "agent-rv-t1", reviewerSessionId: "s-rv" };
      expect(poolReviewRefusal(p.f.db, p.f.task(), { authorFamily: "claude" }, local)).toBeNull(); // not a pool claim: local rules decide
    } finally { p.f.close(); }
  });

  test("CLI copy of a pool verdict on an auto card is refused before anything else (manual queue)", async () => {
    const p = await answered();
    try {
      expect(claimsPoolReview({ reviewer: "peer:mate" })).toBe(true);
      expect(claimsPoolReview({ session: "lend:mate:x" })).toBe(true);
      expect(claimsPoolReview({ reviewer: "agent-rv-t1", session: "s-rv" })).toBe(false);
      for (const claim of [{ reviewer: "peer:mate", session: "x" }, { reviewer: "pm-reviewer", session: `lend:mate:${p.o.orderId}` }]) {
        expect(() => autoReviewWriter(p.f.db, p.f.task(), { actor: "pm" }, { ...claim, family: "codex", head: H1 })).toThrow(/CLI 代记不算回执/);
      }
    } finally { p.f.close(); }
  });
});
