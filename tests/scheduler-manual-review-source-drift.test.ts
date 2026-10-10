/**
 * AUTOACK1 [验收线 3]: an adoption holds only for the head / spec / round / workflow rev and ticket it was made for, while no newer
 * review step / pool review supersedes it and the adopting PM keeps the project's rights — after any drift the planner snapshot, the
 * merge intent write and the merge begin all refuse (with their old reasons; one predicate, adoptionCheck). With a valid adoption the
 * other gates (freeze, UI) still refuse, and an ordinary auto card with a stranger reviewer session is still reviewer_replaced.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setFrozen } from "../src/lib/ledger-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { adoptedReviewSource } from "../src/lib/scheduler-manual-review-source.js";
import { beginMergeRun, mergeReviewProof } from "../src/lib/scheduler-merge.js";
import { autoFixture } from "./scheduler-auto-helpers.js";
import { adopted, events, type Fx, plan, toRound2, withPr, writeMerge } from "./scheduler-manual-review-source-fixture.test.js";

let f: Fx;
afterEach(() => f?.close());
const H3 = "3".repeat(40);

/** Adopted, moved to merge by the planner, PR coordinates on the card: every gate passes before the drift. */
async function atMerge(adopter = "pm"): Promise<Fx> {
  f = autoFixture();
  if (adopter !== "pm") f.db.query(`UPDATE meta SET value = '["pm","${adopter}"]' WHERE project = 'p' AND key = 'pms'`).run();
  await adopted(f, adopter);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  withPr(f);
  expect(plan(f)).toMatchObject({ kind: "intent", action: "merge" });
  return f;
}

/** All three places refuse, each with its own pre-existing reason; the planner snapshot carries the same check's refusal. */
function allRefuse(fx: Fx, why?: RegExp) {
  expect(adoptedReviewSource(fx.db, fx.task(), getWorkflow(fx.db, "T1")!)).toBeNull();
  const fact = autoSnapshot(fx.db, fx.task(), { registry: [], maxWorkers: 2, now: 5_000_000 }).adoptedSource;
  expect(fact).toMatchObject({ ok: false });
  if (why) expect((fact as { why: string }).why).toMatch(why);
  expect(plan(fx)).toMatchObject({ kind: "escalate" });
  expect(() => writeMerge(fx)).toThrow();
  expect(() => mergeReviewProof(fx.db, fx.task(), getWorkflow(fx.db, "T1")!)).toThrow("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
}

describe("AUTOACK1: the adoption lapses with its window", () => {
  test("head moved (a real fix head cannot pose as a carry)", async () => {
    await atMerge();
    f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T1'").run(H3);
    allRefuse(f);
  });

  test("spec revision moved", async () => {
    await atMerge();
    f.db.query("UPDATE tasks SET specRev = 2 WHERE id = 'T1'").run();
    allRefuse(f);
  });

  test("round moved", async () => {
    await atMerge();
    f.db.query("UPDATE tasks SET round = 3 WHERE id = 'T1'").run();
    allRefuse(f);
  });

  test("workflow rev moved (taken back to manual and handed back again without a source)", async () => {
    await atMerge();
    f.db.query("UPDATE task_workflows SET rev = rev + 1 WHERE taskId = 'T1'").run();
    allRefuse(f);
    expect(() => writeMerge(f)).toThrow("不是调度器派的");
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "merge_review_unproven" });
  });

  test("a newer review supersedes the adopted one: a final_review step assigned after the adoption (new-review-1)", async () => {
    await atMerge();
    assignStep(f.db, f.at("pm"), { taskId: "T1", step: "final_review", executor: "agent-rv-d", executorKind: "agent" });
    allRefuse(f, /新的审查/);
    expect(() => writeMerge(f)).toThrow();
  });

  test("a newer review supersedes the adopted one: a review step reassigned after the adoption", async () => {
    await atMerge();
    assignStep(f.db, f.at("pm"), { taskId: "T1", step: "review", executor: "agent-rv-d", executorKind: "agent" });
    allRefuse(f, /新的审查/);
  });

  test("a security card's reviews stay local: a pool ticket adopted before the template became security lapses", async () => {
    await atMerge();
    f.db.query("UPDATE task_workflows SET template = 'security' WHERE taskId = 'T1'").run();
    allRefuse(f, /security 卡审查只在本机/);
  });

  test("the adopting PM loses the project's rights (adopter-auth-1): the original assigner keeps them, the adoption still lapses", async () => {
    await atMerge("pm2");
    expect(events(f).findLast((e) => e.data.op === "manual_review_adopt")!.actor).toBe("pm2");
    f.db.query("UPDATE meta SET value = '[\"pm\"]' WHERE project = 'p' AND key = 'pms'").run();
    allRefuse(f, /pm2 现在没有本项目权限/);
    expect(() => writeMerge(f)).toThrow("不是调度器派的"); // the old pool receipt gate, its own words
  });

  test("the original report disappears (planner-source-1): the planner refuses with the gates, review→merge never planned", async () => {
    await atMerge();
    const path = String(events(f).findLast((e) => e.kind === "review")!.data.path);
    rmSync(path);
    allRefuse(f, /报告读不到/);
    f.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'T1'").run();
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "review_unsolicited" });
  });
});

describe("AUTOACK1: the other gates are untouched by an adoption", () => {
  test("a frozen queue still waits in the planner and refuses the merge write and begin", async () => {
    await atMerge();
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const merge = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge'").get() as { id: string };
    settleIntent(f.db, { actor: "scheduler", now: 7_000_000 }, { id: merge.id, from: "pending", to: "submitted", receipt: "claimed" });
    setFrozen(f.db, f.at("pm"), { project: "p", frozen: true, reason: "发版" });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).not.toBeNull();
    expect(() => beginMergeRun(f.db, { actor: "scheduler", now: 7_000_010 }, merge.id, ["test"])).toThrow("项目合并队列已冻结");
    expect(() => writeMerge(f, "mq-2")).toThrow("项目合并队列已冻结");
    expect(plan(f)).toMatchObject({ kind: "wait", code: "queue_frozen" });
  });

  test("a merge intent still in flight is not doubled", async () => {
    await atMerge();
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    expect(() => writeMerge(f, "mq-2")).toThrow();
    expect(plan(f)).toMatchObject({ kind: "wait" });
  });
});

describe("ordinary auto continuity is unchanged", () => {
  test("an auto card whose reviewer binding now names a stranger session is still reviewer_replaced", async () => {
    f = autoFixture();
    await toRound2(f);
    expect(plan(f)).toMatchObject({ kind: "intent", action: "review", recipient: "agent-rv-t1" });
    f.db.query("UPDATE scheduler_sessions SET sessionId = 's-stranger' WHERE taskId = 'T1' AND role = 'reviewer'").run();
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "reviewer_replaced" });
    expect(adoptedReviewSource(f.db, f.task(), getWorkflow(f.db, "T1")!)).toBeNull();
  });
});

describe("AUTOACK1 on a ui card", () => {
  test("an adopted pass still goes to the screenshot acceptance, never straight to merge; forced into merge, the ui gate refuses", async () => {
    f = autoFixture({ template: "ui" });
    await adopted(f);
    const next = plan(f);
    expect(next).not.toMatchObject({ kind: "intent", action: "stage", targetStage: "merge" });
    expect(next).toMatchObject({ kind: "intent", action: "ask" });
    f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'T1'").run();
    withPr(f);
    expect(plan(f)).toMatchObject({ kind: "escalate", code: "merge_ui_unapproved" });
    expect(() => writeMerge(f)).toThrow();
  });
});
