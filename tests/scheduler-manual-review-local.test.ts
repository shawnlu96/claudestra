/**
 * AUTOACK2 [验收线 1] / [验收线 5]: a local manual MCP review with its own take (manual_review_taken, recorded once through the real
 * order-taken CLI) and checkout evidence is adopted on the PM hand-back (switch on): the planner moves review→merge, the merge intent
 * writer accepts it, the merge begins. Taking after the verdict is just as good. Old path (main): recordTaken skips the order, the
 * adoption is refused with 「领单与独立检出」 and the planner says review_unsolicited. Auto cards and other order ids are untouched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { recordTaken } from "../src/lib/order-mark.js";
import { submitVerdict } from "../src/lib/review-verdict.js";
import { adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { events, finding, H2, plan, resume, reviewsDir, sideTables, toManual, toRound2, withPr, writeMerge, type Fx } from "./scheduler-manual-review-source-fixture.test.js";
import { addReviewer, adoptEvent, assignRv, cleanup, resumeEvent, RV, RV_SESSION, setMode, submit, take, verdictEvent } from "./scheduler-manual-review-local-fixture.test.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

let f: Fx;
afterEach(() => { f?.close(); cleanup(); });

/** Round 2 under PM, RV registered with its own checkout, the r2 review assigned to it. Returns the assign event. */
async function ready(): Promise<{ assignSeq: number; rvDir: string }> {
  f = autoFixture();
  await toRound2(f);
  await toManual(f);
  withPr(f);
  const rvDir = addReviewer(f);
  return { assignSeq: assignRv(f).seq, rvDir };
}

describe("AUTOACK2 local manual review adoption", () => {
  test("[验收线 1] take (once) + checkout + verdict → PM hand-back adopts manual_local; planner, merge write and merge begin follow", async () => {
    setMode("on");
    const { assignSeq, rvDir } = await ready();
    const before = sideTables(f);
    const t = await take(f);
    expect(t).toMatchObject({ orderId: "T1:review:r2", runs: 1, marked: ["T1:review:r2"] });
    const again = await take(f);
    expect(again).toMatchObject({ runs: 0, marked: [] }); // already recorded: no manager
    const taken = events(f).filter((e) => e.data.op === "manual_review_taken");
    expect(taken).toHaveLength(1);
    expect(taken[0]).toMatchObject({ actor: RV, kind: "scheduler", data: { orderId: "T1:review:r2", step: "review", round: 2, specRev: 1, head: H2,
      sessionId: RV_SESSION, family: "codex", assignSeq } });
    expect(submit(f)).toMatchObject({ ok: true, duplicate: false });
    const verdict = verdictEvent(f);
    expect(verdict).toMatchObject({ actor: RV, dedupKey: `verdict:T1:review:r2@${H2}`, data: { via: "mcp", orderId: "T1:review:r2", checkout: { ok: true, dir: rvDir, head: H2 } } });
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(sideTables(f)).toEqual(before); // take, verdict and resume write no intent / session / resource row
    const adopt = adoptEvent(f)!;
    expect(adopt).toMatchObject({ actor: "pm", data: { category: "manual", kind: "manual_local", reviewSeq: verdict.seq, takenSeq: taken[0]!.seq, assignSeq,
      orderId: "T1:review:r2", reviewer: RV, sessionId: RV_SESSION, family: "codex", head: H2, round: 2, specRev: 1 } });
    expect(resumeEvent(f).data.reviewSource).toMatchObject({ adopted: adopt.seq, reviewSeq: verdict.seq, kind: "manual_local" });
    // old path (adoption ignored) vs. the adopted planner
    expect(plan(f, true)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "merge" });
    expect(await f.tick()).toMatchObject({ step: "merge_queue" }); // the real intent writer (requireReviewedMerge) accepted it
    const merge = f.db.query("SELECT id, status FROM scheduler_intents WHERE action = 'merge'").get() as { id: string; status: string };
    settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: merge.id, from: "pending", to: "submitted", receipt: "claimed" });
    expect(mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ eventSeq: verdict.seq, reviewer: RV });
    expect(beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, merge.id, ["test"])).toMatchObject({ duplicate: false, run: { phase: "ready", reviewedHead: H2 } });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ kind: "manual_local", agent: RV });
  });

  test("[验收线 1] the bridge records the take after the verdict landed: the adoption holds all the same", async () => {
    setMode("on");
    const { assignSeq } = await ready();
    expect(submit(f)).toMatchObject({ ok: true });
    const t = await take(f);
    expect(t).toMatchObject({ runs: 1, marked: ["T1:review:r2"] });
    const verdict = verdictEvent(f);
    const taken = events(f).find((e) => e.data.op === "manual_review_taken")!;
    expect(taken.seq).toBeGreaterThan(verdict.seq);
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(adoptEvent(f)).toMatchObject({ data: { kind: "manual_local", reviewSeq: verdict.seq, takenSeq: taken.seq, assignSeq } });
    expect(plan(f)).toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
  });

  test("[验收线 1] a re-take after the material changed (spec rev) is a new record; the same material is not", async () => {
    await ready();
    expect((await take(f)).runs).toBe(1);
    expect((await take(f)).runs).toBe(0);
    f.db.query("UPDATE tasks SET specRev = 2 WHERE id = 'T1'").run();
    expect((await take(f)).marked).toEqual(["T1:review:r2"]);
    expect(events(f).filter((e) => e.data.op === "manual_review_taken").map((e) => e.data.specRev)).toEqual([1, 2]);
  });

  test("[验收线 1] order-taken refuses a manual review order that is not the caller's, or a session that is not its registry session", async () => {
    await ready();
    expect(await f.cli("agent-task-one", "order-taken", "T1:review:r2", "--session", "s-one")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli(RV, "order-taken", "T1:review:r2", "--session", "s-other")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await f.cli(RV, "order-taken", "T1:review:r1", "--session", RV_SESSION)).toMatchObject({ ok: false, code: "forbidden" });
    expect(events(f).some((e) => e.data.op === "manual_review_taken")).toBe(false);
  });
});

describe("[验收线 5] unchanged paths", () => {
  test("order-taken still says not_found for ids that are neither an intent nor a local manual review order; write orders are not recorded", async () => {
    await ready();
    expect(await f.cli(RV, "order-taken", "nope", "--session", RV_SESSION)).toMatchObject({ ok: false, code: "not_found" });
    expect(await f.cli("agent-task-one", "order-taken", "T1:write:r0", "--session", "s-one")).toMatchObject({ ok: false, code: "not_found" });
    let runs = 0;
    const run = async () => { runs++; return { ok: true }; };
    expect(await recordTaken(f.db, { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" }, ["T1:write:r0", "T1:fix:r1"], run)).toEqual([]);
    expect(runs).toBe(0);
  });

  test("an auto card's submit_verdict (autoReviewWriter) carries no checkout", async () => {
    f = autoFixture();
    await toRound2(f);
    await f.tick(); // r2 review order to the bound reviewer
    const order = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'review' ORDER BY eventSeq DESC LIMIT 1").get() as { id: string };
    const report = join(reviewsDir(f), "T1-r2.md");
    writeFileSync(report, "# 审查报告\n");
    const me = { agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", verified: true };
    expect(submitVerdict(f.db, me, { v: 1, orderId: order.id, head: H2, verdict: "pass", p0: 0, p1: 0, p2: 1, findings: [finding("name-2", "P2")], reportPath: report },
      { registry: [{ name: "agent-task-one", runtime: "claude-code" }, { name: "agent-rv-t1", runtime: "codex" }], reviewsDir: reviewsDir(f), now: 900_000,
        registryPath: f.registryPath, gitHead: () => H2, gitDirty: () => null })).toMatchObject({ ok: true });
    const v = verdictEvent(f);
    expect(v.data).toMatchObject({ via: "mcp", orderId: order.id, reviewer: "agent-rv-t1" });
    expect("checkout" in v.data).toBe(false);
  });
});
