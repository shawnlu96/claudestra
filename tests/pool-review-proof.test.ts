/**
 * dispatch-recovery-POOLRV1: a pooled review is a merge source only with its real tickets. Real temp ledger, real lend CLI
 * (claim / write), the production auto tick planning the merge: a normally answered pool order lets the merge be planned and
 * the merge run's proof hold; a wrong head / round / specRev, a non-review / claimed / unknown / cancelled order, a missing
 * claim or receipt, a non-scheduler order, a same-family reviewer, a CLI copy (no_order) are all refused with zero merge intents.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoReviewWriter } from "../src/lib/scheduler-auto-review.js";
import { mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { currentReviewFacts } from "../src/lib/scheduler-review.js";
import { claimsPoolReview, poolReviewRefusal } from "../src/lib/pool-review-proof.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

const REMOTE: RemotePolicy = { mode: "overflow", roles: ["review"], poolTimeoutMin: 15 };

/** An auto card whose round-1 review was pooled to mate, claimed and answered `pass` through the lend CLI; the card sits in merge. */
async function answered() {
  const f = autoFixture();
  const spec = join(f.dir, "T1.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  f.db.run("UPDATE tasks SET spec = ?, pr = 'https://github.com/o/r/pull/7' WHERE id = 'T1'", [spec]);
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review"], maxOpen: 1 }];
  const reports = join(f.dir, "reports");
  mkdirSync(reports);
  const key = instanceKeySync(mkdtempSync(join(f.dir, "key-")));
  const lend = {
    borrow: async () => borrow, notifyPm: async () => {},
    result: { reportDir: () => reports, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (x: string[]) => signPurpose(RECEIPT_PURPOSE, x, key) },
  };
  const cli = (actor: string, ...args: string[]) => f.cliWith({ lend }, actor, ...args) as Promise<Record<string, any>>;
  const deps = { ...f.tickDeps, manager: (...args: string[]) => cli("scheduler", ...args.slice(1)), borrow: async () => borrow };
  const tick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 0, remote: REMOTE } }, deps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const peer = (ep: string, body: unknown) => cli("owner", `lend-${ep}`, "--", "mate", JSON.stringify(body));
  const verdictBody = (orderId: string) => ({
    v: 1, orderId, gen: 1, report: "## 结论", session: { id: "sess-1", family: "codex" },
    verdict: { v: 1, orderId, head: H1, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "r.md" },
  });
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  expect(await tick()).toMatchObject({ step: "pool_pooled" });
  const [o] = listLendOrders(f.db, "T1");
  expect((await peer("claim", { v: 1, orderId: o.orderId, worker: "w1" })).ok).toBe(true);
  expect(await peer("write", verdictBody(o.orderId))).toMatchObject({ ok: true });
  expect(await tick()).toMatchObject({ step: "pool_done" });
  expect(await tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  const merges = () => (f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE action = 'merge'").get() as { n: number }).n;
  const facts = () => {
    const r = currentReviewFacts(f.task(), listEvents(f.db, { project: "p", target: "T1" }));
    if (r.kind !== "facts") throw new Error("no review facts");
    return r.facts;
  };
  const proof = () => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!);
  return { f, o, tick, merges, facts, proof, resend: () => peer("write", verdictBody(o.orderId)) };
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
