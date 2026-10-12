/**
 * AUTOACK2 [验收线 3] / [验收线 4]: the localReviewAdopt switch and drift. off = the refusal is the pre-change text, no localObserve, zero
 * adoption; observe (default) = same refusal plus localObserve (「会承接」 or the local reason); on adopts. An adopted manual_local source
 * lapses in all three places (planner snapshot, merge intent write, merge begin) when the switch leaves on, and again after head / spec /
 * adopter rights / newer review / report drift; back on, it holds again. The reviewer is neither bound nor sent an engine review, so no
 * ordinary receipt can stand in. manual_peer (AUTOACK1) adoption ignores the switch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { adopted, events, plan, resume, toManual, toRound2, withPr, writeMerge, type Fx } from "./scheduler-manual-review-source-fixture.test.js";
import { addReviewer, adoptEvent, assignRv, cleanup, NOT_POOL, resumeEvent, setMode, submit, take, verdictEvent } from "./scheduler-manual-review-local-fixture.test.js";

let f: Fx;
afterEach(() => { f?.close(); cleanup(); });

/** The full evidence of [验收线 1] (take + clean checkout + verdict); `taken: false` leaves the take out. */
async function evidence(taken = true): Promise<void> {
  f = autoFixture();
  await toRound2(f);
  await toManual(f);
  withPr(f);
  addReviewer(f);
  assignRv(f);
  if (taken) await take(f);
  expect(submit(f)).toMatchObject({ ok: true });
}

const source = () => resumeEvent(f).data.reviewSource as { refused?: string; reviewSeq?: number; localObserve?: string };

/** Adopted under on and moved to merge by the planner: the merge plan stands before any change. */
async function atMerge(): Promise<void> {
  setMode("on");
  await evidence();
  expect(await resume(f)).toMatchObject({ ok: true });
  expect(adoptEvent(f)).toMatchObject({ data: { kind: "manual_local" } });
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  expect(plan(f)).toMatchObject({ kind: "intent", action: "merge" });
}

function allRefuse(why: RegExp): void {
  expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
  const fact = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: 5_000_000 }).adoptedSource as { ok: boolean; why?: string };
  expect(fact).toMatchObject({ ok: false });
  expect(fact.why).toMatch(why);
  expect(plan(f)).toMatchObject({ kind: "escalate" });
  expect(() => writeMerge(f, "mq-drift")).toThrow();
  expect(() => mergeReviewProof(f.db, f.task(), getWorkflow(f.db, "T1")!)).toThrow("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
}

describe("AUTOACK2 [验收线 3] the localReviewAdopt switch", () => {
  test("off: the refusal is the pre-change text word for word, no localObserve, zero adoption", async () => {
    setMode("off");
    await evidence();
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(adoptEvent(f)).toBeUndefined();
    expect(source()).toEqual({ refused: NOT_POOL, reviewSeq: verdictEvent(f).seq });
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
  });

  test("observe (default, no policy file): full evidence still not adopted; refused is the original, localObserve 「会承接」", async () => {
    await evidence();
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(adoptEvent(f)).toBeUndefined();
    expect(source()).toEqual({ refused: NOT_POOL, reviewSeq: verdictEvent(f).seq, localObserve: "会承接" });
    expect(events(f).filter((e) => e.kind === "scheduler" && String(e.data.op).includes("observe"))).toEqual([]); // no extra event
  });

  test("observe with incomplete evidence: localObserve carries the local reason", async () => {
    setMode("observe");
    await evidence(false);
    expect(await resume(f)).toMatchObject({ ok: true });
    expect(source()).toMatchObject({ refused: NOT_POOL, localObserve: expect.stringMatching(/^本机人工结论缺可核的领单与独立检出证据：没有 T1:review:r2/) });
  });

  test("adopted under on, then observe / off before the first merge begin: all three places refuse; back on they pass", async () => {
    await atMerge();
    for (const mode of ["observe", "off"] as const) {
      setMode(mode);
      allRefuse(new RegExp(`localReviewAdopt 现在是 ${mode}`));
      expect(plan(f)).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
      expect(() => writeMerge(f, `mq-${mode}`)).toThrow("合并前缺本轮审查派单回执");
    }
    setMode("on");
    expect(plan(f)).toMatchObject({ kind: "intent", action: "merge" });
    writeMerge(f, "mq-1");
    settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: "mq-1", from: "pending", to: "submitted", receipt: "claimed" });
    setMode("off");
    expect(() => beginMergeRun(f.db, { actor: "scheduler", now: 7_000_005 }, "mq-1", ["test"])).toThrow("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
    setMode("on");
    expect(beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, "mq-1", ["test"])).toMatchObject({ duplicate: false, run: { phase: "ready" } });
  });

  test("a manual_peer adoption (AUTOACK1) ignores the switch: off still adopts and merges", async () => {
    setMode("off");
    f = autoFixture();
    await adopted(f);
    expect(adoptEvent(f)).toMatchObject({ data: { kind: "manual_peer" } });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    withPr(f);
    expect(plan(f)).toMatchObject({ kind: "intent", action: "merge" });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toMatchObject({ kind: "manual_peer" });
  });
});

describe("AUTOACK2 [验收线 4] a manual_local adoption lapses with its window", () => {
  test("head moved", async () => {
    await atMerge();
    f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run("3".repeat(40));
    allRefuse(/人工审查承接不成立/);
  });

  test("spec revision moved", async () => {
    await atMerge();
    f.db.query("UPDATE tasks SET specRev = 2 WHERE id = 'T1'").run();
    allRefuse(/流程不是本规格版本/);
  });

  test("the adopting PM lost the project's rights", async () => {
    f = autoFixture();
    f.db.query(`UPDATE meta SET value = '["pm","pm2"]' WHERE project = 'p' AND key = 'pms'`).run();
    setMode("on");
    await toRound2(f);
    await toManual(f);
    withPr(f);
    addReviewer(f);
    assignRv(f);
    await take(f);
    expect(submit(f)).toMatchObject({ ok: true });
    expect(await resume(f, "pm2")).toMatchObject({ ok: true });
    expect(adoptEvent(f)).toMatchObject({ actor: "pm2", data: { kind: "manual_local" } });
    expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
    f.db.query(`UPDATE meta SET value = '["pm"]' WHERE project = 'p' AND key = 'pms'`).run();
    allRefuse(/pm2 现在没有本项目权限/);
  });

  test("a newer review was sent after the verdict", async () => {
    await atMerge();
    assignRv(f, "final_review");
    allRefuse(/新的审查/);
  });

  test("the original report was deleted", async () => {
    await atMerge();
    rmSync(String(verdictEvent(f).data.path));
    allRefuse(/报告读不到/);
  });
});
