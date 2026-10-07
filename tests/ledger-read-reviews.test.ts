/** 审查员 → 在审 / 审完的卡（src/lib/ledger-read.ts activeReviewsByAgent）：审查员不绑卡，只按派审 / 结论事件推 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { activeReviewsByAgent, activeTasksByAgent } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, recordReview, setMeta } from "../src/lib/ledger-write.js";

const P = "p";
const OWNER = { actor: "owner", now: 1_000 };
let db: Database;
const toStage = (id: string, stage: string, round = 1) => db.run("UPDATE tasks SET stage = ?, round = ? WHERE id = ?", [stage, round, id]);
const card = (id: string, agent?: string) => createTask(db, OWNER, { project: P, id, title: id, kind: "code", ...(agent ? { agent } : {}) });
const assign = (id: string, executor: string, executorKind: "agent" | "peer" = "agent", step: "review" | "final_review" = "review") =>
  assignStep(db, OWNER, { taskId: id, step, executor, executorKind });
const review = (id: string, reviewer: string, verdict: "pass" | "changes" | "block", p = [0, 0, 0]) =>
  recordReview(db, OWNER, { taskId: id, reviewer, verdict, p0: p[0], p1: p[1], p2: p[2] });
const reviews = () => Object.fromEntries(activeReviewsByAgent(db));

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("activeReviewsByAgent", () => {
  test("只有派审、没绑卡：拿到卡号 + 轮次 + 在审（verdict null）；结论记下后拿到结论与 P 数", () => {
    card("A1", "agent-task-a1");
    toStage("A1", "review", 2);
    assign("A1", "agent-review-pi");
    expect(reviews()).toEqual({ "review-pi": { id: "A1", round: 2, verdict: null, p0: 0, p1: 0, p2: 0 } });
    review("A1", "agent-review-pi", "changes", [0, 1, 3]);
    expect(reviews()).toEqual({ "review-pi": { id: "A1", round: 2, verdict: "changes", p0: 0, p1: 1, p2: 3 } });
    expect(activeTasksByAgent(db).has("review-pi")).toBe(false); // 审查员不是执行者：执行者小标照旧只按 tasks.agent
  });

  test("结论一直留着，直到这张卡改派别人或结束", () => {
    card("A1");
    toStage("A1", "review");
    assign("A1", "agent-review-pi");
    review("A1", "agent-review-pi", "pass", [0, 0, 1]);
    toStage("A1", "merge");
    expect(reviews()["review-pi"]).toMatchObject({ id: "A1", verdict: "pass", p2: 1 });
    toStage("A1", "review", 2);
    assign("A1", "pm-codex@Shawn", "peer"); // 下一轮派给 peer：本机审查员上一轮的结论不再显示，peer 也不进表
    expect(reviews()).toEqual({});
    assign("A1", "agent-review-pi");
    toStage("A1", "done", 2);
    expect(reviews()).toEqual({});
  });

  test("同一轮先派 A 再改派 B：只有 B 在审", () => {
    card("A1");
    toStage("A1", "review", 2);
    assign("A1", "agent-codex-a");
    assign("A1", "agent-review-pi");
    expect(Object.keys(reviews())).toEqual(["review-pi"]);
  });

  test("同一审查员挂几张：在审的优先于审完的，同类取最新；final_review 的派审也算", () => {
    for (const id of ["A1", "A2", "A3"]) (card(id), toStage(id, "review"));
    assign("A1", "agent-review-pi");
    assign("A2", "agent-review-pi");
    review("A2", "agent-review-pi", "pass");
    expect(reviews()["review-pi"]).toMatchObject({ id: "A1", verdict: null }); // A2 审完更晚，但 A1 还在审
    review("A1", "agent-review-pi", "block", [1, 0, 0]);
    expect(reviews()["review-pi"]).toMatchObject({ id: "A1", verdict: "block", p0: 1 }); // 都审完：取最新
    assign("A3", "agent-review-pi", "agent", "final_review");
    expect(reviews()["review-pi"]).toMatchObject({ id: "A3", verdict: null });
  });

  test("没有派审、由 PM 直接记结论：按结论里的审查员；审查员名是 peer / 人的不算", () => {
    for (const id of ["A1", "A2", "A3"]) (card(id), toStage(id, "review"));
    review("A1", "agent-codex", "pass");
    review("A2", "pm-codex@Shawn", "pass");
    review("A3", "local:owner", "pass");
    expect(Object.keys(reviews())).toEqual(["codex"]);
  });

  test("本机 agent 名带 @（executorKind=agent）照样在审：远端只看 executorKind，不看名字（PR855-r1）", () => {
    card("A1");
    toStage("A1", "review");
    assign("A1", "agent-review@local");
    expect(reviews()).toEqual({ "review@local": { id: "A1", round: 1, verdict: null, p0: 0, p1: 0, p2: 0 } });
  });

  test("既是某卡执行者、又被派审别的卡：两张表各给各的，谁也不盖谁", () => {
    card("E1", "agent-dual");
    toStage("E1", "build", 0);
    card("R1");
    toStage("R1", "review");
    assign("R1", "agent-dual");
    expect(activeTasksByAgent(db).get("dual")).toEqual({ id: "E1", stage: "build", round: 0 });
    expect(reviews().dual).toEqual({ id: "R1", round: 1, verdict: null, p0: 0, p1: 0, p2: 0 });
  });
});
