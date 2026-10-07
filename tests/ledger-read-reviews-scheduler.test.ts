/**
 * 自动卡审查员的「在审」小标（src/lib/ledger-read.ts activeReviewsByAgent）：调度器只写 scheduler 事件（reviewer session_bind /
 * 派审意图 / session_retire），不写 step assign。回放 = ADVA-1 的真实事件（tests/fixtures，只留相关字段）。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { activeReviewsByAgent, type LedgerReviewRef } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, recordReview, setMeta } from "../src/lib/ledger-write.js";
import fixture from "./fixtures/ledger-read-reviews-adva1.json";

const P = "p";
const OWNER = { actor: "owner", now: 1_000 };
let db: Database;
const toStage = (id: string, stage: string, round = 1) => db.run("UPDATE tasks SET stage = ?, round = ? WHERE id = ?", [stage, round, id]);
const card = (id: string, stage = "review", round = 1) => (createTask(db, OWNER, { project: P, id, title: id, kind: "code" }), toStage(id, stage, round));
const sched = (target: string, data: Record<string, unknown>) =>
  db.run("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'scheduler', ?, ?, 'scheduler', ?)", [OWNER.now, P, target, JSON.stringify(data)]);
const bind = (id: string, agent: string, role = "reviewer", transport = "tmux") =>
  sched(id, { op: "session_bind", role, agent, transport, source: transport === "peer" ? "peer_claim" : "registry_runtime" });
const retire = (id: string, role = "reviewer") => sched(id, { op: "session_retire", role, effect: "kill" });
const dispatchReview = (id: string, agent: string, round: number) =>
  sched(id, { op: "plan", id: `t68:s1:r${round}:adversarial_review:a0`, node: "adversarial_review", action: "review", recipient: agent });
const review = (id: string, reviewer: string, verdict: "pass" | "changes" | "block", p = [0, 0, 0]) =>
  recordReview(db, OWNER, { taskId: id, reviewer, verdict, p0: p[0], p1: p[1], p2: p[2] });
const reviews = () => Object.fromEntries(activeReviewsByAgent(db));
const pending = (id: string, round: number): LedgerReviewRef => ({ id, round, verdict: null, p0: 0, p1: 0, p2: 0 });
const changesP1 = (round: number): LedgerReviewRef => ({ id: "ADVA-1", round, verdict: "changes", p0: 0, p1: 1, p2: 0 });

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
});
afterEach(() => closeLedger(":memory:"));

describe("activeReviewsByAgent：调度器审查员会话", () => {
  test("只有 reviewer bind（+ 派审领单）、没结论：在审；之后有结论 → 以结论为准", () => {
    card("A1", "review", 1);
    bind("A1", "agent-rv-a1");
    expect(reviews()).toEqual({ "rv-a1": pending("A1", 1) });
    dispatchReview("A1", "agent-rv-a1", 1);
    expect(reviews()).toEqual({ "rv-a1": pending("A1", 1) });
    review("A1", "agent-rv-a1", "changes", [0, 1, 2]);
    expect(reviews()).toEqual({ "rv-a1": { id: "A1", round: 1, verdict: "changes", p0: 0, p1: 1, p2: 2 } });
  });

  test("下一轮只有派审意图（不再 bind）：轮次取意图 id 的 :rN:", () => {
    card("A1", "review", 1);
    bind("A1", "agent-rv-a1");
    review("A1", "agent-rv-a1", "changes");
    toStage("A1", "review", 2);
    dispatchReview("A1", "agent-rv-a1", 2);
    expect(reviews()).toEqual({ "rv-a1": pending("A1", 2) });
  });

  test("reviewer 会话退役 / 卡已 verified → 不返回；作者的 bind / retire 不算", () => {
    card("A1");
    bind("A1", "agent-task-a1", "author");
    expect(reviews()).toEqual({});
    bind("A1", "agent-rv-a1");
    retire("A1", "author"); // 作者先退役不影响审查员
    expect(Object.keys(reviews())).toEqual(["rv-a1"]);
    retire("A1");
    expect(reviews()).toEqual({});

    card("A2");
    bind("A2", "agent-rv-a2");
    review("A2", "agent-rv-a2", "pass");
    toStage("A2", "verified");
    expect(reviews()).toEqual({});
  });

  test("换审查员：新 bind 替换旧人；出借给 peer 的派审意图 / peer 绑定不进表", () => {
    card("A1");
    bind("A1", "agent-rv-old");
    bind("A1", "agent-rv-new");
    expect(Object.keys(reviews())).toEqual(["rv-new"]);
    dispatchReview("A1", "pm-codex@Shawn", 1); // 原用例：派给 peer 审查员名
    expect(reviews()).toEqual({});
    dispatchReview("A1", "peer:Shawn", 1);
    expect(reviews()).toEqual({});
    bind("A1", "agent-rv-remote", "reviewer", "peer");
    expect(reviews()).toEqual({});
  });

  test("远端会话（@ 名 + transport=peer）绑定后，同名派审意图也不进表；没有绑定的意图不靠名字认本机（PR855-r2）", () => {
    card("A1");
    bind("A1", "reviewer@remote", "reviewer", "peer");
    dispatchReview("A1", "reviewer@remote", 1);
    expect(reviews()).toEqual({});
    card("A2");
    dispatchReview("A2", "agent-rv-a2", 1);
    expect(reviews()).toEqual({});
  });

  test("本机审查员名带 @：bind / 派审意图照样在审（远端看绑定身份，不看名字）", () => {
    card("A1");
    bind("A1", "agent-rv@local");
    expect(reviews()).toEqual({ "rv@local": pending("A1", 1) });
    toStage("A1", "review", 2);
    dispatchReview("A1", "agent-rv@local", 2);
    expect(reviews()).toEqual({ "rv@local": pending("A1", 2) });
  });

  test("同一审查员先后审两张卡：取最新（在审优先于审完）", () => {
    card("A1");
    card("A2", "review", 3);
    bind("A1", "agent-rv-x");
    bind("A2", "agent-rv-x");
    expect(reviews()["rv-x"]).toEqual(pending("A2", 3));
    review("A2", "agent-rv-x", "pass");
    expect(reviews()["rv-x"]).toEqual(pending("A1", 1)); // A2 审完，A1 还在审
    review("A1", "agent-rv-x", "block", [1, 0, 0]);
    expect(reviews()["rv-x"]).toMatchObject({ id: "A1", verdict: "block" }); // 都审完：最新的结论
  });
});

describe("回放 ADVA-1 真实事件", () => {
  type Ev = { seq: number; ts: number; actor: string; kind: string; data: Record<string, unknown> };
  /** 回放到 seq（含）：事件原样写入，卡的阶段 / 轮次跟到最后一条 stage 事件 */
  const replayTo = (seq: number) => {
    card("ADVA-1", "spec", 0);
    for (const e of (fixture as Ev[]).filter((x) => x.seq <= seq)) {
      db.run("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, ?, ?, 'ADVA-1', ?, ?)", [e.ts, e.actor, P, e.kind, JSON.stringify(e.data)]);
      if (e.kind === "stage") toStage("ADVA-1", String(e.data.to), Number(e.data.round));
    }
    return reviews();
  };

  test.each([
    [4437, "绑定审查员会话", pending("ADVA-1", 1)],
    [4445, "第 1 轮领单", pending("ADVA-1", 1)],
    [4446, "第 1 轮结论", changesP1(1)],
    [4477, "第 2 轮领单（没有新 bind）", pending("ADVA-1", 2)],
    [4514, "第 3 轮结论", changesP1(3)],
    [4531, "进合并队列", changesP1(3)],
  ])("回放到 %i（%s）", (seq, _label, want) => {
    expect(replayTo(seq)).toEqual({ "rv-adva-1": want });
  });

  test("绑定前没有审查员", () => expect(replayTo(4434)).toEqual({}));
  test("上线（live）还显示结论", () => expect(replayTo(4555)).toEqual({ "rv-adva-1": changesP1(3) }));
  test("verified（会话还没退役）就不再显示", () => expect(replayTo(4558)).toEqual({}));
  test("会话退役后不再显示", () => expect(replayTo(4565)).toEqual({}));
});
