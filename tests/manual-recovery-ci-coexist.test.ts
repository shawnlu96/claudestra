/**
 * CIRES1 next to the paths it must not disturb: other causes and people's moves are never taken (验收线 3), and after a hand-back
 * the planner, the merge driver, the train's candidate view and the bounce limit behave as they always did (验收线 5). The planner
 * knows this mechanism in one place only: in front of the bounce limit it reads the sealed proof (ciBounceSealed), which exists
 * only after an `on` hand-back and covers only the bounces counted then. Fixture: tests/manual-recovery-ci-kit.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { CI_MANUAL_RESUME, ciBounceSealed } from "../src/lib/manual-recovery-ci.js";
import { autoSnapshot } from "../src/lib/scheduler-auto-snapshot.js";
import { TRAIN_RERUN_SEEN_OP } from "../src/lib/scheduler-merge-ci-rerun.js";
import { mergeCandidates, trainCandidates } from "../src/lib/scheduler-merge-train-tick.js";
import { UNSENT_BOUNCE_LIMIT_REASON } from "../src/lib/scheduler-merge-unsent-plan.js";
import { getMergeRun } from "../src/lib/scheduler-merge.js";
import { planScheduler } from "../src/lib/scheduler-plan.js";
import { H2 } from "./scheduler-auto-helpers.js";
import { ci, ev, events, isolate, observed, policy, prove, reads, recover, reruns, RUN, run, state, turnOn, wf, type Ci, type Over } from "./manual-recovery-ci-kit.test.js";

isolate();
const resumes = (f: Ci) => ev(f, "workflow_resume");
/** What the planner would decide were the card auto right now (the ledger as it is, nothing excluded). */
const planned = (f: Ci) => {
  const s = autoSnapshot(f.db, f.task(), { registry: [], maxWorkers: 2, now: Date.now() });
  return planScheduler({ ...s, workflow: { ...s.workflow!, mode: "auto" } });
};
const fallback = (f: Ci, reason: string, actor = "scheduler") => f.cli(actor, "scheduler-fallback-manual", "T1", "--reason", reason);
const pendingMerge = (f: Ci) => (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'merge' AND status = 'pending'").get() as { id: string }).id;
const begin = async (f: Ci, id: string) => {
  expect(await f.cli("scheduler", "scheduler-settle", id, "--from", "pending", "--to", "submitted", "--receipt", "claimed")).toMatchObject({ ok: true });
  expect(await f.cli("scheduler", "scheduler-merge-begin", id, "--required-checks", "ci")).toMatchObject({ ok: true, run: { phase: "ready" } });
};
const note = (f: Ci, kind: LedgerEvent["kind"], text: string, data: Record<string, unknown>, actor = "scheduler") =>
  f.db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, ?, 'p', 'T1', ?, ?, ?)").run(f.at(actor).now, actor, kind, text, JSON.stringify(data));

describe("[验收线 1] the bounce limit yields to the sealed proof once, and only to it", () => {
  test("before the hand-back the planner escalates the limit; after it, it plans the merge; the card is never sent straight back", () => run({}, async (f) => {
    await turnOn(f);
    expect(planned(f)).toMatchObject({ kind: "escalate", code: "merge_bounce_limit" });
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "on", action: "resumed" })]);
    expect(planned(f)).toMatchObject({ kind: "intent", node: "merge_deploy", action: "merge" });
    for (let i = 0; i < 3; i++) await f.tick();
    expect(wf(f).mode).toBe("auto");
    expect(ev(f, "fallback_manual")).toHaveLength(1);
    expect(resumes(f)).toHaveLength(1);
    expect(pendingMerge(f)).toContain(":merge_deploy:a1");
  }));

  test("one more ci_fail bounce after the hand-back: the limit stands again, the card goes manual and stays there (no loop)", () => run({}, async (f) => {
    await turnOn(f);
    expect(await ci(f)).toEqual([expect.objectContaining({ action: "resumed" })]);
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    const again = pendingMerge(f);
    await begin(f, again);
    // the same head goes red again: the head's one re-run is spent, so the gate bounces it (the 5th)
    Object.assign(f.gh, { conclusion: "failure", mergeState: "UNSTABLE", checks: [{ name: "ci", bucket: "fail", link: `${RUN}/job/21` }] });
    for (let i = 0; i < 2 && getMergeRun(f.db, again)!.phase !== "resolved"; i++) await f.mergeTick();
    expect(ev(f, "merge_conflict").at(-1)!.data).toMatchObject({ intentId: again, cause: "ci_fail", count: 5, escalated: true });
    expect(ciBounceSealed(events(f), { id: again })).toBe(false);
    expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
    expect(wf(f).mode).toBe("manual");
    // green later or not, this run has no formal claim of its own: the mechanism leaves it with PM, tick after tick
    f.rerunGreen();
    f.gh.attempt = 3;
    const before = state(f);
    for (let i = 0; i < 3; i++) expect(await ci(f)).toEqual([expect.objectContaining({ action: "none", why: expect.stringContaining("没有 CIF1 / CIF8 的正式重跑授权") })]);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(state(f)).toEqual(before);
    expect(resumes(f)).toHaveLength(1);
    expect(ev(f, "fallback_manual")).toHaveLength(2);
    expect(reruns(f)).toBe(1);
    expect(planned(f)).toMatchObject({ kind: "escalate", code: "merge_bounce_limit" });
  }));

  test("off and observe: no proof exists, the planner's limit is word for word what it was; PM's own resume does not lift it either", () => run({}, async (f) => {
    const limit = planned(f);
    expect(limit).toMatchObject({ kind: "escalate", code: "merge_bounce_limit" });
    expect(await ci(f)).toEqual([expect.objectContaining({ mode: "observe", action: "would_resume" })]);
    expect(observed(f)).toHaveLength(1); // the note carries a proof, but a note is not a hand-back
    expect(ciBounceSealed(events(f), { id: f.merge })).toBe(false);
    expect(planned(f)).toEqual(limit);
    await policy(f, "off", "ciManualResume");
    expect(await ci(f)).toEqual([]);
    expect(planned(f)).toEqual(limit);
    expect(await f.cli("pm", "workflow-resume", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--reason", "PM 交回")).toMatchObject({ ok: true });
    expect(ciBounceSealed(events(f), { id: f.merge })).toBe(false);
    expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("merge_bounce_limit") });
  }));

  test("ciBounceSealed: only the scheduler's current hand-back by this mechanism, for this intent, at this bounce count", () => {
    const bounce = (seq: number) => ({ seq, kind: "scheduler", actor: "scheduler", data: { op: "merge_conflict" } }) as unknown as LedgerEvent;
    const resume = (seq: number, proof: Record<string, unknown>, actor = "scheduler") =>
      ({ seq, kind: "scheduler", actor,
        data: { op: "workflow_resume", recoveryProof: { mechanism: CI_MANUAL_RESUME, cancelIntentId: "m4", episodeId: "e9.b2", ...proof } } }) as unknown as LedgerEvent;
    const base = [bounce(1), bounce(2)];
    expect(ciBounceSealed([...base, resume(10, {})], { id: "m4" })).toBe(true);
    expect(ciBounceSealed([...base, resume(10, {})], { id: "m5" })).toBe(false);
    expect(ciBounceSealed([...base, resume(10, {}), bounce(11)], { id: "m4" })).toBe(false); // one more bounce than the proof counted
    expect(ciBounceSealed([...base, resume(10, { mechanism: "ui-manual-resume" })], { id: "m4" })).toBe(false);
    expect(ciBounceSealed([...base, resume(10, { episodeId: "e9" })], { id: "m4" })).toBe(false);
    expect(ciBounceSealed([...base, resume(10, {}, "pm")], { id: "m4" })).toBe(false);
    const later = { seq: 12, kind: "scheduler", actor: "scheduler", data: { op: "fallback_manual" } } as unknown as LedgerEvent;
    expect(ciBounceSealed([...base, resume(10, {}), later], { id: "m4" })).toBe(false);
    expect(ciBounceSealed(base, { id: "m4" })).toBe(false);
  });
});

describe("[验收线 3] other causes, holds, unfinished work and people's moves are never handed back", () => {
  const request = (f: Ci) => appendEvent(f.db, f.at("pm"), { project: "p", target: "T1", kind: "decision", text: "人工合并",
    data: { op: "manual_merge_request", head: H2, specRev: 1, round: f.task().round, review: { seq: events(f).findLast((e) => e.kind === "review")!.seq } } });
  const hold = (f: Ci) => f.cli("pm", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev", String(wf(f).rev), "--template", "code", "--version", "2",
    "--mode", "manual", "--author-family", "claude", "--fallback", "只报错不修", "--reason-code", "pm_hold", "--reason", "PM 先压住");
  const cases: [string, Over, (f: Ci) => unknown, string][] = [
    ["cause=conflict 的上限", { conflict: true }, () => {}, "原因是 conflict"],
    ["未发出取消累计的上限（没有退回原因）", { entry: false }, (f) => fallback(f, `merge_bounce_limit：${UNSENT_BOUNCE_LIMIT_REASON}`), "阻塞链没有 cause=ci_fail"],
    ["取消原因不明（重试理由指的意图没有退回记录）", { entry: false },
      (f) => fallback(f, "merge_retry_requires_pm：合并意图 nope 已取消，先由 PM 核对外部结果"), "已取消的自动合并"],
    ["别的原子原因", { entry: false }, (f) => fallback(f, "merge_review_missing：缺审查"), ""],
    ["PM 自己接管（不是调度器从 auto 退回）", { entry: false },
      (f) => fallback(f, "merge_bounce_limit：反复冲突，可能和别的卡长期改同一处，需要 PM 排期", "pm"), ""],
    ["PM hold 压在后面", {}, async (f) => expect(await hold(f)).toMatchObject({ ok: true }), ""],
    ["卡还在 fix", {}, (f) => f.db.query("UPDATE tasks SET stage = 'fix' WHERE id = 'T1'").run(), "卡在 fix"],
    ["卡还在 review", {}, (f) => f.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'T1'").run(), "卡在 review"],
    ["有活的人工合并请求", {}, request, "人工合并请求"],
    ["合并 journal 还是 unknown（未结清）", {}, (f) => f.db.query("UPDATE scheduler_merges SET phase = 'unknown' WHERE intentId = ?").run(f.merge), "合并未正式结清"],
    ["journal 进过 merging（外部结果未知）", {}, (f) => note(f, "scheduler", "合并队列", { op: "merge_phase", intentId: f.merge, from: "ready", to: "merging" }), "进过 merging"],
    ["主线门不放行（合并队列冻结）", {}, (f) => f.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'queueFrozen', ?)")
      .run(JSON.stringify({ frozen: true, reason: "main 红", since: 1 })), "合并队列冻结"],
    ["这个 head 还有列车 / 人工的重跑记录", {},
      (f) => note(f, "note", "列车重跑", { op: TRAIN_RERUN_SEEN_OP, prHead: H2, run: "https://github.com/example/repo/actions/runs/90" }), "别的重跑记录"],
    ["审查不再通过（要修复 / 新审查）", {}, (f) => f.db.query("DELETE FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'reviewer'").run(), "现有审查闸不认"],
    ["规格改了", {}, (f) => f.db.query("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'").run(), "规格已变"],
    ["进 manual 之后 PM 已结过这次合并", {}, (f) => note(f, "scheduler", "PM 结清", { op: "merge_resolve", intentId: f.merge, outcome: "cancelled", manual: true }, "pm"), "不抢回"],
  ];
  for (const [what, over, twist, why] of cases) test(`${what} → not handed back; bounce count and stage untouched`, () => run(over, async (f) => {
    await turnOn(f);
    await twist(f);
    expect(wf(f).mode).toBe("manual");
    const before = state(f), sent = reruns(f);
    expect(await prove(f)).toMatchObject({ kind: "refused", why: expect.stringContaining(why) });
    expect((await ci(f)).some((o) => o.action === "resumed" || o.action === "would_resume")).toBe(false);
    expect(await recover(f, "on")).toMatchObject({ ok: false });
    expect(state(f)).toEqual(before);
    expect(ev(f, "workflow_resume").filter((e) => e.actor === "scheduler")).toHaveLength(0);
    expect(observed(f)).toHaveLength(0);
    expect(reruns(f)).toBe(sent);
  }));

  for (const [what, move] of [["人工合并请求", request], ["PM hold", hold]] as const) test(`${what} lands between the read and the write → PM's move stands`, () => run({}, async (f) => {
    await turnOn(f);
    const pmFirst = async (...a: string[]) => { await move(f); return f.manager(...a); };
    expect(await ci(f, pmFirst)).toEqual([expect.objectContaining({ action: "refused" })]);
    const after = state(f);
    for (let i = 0; i < 2; i++) expect((await ci(f)).every((o) => o.action === "none")).toBe(true);
    expect(state(f)).toEqual(after);
    expect(resumes(f).filter((e) => e.actor === "scheduler")).toHaveLength(0);
    expect(wf(f).mode).toBe("manual");
  }));

  test("a retry entry naming the settled ci_fail bounce is judged on the same evidence (no such entry is reachable from the planner today)", () => run({ entry: false }, async (f) => {
    await turnOn(f);
    expect(await fallback(f, `merge_retry_requires_pm：合并意图 ${f.merge} 已取消，先由 PM 核对外部结果`)).toMatchObject({ ok: true });
    f.rerunGreen();
    expect(await prove(f)).toMatchObject({ kind: "candidate", proof: { subreason: "merge_retry_requires_pm", cancelIntentId: f.merge } });
  }));
});

describe("[验收线 5] after the hand-back the existing paths do the rest, unchanged", () => {
  test("the hand-back reads GitHub and nothing else: no merge, no update, no re-run, no run, no deploy", () => run({}, async (f) => {
    await turnOn(f);
    const calls = f.gh.calls.length, before = state(f);
    expect(await ci(f)).toEqual([expect.objectContaining({ action: "resumed" })]);
    expect(f.gh.calls.slice(calls).every((c) => c.startsWith("read:"))).toBe(true);
    expect(reads(f)).toBeGreaterThan(0);
    expect({ ...state(f), workflow: before.workflow }).toEqual(before);
    // the cancelled run is released through the planner's own check (mergeRetryReleased → the sealed proof), not around it
    expect(ev(f, "manual_recovery_proof")[0].data).toMatchObject({ next: { kind: "intent", node: "merge_deploy", action: "merge" } });
  }));

  test("candidates are picked by the card's own type and proof; the driver re-reads the whole CI before it merges, once", () => run({}, async (f) => {
    await turnOn(f);
    expect(mergeCandidates(f.db, "p", { now: Date.now() })).toEqual([]); // manual: nobody's candidate
    expect(trainCandidates(f.db, "p")).toEqual([]);
    await ci(f);
    expect(await f.tick()).toMatchObject({ step: "merge_queue" });
    expect(mergeCandidates(f.db, "p", { now: Date.now() }).map((c) => c.taskId)).toEqual(["T1"]);
    expect(trainCandidates(f.db, "p").every((c) => c.taskId === "T1")).toBe(true); // a code card like any other: no extra seat, no skipped gate
    const id = pendingMerge(f);
    await begin(f, id);
    // a pending check: the driver waits, the recovery proof is no shortcut past its own inspect
    f.gh.checks = [{ name: "ci", bucket: "pending", link: `${RUN}/job/30` }];
    f.gh.mergeState = "UNSTABLE";
    for (let i = 0; i < 2; i++) await f.mergeTick();
    expect(f.gh.calls).not.toContain("merge");
    f.rerunGreen();
    const from = f.gh.calls.length;
    for (let i = 0; i < 4; i++) await f.mergeTick();
    const tail = f.gh.calls.slice(from);
    expect(tail.filter((c) => c === "merge")).toHaveLength(1);
    expect(tail.indexOf("inspect")).toBeLessThan(tail.indexOf("merge"));
    expect(getMergeRun(f.db, id)).toMatchObject({ phase: "merged" });
    expect(reruns(f)).toBe(1);
    expect(state(f).deploys.length).toBeLessThanOrEqual(1);
    expect(await ci(f)).toEqual([]);
    expect(resumes(f)).toHaveLength(1);
  }));
});
