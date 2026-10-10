/**
 * AUTOACK1 [验收线 1]: a legal current cross-family MCP ticket, taken over from a card whose bound reviewer (s-rv) holds the session
 * history. Without the adoption the old path stops it; the PM hand-back adopts it explicitly and the planner, the merge intent write
 * (requireReviewedMerge) and the merge begin (mergeReviewProof) all accept the same adopted source — no engine ack / intent / bind written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { ADOPT_OP, adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { events, H2, mcpReview, resume, RV, RV_SESSION, sideTables, toManual, toRound2, type Fx } from "./scheduler-manual-review-source-fixture.test.js";

let f: Fx;
afterEach(() => f?.close());

export const plan = (fx: Fx, drop = false) => {
  const s = autoSnapshot(fx.db, fx.task(), { registry: [], maxWorkers: 2, now: 5_000_000 });
  return planScheduler(drop ? { ...s, events: s.events.filter((e) => e.data.op !== ADOPT_OP) } : s);
};
export const withPr = (fx: Fx) => fx.db.query("UPDATE tasks SET pr = 'https://github.com/o/r/pull/7', branch = 'task/T1' WHERE id = 'T1'").run();
/** The merge intent the planner asks for, through the real intent writer (requireReviewedMerge runs inside it). */
const projectSeq = (fx: Fx): number => (fx.db.query("SELECT MAX(seq) AS s FROM events WHERE project = 'p'").get() as { s: number }).s;
export const writeMerge = (fx: Fx, id = "mq-test") => planIntent(fx.db, { actor: "scheduler", now: 6_000_000 }, { id, taskId: "T1", taskRev: fx.task().rev,
  workflowRev: getWorkflow(fx.db, "T1")!.rev, causalSeq: projectSeq(fx), node: "merge_deploy", action: "merge", reason: "test", resources: ["merge:p"] });

/** Round-2 manual MCP verdict by agent-rv-b, then the PM hand-back. */
export async function adopted(fx: Fx) {
  await toRound2(fx);
  await toManual(fx);
  expect(mcpReview(fx)).toMatchObject({ ok: true });
  const before = sideTables(fx);
  const r = await resume(fx);
  expect(r).toMatchObject({ ok: true });
  expect(sideTables(fx)).toEqual(before); // no intent, session, slot or resource row written or changed by the adoption
  return r as Record<string, unknown>;
}

describe("AUTOACK1 adoption on the PM hand-back", () => {
  test("[验收线 1] the old path stops the legal MCP ticket; the explicit adoption drives planner, merge write and merge begin", async () => {
    f = autoFixture();
    const r = await adopted(f);
    const ev = events(f);
    const verdict = ev.findLast((e) => e.kind === "review")!;
    expect(verdict).toMatchObject({ actor: RV, dedupKey: `verdict:T1:review:r2@${H2}`, data: { via: "mcp", orderId: "T1:review:r2", reviewerSessionId: RV_SESSION } });
    const adopt = ev.find((e) => e.data.op === ADOPT_OP)!;
    expect(adopt).toMatchObject({ actor: "pm", kind: "scheduler", data: { category: "manual", kind: "manual_mcp", reviewSeq: verdict.seq, orderId: "T1:review:r2",
      reviewer: RV, sessionId: RV_SESSION, family: "codex", head: H2, round: 2, specRev: 1, workflowRev: getWorkflow(f.db, "T1")!.rev } });
    expect(verdict.seq).toBeLessThan(adopt.seq);
    const resumed = ev.findLast((e) => e.data.op === "workflow_resume")!;
    expect(resumed.data).toMatchObject({ manual: true, reviewSource: { adopted: adopt.seq, reviewSeq: verdict.seq, orderId: "T1:review:r2" } });
    expect(r.next).toMatchObject({ kind: "intent", action: "stage" });
    // nothing engine-shaped was made up: no session bind / ack / review intent for agent-rv-b, before or after
    expect(ev.filter((e) => e.data.op === "session_bind").map((e) => e.data.agent)).toEqual(["agent-task-one", "agent-rv-t1"]);
    expect(f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE recipient = ?").get(RV)).toEqual({ n: 0 });
    // old path (same ledger, adoption ignored): the bound reviewer's dispatch history refuses the ticket
    expect(plan(f, true)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    // old path at merge: merge_review_unproven; with the adoption the planner asks for the merge, and the real writer accepts it
    expect(plan(f, true)).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const merge = f.db.query("SELECT id, status FROM scheduler_intents WHERE action = 'merge'").get() as { id: string; status: string };
    expect(merge.status).toBe("pending");
    withPr(f);
    settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: merge.id, from: "pending", to: "submitted", receipt: "claimed" });
    expect(mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ eventSeq: verdict.seq, reviewer: RV });
    expect(beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, merge.id, ["test"])).toMatchObject({ duplicate: false, run: { phase: "ready", reviewedHead: H2 } });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ agent: RV, sessionId: RV_SESSION, reviewSeq: verdict.seq });
  });

  test("a scheduler (MAN2) hand-back never adopts, and an auto card without adoption reads no source", async () => {
    f = autoFixture();
    await toRound2(f);
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
    await toManual(f);
    expect(mcpReview(f)).toMatchObject({ ok: true });
    expect(await resume(f, "scheduler")).toMatchObject({ ok: false, code: "forbidden" });
    expect(events(f).some((e) => e.data.op === ADOPT_OP)).toBe(false);
  });
});
