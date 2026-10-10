/**
 * AUTOACK1 [验收线 1]: the one adoptable source, a current cross-family peer ticket on a review PM put in the lend pool, taken over
 * from a card whose bound reviewer (s-rv) holds the session history. Without the adoption the old path stops it; the PM hand-back
 * adopts it explicitly and the planner, the merge intent write (requireReviewedMerge) and the merge begin (mergeReviewProof) all
 * accept the same adopted source — no engine ack / intent / bind written. A local manual MCP verdict is the negative: no take_review
 * or checkout record in the ledger, so zero adoption and the planner does not let it through.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { ADOPT_OP, adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { adopted, events, H2, mcpReview, PEER, peerReview, plan, resume, sideTables, toManual, toRound2, withPr, writeMerge, type Fx } from "./scheduler-manual-review-source-fixture.test.js";

let f: Fx;
afterEach(() => f?.close());

describe("AUTOACK1 adoption on the PM hand-back", () => {
  test("[验收线 1] the old path stops the legal peer ticket; the explicit adoption drives planner, merge write and merge begin", async () => {
    f = autoFixture();
    const { r, orderId } = await adopted(f);
    const ev = events(f);
    const verdict = ev.findLast((e) => e.kind === "review")!;
    const reviewer = `peer:${PEER}`, sessionId = `lend:${PEER}:${orderId}`;
    expect(verdict).toMatchObject({ dedupKey: `lend:${orderId}`, data: { reviewer, reviewerSessionId: sessionId, reviewerFamily: "codex", lend: { orderId } } });
    const offer = ev.find((e) => e.kind === "note" && (e.data.lend as { op?: string } | undefined)?.op === "offer")!;
    expect(offer.actor).toBe("pm");
    const adopt = ev.find((e) => e.data.op === ADOPT_OP)!;
    expect(adopt).toMatchObject({ actor: "pm", kind: "scheduler", data: { category: "manual", kind: "manual_peer", reviewSeq: verdict.seq, orderId,
      reviewer, sessionId, family: "codex", head: H2, round: 2, specRev: 1, offerSeq: offer.seq, workflowRev: getWorkflow(f.db, "T1")!.rev } });
    expect(verdict.seq).toBeLessThan(adopt.seq);
    const resumed = ev.findLast((e) => e.data.op === "workflow_resume")!;
    expect(resumed.data).toMatchObject({ manual: true, reviewSource: { adopted: adopt.seq, reviewSeq: verdict.seq, kind: "manual_peer", orderId } });
    expect(r.next).toMatchObject({ kind: "intent", action: "stage" });
    // nothing engine-shaped was made up: no session bind / ack / review intent for the peer, before or after
    expect(ev.filter((e) => e.data.op === "session_bind").map((e) => e.data.agent)).toEqual(["agent-task-one", "agent-rv-t1"]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE recipient = ?").get(reviewer)).toEqual({ n: 0 });
    // old path (same ledger, adoption ignored): no engine dispatch proof for the peer ticket
    expect(plan(f, true)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    // old path at merge: merge_review_unproven; with the adoption the planner asks for the merge, and the real writer accepts it
    expect(plan(f, true)).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const merge = f.db.query("SELECT id, status FROM scheduler_intents WHERE action = 'merge'").get() as { id: string; status: string };
    expect(merge.status).toBe("pending");
    settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: merge.id, from: "pending", to: "submitted", receipt: "claimed" });
    expect(mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ eventSeq: verdict.seq, reviewer });
    expect(beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, merge.id, ["test"])).toMatchObject({ duplicate: false, run: { phase: "ready", reviewedHead: H2 } });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ agent: reviewer, sessionId, reviewSeq: verdict.seq });
  });

  test("[验收线 1] a local manual MCP ticket is not adopted (no take_review / checkout record): zero adoption, planner refuses, manual MQ", async () => {
    f = autoFixture();
    await toRound2(f);
    await toManual(f);
    expect(mcpReview(f)).toMatchObject({ ok: true });
    withPr(f);
    const before = sideTables(f);
    expect(await resume(f)).toMatchObject({ ok: true });
    const ev = events(f);
    expect(ev.some((e) => e.data.op === ADOPT_OP)).toBe(false);
    expect(ev.findLast((e) => e.data.op === "workflow_resume")!.data.reviewSource).toMatchObject({ refused: expect.stringMatching(/领单与独立检出/) });
    expect(sideTables(f)).toEqual(before);
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
    expect(() => writeMerge(f)).toThrow("合并前缺本轮审查派单回执");
    expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
  });

  test("a scheduler (MAN2) hand-back never adopts, and an auto card without adoption reads no source", async () => {
    f = autoFixture();
    await toRound2(f);
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
    expect(autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 5_000_000 }).adoptedSource).toBeNull();
    await toManual(f);
    await peerReview(f);
    expect(await resume(f, "scheduler")).toMatchObject({ ok: false, code: "forbidden" });
    expect(events(f).some((e) => e.data.op === ADOPT_OP)).toBe(false);
  });
});
