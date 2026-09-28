/** currentHandler（src/lib/ledger-handler.ts）：阶段默认值 + 事件推进，有 / 没有调度助理，终态为 null */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { currentHandler, pmOf, type HandlerTeam, type SpecPolicy } from "../src/lib/ledger-handler.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, recordReview } from "../src/lib/ledger-write.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let db: Database;
const owner = (now: number) => ({ actor: "owner", now });
const withD: HandlerTeam = { pms: ["agent-pm", "agent-disp"], dispatcher: "agent-disp" };
const noD: HandlerTeam = { pms: ["agent-pm"], dispatcher: null };

function h(team: HandlerTeam = withD, specPolicy?: SpecPolicy) {
  const t = getTask(db, "T1");
  if (!t) throw new Error("no task");
  return currentHandler(t, listEvents(db, { target: "T1" }), team, specPolicy);
}

beforeEach(() => {
  db = openLedger(tempLedgerPath("ledger-handler-"));
  createTask(db, owner(10), { project: "p", id: "T1", title: "x", kind: "code", agent: "agent-exec" });
});

describe("currentHandler", () => {
  test("spec / restate 归 PM；任务没记 pm 时取名单里第一个非调度助理", () => {
    expect(h()).toMatchObject({ role: "pm", agent: "agent-pm", since: 10 });
    moveStage(db, { actor: "agent-exec", now: 20 }, { taskId: "T1", from: "spec", to: "restate" });
    expect(h()).toMatchObject({ role: "pm", since: 20 });
  });

  test("build 归执行者；交付 → 调度助理；派审 → 审查员；结论 changes 推 fix → 执行者", () => {
    moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, owner(30), { taskId: "T1", from: "restate", to: "build" });
    expect(h()).toMatchObject({ role: "executor", agent: "agent-exec", since: 30 });
    deliver(db, { actor: "agent-exec", now: 40 }, { taskId: "T1", headSHA: "abc", moveFrom: "build" });
    expect(h()).toMatchObject({ role: "dispatcher", agent: "agent-disp", since: 40 });
    expect(h(noD)).toMatchObject({ role: "pm", agent: "agent-pm", since: 40 });
    appendEvent(db, { actor: "agent-disp", now: 50 }, { project: "p", target: "T1", kind: "dispatch", data: { reviewer: "regular", round: 1 } });
    expect(h()).toMatchObject({ role: "reviewer", agent: null, since: 50 });
    recordReview(db, owner(60), { taskId: "T1", reviewer: "regular", verdict: "changes", p0: 0, p1: 1, p2: 0, move: { from: "review", to: "fix" } });
    expect(h()).toMatchObject({ role: "executor", since: 60 });
  });

  test("review 没推阶段：pass（规格卡不要对抗式）→ PM，changes → 调度助理；escalate → PM / owner", () => {
    moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, owner(30), { taskId: "T1", from: "restate", to: "build" });
    deliver(db, { actor: "agent-exec", now: 40 }, { taskId: "T1", moveFrom: "build" });
    recordReview(db, owner(50), { taskId: "T1", reviewer: "regular", verdict: "changes", p0: 0, p1: 0, p2: 1 });
    expect(h()).toMatchObject({ role: "dispatcher", since: 50 });
    recordReview(db, owner(60), { taskId: "T1", reviewer: "adversarial", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    expect(h(withD, "Claude 审查员一轮")).toMatchObject({ role: "pm", since: 60 });
    appendEvent(db, { actor: "agent-pm", now: 70 }, { project: "p", target: "T1", kind: "escalate", text: "要拍板", data: { to: "owner" } });
    expect(h()).toMatchObject({ role: "owner", agent: null, since: 70 });
    appendEvent(db, { actor: "agent-disp", now: 80 }, { project: "p", target: "T1", kind: "note", text: "note 不改谁在接" });
    expect(h()).toMatchObject({ role: "owner", since: 70 });
  });

  test("常规轮通过、规格卡还要对抗式（dispatch 记着审查策略）→ 仍归调度助理；升级给 owner 后 owner 记了 decision → 回到 PM", () => {
    moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, owner(30), { taskId: "T1", from: "restate", to: "build" });
    deliver(db, { actor: "agent-exec", now: 40 }, { taskId: "T1", moveFrom: "build" });
    appendEvent(db, { actor: "agent-disp", now: 50 }, { project: "p", target: "T1", kind: "dispatch", data: { reviewer: "regular", round: 1, policy: "Claude 一轮；最后一轮对抗式" } });
    recordReview(db, owner(60), { taskId: "T1", reviewer: "regular", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    expect(h()).toMatchObject({ role: "dispatcher", since: 60 });
    appendEvent(db, { actor: "agent-disp", now: 70 }, { project: "p", target: "T1", kind: "dispatch", data: { reviewer: "adversarial", round: 1, policy: "Claude 一轮；最后一轮对抗式" } });
    recordReview(db, owner(80), { taskId: "T1", reviewer: "adversarial", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    expect(h()).toMatchObject({ role: "pm", since: 80 });
    appendEvent(db, { actor: "agent-pm", now: 90 }, { project: "p", target: "T1", kind: "escalate", text: "要拍板", data: { to: "owner" } });
    expect(h()).toMatchObject({ role: "owner" });
    appendEvent(db, owner(100), { project: "p", target: "T1", kind: "decision", text: "合", data: {} });
    expect(h()).toMatchObject({ role: "pm", agent: "agent-pm", since: 100 });
    appendEvent(db, owner(110), { project: "p", target: "T1", kind: "decision", text: "再记一条", data: {} });
    expect(h()).toMatchObject({ since: 100 }); // 不在等 owner 时 decision 不改谁在接
  });

  test("没有 dispatch 的 pass：审查策略取规格卡（与 review-pack 同源），规格卡也没有 = 不知道 → 调度助理", () => {
    moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, owner(30), { taskId: "T1", from: "restate", to: "build" });
    deliver(db, { actor: "agent-exec", now: 40 }, { taskId: "T1", moveFrom: "build" });
    recordReview(db, { actor: "agent-disp", now: 50 }, { taskId: "T1", reviewer: "adversarial", verdict: "pass", p0: 0, p1: 0, p2: 0 });
    // review 的 reviewer 是自由文本，写 adversarial 也不作数
    expect(h(withD, "Claude 审查员一轮；最后一轮对抗式")).toMatchObject({ role: "dispatcher", agent: "agent-disp", since: 50 });
    expect(h(withD)).toMatchObject({ role: "dispatcher", since: 50 });
    expect(h(noD)).toMatchObject({ role: "pm", agent: "agent-pm" });
    expect(h(withD, null)).toMatchObject({ role: "pm", since: 50 });
    expect(h(withD, "Claude 审查员一轮")).toMatchObject({ role: "pm" });
  });

  test("merge 之后归 PM，终态返回 null", () => {
    moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "cancelled" });
    expect(h()).toBeNull();
  });

  test("pmOf：任务上记的 pm 优先", () => {
    expect(pmOf({ pm: "agent-x" }, withD)).toBe("agent-x");
    expect(pmOf({ pm: null }, { pms: ["agent-disp"], dispatcher: "agent-disp" })).toBeNull();
  });
});
