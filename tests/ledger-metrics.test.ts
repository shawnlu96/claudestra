/** 台账指标（src/lib/ledger-metrics.ts）：设计稿 §3「指标」逐条一个用例，外加一条用真实写入产生的事件跑通 */
import { describe, expect, test } from "bun:test";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import type { EventKind, LedgerEvent, Stage, TaskKind } from "../src/lib/ledger-stages.js";
import { createTask, deliver, moveStage, recordReview } from "../src/lib/ledger-write.js";
import { stageTimeline, taskMetrics } from "../src/lib/ledger-metrics.js";

let seq = 0;
function ev(ts: number, kind: EventKind, data: Record<string, unknown> = {}, target = "T"): LedgerEvent {
  return { seq: ++seq, ts, actor: "x", project: "p", target, kind, text: "", data, dedupKey: null };
}
const created = (ts: number, stage?: Stage) => ev(ts, "task", { op: "new", patch: stage ? { stage } : {} });
const to = (ts: number, stage: Stage, from?: Stage) => ev(ts, "stage", from ? { from, to: stage } : { to: stage });
const review = (ts: number, p0 = 0, p1 = 0, p2 = 0) => ev(ts, "review", { p0, p1, p2 });
const m = (kind: TaskKind, events: LedgerEvent[], now = 1000) => taskMetrics({ id: "T", kind }, events, now);

describe("起点与终点", () => {
  test("code：起点 = 第一次进 restate，终点 = 进 verified（不是 done）", () => {
    const r = m("code", [created(0), to(10, "restate"), to(20, "build"), to(30, "review"), to(40, "merge"), to(50, "live"), to(60, "verified"), to(90, "done")]);
    expect(r).toMatchObject({ startTs: 10, endTs: 60, totalMs: 50 });
  });
  test("ops：起点 = 第一次进 build", () => {
    const r = m("ops", [created(0), to(15, "build"), to(25, "review"), to(35, "merge"), to(45, "live"), to(55, "verified")]);
    expect(r).toMatchObject({ startTs: 15, endTs: 55, totalMs: 40 });
  });
  test("investigate：终点 = 进 done", () => {
    const r = m("investigate", [created(0), to(10, "restate"), to(20, "build"), to(30, "review"), to(70, "done")]);
    expect(r).toMatchObject({ startTs: 10, endTs: 70, totalMs: 60 });
  });
  test("没结束的算到 now；cancelled 算结束", () => {
    expect(m("code", [created(0), to(100, "restate"), to(200, "build")], 500)).toMatchObject({ endTs: null, totalMs: 400 });
    expect(m("code", [created(0), to(100, "restate"), to(300, "cancelled")], 500)).toMatchObject({ endTs: 300, totalMs: 200 });
  });
  test("spec→blocked 不算开工，起点是之后第一次进 restate", () => {
    const r = m("code", [created(0), to(10, "blocked", "spec"), to(50, "spec", "blocked"), to(60, "restate", "spec")], 100);
    expect(r).toMatchObject({ startTs: 60, totalMs: 40, blockedMs: 40 });
  });
  test("导入落在 build、后来 review→spec→restate：起点仍是导入时的 build，不挪到后面那次 restate", () => {
    const r = m("code", [created(10, "build"), to(20, "review"), to(30, "spec"), to(40, "restate")], 100);
    expect(r).toMatchObject({ startTs: 10, totalMs: 90 });
  });
  test("还没开始（停在 spec）总用时为 0；导入时直接落在 build 的 code 任务以第一次离开 spec 为起点", () => {
    expect(m("code", [created(0)], 500)).toMatchObject({ startTs: null, totalMs: 0, stageMs: { spec: 500 } });
    expect(m("code", [created(40, "build"), to(90, "review")], 100)).toMatchObject({ startTs: 40, totalMs: 60 });
  });
});

describe("分阶段用时", () => {
  test("同一阶段多次进入累加（review 三段、fix 两段）", () => {
    const r = m("code", [
      created(0), to(10, "restate"), to(20, "build"), to(30, "review"), to(40, "fix"), to(60, "review"), to(65, "fix"), to(80, "review"), to(100, "merge"),
    ], 110);
    expect(r.stageMs).toEqual({ spec: 10, restate: 10, build: 10, review: 10 + 5 + 20, fix: 20 + 15, merge: 10 });
  });
  test("blocked 单列，不进 stageMs、不计入干活用时", () => {
    const r = m("code", [created(0), to(10, "restate"), to(20, "build"), to(30, "blocked"), to(70, "build"), to(80, "review")], 100);
    expect(r.stageMs.blocked).toBeUndefined();
    expect(r.stageMs.build).toBe(10 + 10);
    expect(r).toMatchObject({ blockedMs: 40, totalMs: 90, workMs: 50 });
  });
  test("终态不计时；stageTimeline 的最后一段非终态延到 now", () => {
    const tl = stageTimeline([created(0), to(10, "restate"), to(20, "cancelled")], 99);
    expect(tl.at(-1)).toEqual({ stage: "cancelled", from: 20, to: 20 });
    expect(stageTimeline([created(0), to(10, "restate")], 99).at(-1)).toEqual({ stage: "restate", from: 10, to: 99 });
  });
});

describe("审查、返工、等复核、P 计数、回滚", () => {
  test("审查轮数 = review 事件数（live→fix→review 之后的也算）", () => {
    const r = m("code", [
      created(0), to(1, "restate"), to(2, "build"), to(3, "review"), review(4), to(5, "merge"), to(6, "live"), to(7, "fix"), to(8, "review"), review(9),
    ]);
    expect(r.reviewRounds).toBe(2);
  });
  test("返工次数 = 进入 fix 的次数（含 merge→fix、live→fix）", () => {
    const r = m("code", [created(0), to(1, "review"), to(2, "fix"), to(3, "review"), to(4, "merge"), to(5, "fix"), to(6, "review"), to(7, "merge"), to(8, "live"), to(9, "fix")]);
    expect(r.reworkCount).toBe(3);
  });
  test("从 blocked 回到 fix 不算返工：review→fix→blocked→fix→blocked→fix 只算 1 次", () => {
    const r = m("code", [
      created(0), to(1, "review"), to(2, "fix", "review"), to(3, "blocked", "fix"), to(4, "fix", "blocked"), to(5, "blocked", "fix"), to(6, "fix", "blocked"),
    ]);
    expect(r.reworkCount).toBe(1);
  });
  test("等复核 = 第一次 deliver 到下一条 review；中间多次 deliver 只从第一次算；没等到的算到 now 并单列", () => {
    const r = m("code", [ev(10, "deliver"), ev(20, "deliver"), review(50), ev(60, "deliver"), review(65), ev(80, "deliver")], 100);
    expect(r.reviewWaits).toEqual([40, 5]);
    expect(r.reviewWaitMs).toBe(45);
    expect(r.reviewWaitPendingMs).toBe(20);
    expect(m("code", [ev(10, "deliver"), review(50)]).reviewWaitPendingMs).toBeNull();
  });
  test("P0/P1/P2 = 各 review 事件计数求和", () => {
    expect(m("code", [review(1, 1, 2, 3), review(2, 0, 1, 4)])).toMatchObject({ p0: 1, p1: 3, p2: 7 });
  });
  test("回滚 = rollback 事件数", () => {
    expect(m("code", [ev(1, "rollback"), ev(2, "note"), ev(3, "rollback")]).rollbacks).toBe(2);
  });
  test("只看 target 是本任务的事件（可以直接喂整个项目的事件）", () => {
    expect(m("code", [review(1, 1), ev(2, "review", { p0: 5 }, "OTHER"), ev(3, "rollback", {}, "OTHER")])).toMatchObject({ reviewRounds: 1, p0: 1, rollbacks: 0 });
  });
});

test("用写入层真实产生的事件跑通", () => {
  const db = openLedger(":memory:");
  try {
    const pm = (now: number) => ({ actor: "owner", now });
    createTask(db, pm(0), { project: "p", id: "T", title: "t", kind: "code", agent: "a" });
    moveStage(db, { actor: "a", now: 100 }, { taskId: "T", from: "spec", to: "restate" });
    moveStage(db, pm(200), { taskId: "T", from: "restate", to: "build" });
    deliver(db, { actor: "a", now: 300 }, { taskId: "T", headSHA: "s1", moveFrom: "build" });
    recordReview(db, pm(450), { taskId: "T", reviewer: "r", verdict: "changes", p0: 0, p1: 1, p2: 2, move: { from: "review", to: "fix" } });
    deliver(db, { actor: "a", now: 500 }, { taskId: "T", headSHA: "s2", moveFrom: "fix" });
    recordReview(db, pm(520), { taskId: "T", reviewer: "r", verdict: "pass", p0: 0, p1: 0, p2: 1, move: { from: "review", to: "merge" } });
    const r = taskMetrics({ id: "T", kind: "code" }, listEvents(db, { project: "p" }), 600);
    expect(r).toMatchObject({ startTs: 100, endTs: null, totalMs: 500, reviewRounds: 2, reworkCount: 1, reviewWaits: [150, 20], p1: 1, p2: 3 });
    expect(r.stageMs).toEqual({ spec: 100, restate: 100, build: 100, review: 150 + 20, fix: 50, merge: 80 });
  } finally {
    closeLedger(":memory:");
  }
});
