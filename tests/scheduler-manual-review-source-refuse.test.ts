/**
 * AUTOACK1 [验收线 2]: what the PM hand-back must not adopt. Each case resumes through the real CLI and checks: no adoption event,
 * the reason on the resume event, no intent / session / resource row written, and the old gates (planner, merge write, merge begin) still refuse.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { ADOPT_OP, adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { events, finding, H2, mcpReview, peerReview, plan, resume, reviewsDir, sideTables, toManual, toRound2, type Fx } from "./scheduler-manual-review-source-fixture.test.js";

let f: Fx;
afterEach(() => f?.close());

/** A CLI `ledger review` of round 2 (no MCP ticket): PM recording someone's report, or a reviewer writing it by hand. */
const cliReview = (fx: Fx, actor: string, reviewer: string, session: string, family: string) => {
  const rows = join(fx.dir, `rows-${reviewer}.json`);
  writeFileSync(rows, "[]");
  const report = join(reviewsDir(fx), `T1-r2-${reviewer}.md`);
  writeFileSync(report, "# 报告\n");
  return fx.cli(actor, "review", "T1", "--reviewer", reviewer, "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", H2,
    "--session", session, "--family", family, "--findings", rows, "--path", report);
};

/** Resume, then: refused with `why`, nothing adopted or written, and every gate as before. */
async function refused(fx: Fx, why: RegExp) {
  const before = sideTables(fx);
  expect(await resume(fx)).toMatchObject({ ok: true });
  const ev = events(fx);
  expect(ev.some((e) => e.data.op === ADOPT_OP)).toBe(false);
  const mark = ev.findLast((e) => e.data.op === "workflow_resume")!.data.reviewSource as { refused: string };
  expect(mark.refused).toMatch(why);
  expect(sideTables(fx)).toEqual(before);
  expect(adoptedReviewSource(fx.db, fx.task(), getWorkflow(fx.db, "T1")!)).toBeNull();
  expect(plan(fx)).toMatchObject({ kind: "escalate" });
  expect(plan(fx)).not.toMatchObject({ kind: "intent" });
}

async function manualRound2(): Promise<Fx> {
  f = autoFixture();
  await toRound2(f);
  await toManual(f);
  return f;
}

const NO_TICKET = /签票据/;

describe("AUTOACK1: no adoption without a complete, current signed ticket on the PM's pool order", () => {
  test("S2G2 shape: a PM-recorded same-family report is refused (no ticket, author family)", async () => {
    await manualRound2();
    expect(await cliReview(f, "pm", "agent-ex", "s-ex", "claude")).toMatchObject({ ok: true });
    await refused(f, NO_TICKET);
  });

  test("a PM CLI copy of a cross-family report has no ticket", async () => {
    await manualRound2();
    expect(await cliReview(f, "pm", "agent-rv-b", "s-rvb", "codex")).toMatchObject({ ok: true });
    await refused(f, NO_TICKET);
  });

  test("forged session: the reviewer cannot hand-write a verdict; a PM copy naming another session has no ticket", async () => {
    await manualRound2();
    expect(await cliReview(f, "agent-rv-t1", "agent-rv-t1", "s-fake", "codex")).toMatchObject({ ok: false });
    expect(await cliReview(f, "pm", "agent-rv-b", "s-forged", "codex")).toMatchObject({ ok: true });
    await refused(f, NO_TICKET);
  });

  test("a CLI copy posing as the pool verdict (peer: reviewer, lend: session) is refused by the pool proof", async () => {
    await manualRound2();
    expect(await cliReview(f, "pm", "peer:mate", "lend:mate:lend:T1:s1:r2:a0", "codex")).toMatchObject({ ok: true });
    await refused(f, /出借池审查回执不成立：结论不是 lend-write 入账的/);
  });

  test("a local manual MCP ticket (cross- or same-family) is not adopted: no take_review / checkout record", async () => {
    await manualRound2();
    expect(mcpReview(f, { agent: "agent-rv-c", session: "s-rvc", family: "claude" })).toMatchObject({ ok: true, sameFamily: true });
    await refused(f, /领单与独立检出/);
  });

  test("B skipped take_review: the ticket failed at entry and the pool proof refuses", async () => {
    await manualRound2();
    await peerReview(f, { take: false });
    await refused(f, /出借池审查回执不成立：.*缺 submit_verdict 票据/);
  });

  test("an open P1 is never adopted", async () => {
    await manualRound2();
    await peerReview(f, { verdict: "changes", findings: [finding("gate-1", "P1")] });
    await refused(f, /P0 \/ P1/);
  });

  test("the original report must still be readable", async () => {
    await manualRound2();
    await peerReview(f);
    rmSync(String(events(f).findLast((e) => e.kind === "review")!.data.path));
    await refused(f, /报告/);
  });

  test("a review step assigned after the verdict (a review may be running) is refused", async () => {
    await manualRound2();
    await peerReview(f);
    assignStep(f.db, f.at("pm"), { taskId: "T1", step: "review", executor: "agent-rv-d", executorKind: "agent" });
    await refused(f, /新的审查/);
  });

  test("the author cannot review: no verdict, nothing to adopt", async () => {
    await manualRound2();
    expect(mcpReview(f, { agent: "agent-task-one", session: "s-one", family: "claude" })).toMatchObject({ ok: false, error: "self_review" });
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(events(f).some((e) => e.data.op === ADOPT_OP)).toBe(false);
  });

  test("an intent with an unknown outcome refuses the whole hand-back: nothing written", async () => {
    await manualRound2();
    await peerReview(f);
    const first = (f.db.query("SELECT id FROM scheduler_intents ORDER BY eventSeq LIMIT 1").get() as { id: string }).id;
    f.db.query("UPDATE scheduler_intents SET status = 'unknown' WHERE id = ?").run(first);
    const n = events(f).length, before = sideTables(f);
    expect(await resume(f)).toMatchObject({ ok: false, code: "conflict" });
    expect(events(f).length).toBe(n);
    expect(sideTables(f)).toEqual(before);
  });

  test("a hand-back by the reviewer itself (as PM) does not adopt its own verdict", async () => {
    await manualRound2();
    f.db.query("UPDATE meta SET value = '[\"pm\",\"agent-rv-b\"]' WHERE project = 'p' AND key = 'pms'").run();
    expect(mcpReview(f)).toMatchObject({ ok: true });
    expect(await resume(f, "agent-rv-b")).toMatchObject({ ok: true });
    expect(events(f).some((e) => e.data.op === ADOPT_OP)).toBe(false);
    expect(events(f).findLast((e) => e.data.op === "workflow_resume")!.data.reviewSource).toMatchObject({ refused: expect.stringMatching(/自己/) });
  });
});
