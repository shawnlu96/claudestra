/**
 * team-parity-I（docs/team/team-collab-parity-plan.md §5.1 P1-I）：脱敏 / 缺字段事件的诚实渲染（collab-detail-model.ts）。
 * data.redacted === true = 只有类型和时间、其余字段不出境：eventLine 不读别的 data 字段，只说类型 +「详情仅主场」；
 * 非脱敏但缺字段时不拼 undefined，verify 结果不在 pass / unknown / fail 里就是「结果未记录」，不默认成失败。
 * 旧红新绿（纯函数，text:""）：main 上 redacted verify →「线上验证失败」、stage{} →「推到『undefined』」、
 * review{} →「第 ? 轮：undefined」，redacted review 进审查行 / 参与者出空行。完整本机事件的文案逐字不变（防回归）。
 */
import { describe, expect, test } from "bun:test";
import { eventLine, participants, recentThree, reviewRows, type TaskDetail } from "../web/features/collab/collab-detail-model";
import type { LedgerEventView, LedgerTaskView } from "../web/features/collab/collab-model";

const MIN = 60_000;
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, text = "", actor = "agent-pm"): LedgerEventView => ({ seq: ++seq, ts: seq * MIN, actor, target: "T5", kind, text, data });
/** 脱敏事件：除了 redacted，其它字段即使带了也是不该读的诱饵（证明 eventLine 不读） */
const red = (kind: string, bait: Record<string, unknown> = {}) => ev(kind, { redacted: true, ...bait }, "", "agent-secret-name");

describe("脱敏事件只说类型 + 详情仅主场", () => {
  test("复现测试:redacted verify 不再默认成「线上验证失败」", () => {
    expect(eventLine(red("verify"))).toBe("线上验证（结果仅主场）");
    // 带了 result 也不读：脱敏后哪怕 result=pass 也不说通过
    expect(eventLine(red("verify", { result: "pass" }))).toBe("线上验证（结果仅主场）");
  });

  test("复现测试:redacted 各类型只给类型名，不读 to / verdict / headSHA / version / 操作者", () => {
    expect(eventLine(red("stage", { to: "build", from: "review" }))).toBe("推进阶段（目标阶段仅主场）");
    expect(eventLine(red("review", { verdict: "pass", round: 3, p0: 1 }))).toBe("审查（结论仅主场）");
    expect(eventLine(red("deliver", { headSHA: "0b7b79c1234" }))).toBe("交付（详情仅主场）");
    expect(eventLine(red("deploy", { version: "v9" }))).toBe("上线（详情仅主场）");
    expect(eventLine(red("rollback"))).toBe("回滚（详情仅主场）");
    expect(eventLine(red("decision"))).toBe("拍板（详情仅主场）");
    expect(eventLine(red("note"))).toBe("备注（详情仅主场）");
    // 建任务 / 改字段这类本来就不上「最近 3 件事」的，脱敏后也不上（op 不读）
    expect(eventLine(red("task", { op: "new" }))).toBeNull();
    for (const k of ["stage", "review", "verify", "deliver"]) expect(eventLine(red(k))).not.toContain("secret-name");
  });

  test("复现测试:脱敏事件的近似时间标记也不读（只有类型和时间）", () => {
    const r = recentThree([red("verify", { approxTime: true })]);
    expect(r).toEqual([{ seq: r[0]!.seq, ts: r[0]!.ts, kind: "verify", text: "线上验证（结果仅主场）", approx: false }]);
  });
});

describe("非脱敏缺字段不拼 undefined", () => {
  test("复现测试:stage 缺 to →「推进阶段」，不出 undefined", () => {
    expect(eventLine(ev("stage", {}))).toBe("pm 推进阶段");
    expect(eventLine(ev("stage", {}, "", "import"))).toBe("推进阶段");
    expect(eventLine(ev("stage", { from: "review" }, "说明"))).toBe("pm 推进阶段：说明");
  });

  test("复现测试:review 缺 verdict →「审查」不带结论，不拼 undefined / P0 ?", () => {
    expect(eventLine(ev("review", {}))).toBe("审查");
    expect(eventLine(ev("review", { round: 2 }))).toBe("审查 · 第 2 轮");
    expect(eventLine(ev("review", { round: 2, p0: 0, p1: 1 }))).toBe("审查 · 第 2 轮 · P0 0 · P1 1 · P2 ?");
    expect(eventLine(ev("review", {}))).not.toContain("undefined");
  });

  test("复现测试:verify 结果缺失 / 枚举外 →「结果未记录」，不默认失败", () => {
    expect(eventLine(ev("verify", {}))).toBe("线上验证（结果未记录）");
    expect(eventLine(ev("verify", { result: "maybe" }, "说明"))).toBe("线上验证（结果未记录）：说明");
    expect(eventLine(ev("verify", { result: null }))).toBe("线上验证（结果未记录）");
  });
});

describe("防回归：完整本机事件文案逐字不变", () => {
  test("verify pass / unknown / fail 与既有审查原语义", () => {
    expect(eventLine(ev("verify", { result: "pass" }))).toBe("线上验证通过");
    expect(eventLine(ev("verify", { result: "unknown" }))).toBe("线上验证查不到结果");
    expect(eventLine(ev("verify", { result: "fail" }, "白屏"))).toBe("线上验证失败：白屏");
    expect(eventLine(ev("review", { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1 }, "两处要改"))).toBe("审查 · 第 1 轮：要改 · P0 0 · P1 2 · P2 1：两处要改");
    expect(eventLine(ev("review", { verdict: "pass" }))).toBe("审查 · 第 ? 轮：通过 · P0 ? · P1 ? · P2 ?");
    expect(eventLine(ev("stage", { from: "review", to: "fix" }))).toBe("pm 退回返工");
    expect(eventLine(ev("stage", { from: "build", to: "review" }))).toBe("pm 推到「审查」");
    expect(eventLine(ev("deliver", { headSHA: "0b7b79c1234" }))).toBe("pm 交付 · 0b7b79c");
  });
});

describe("脱敏审查不进审查行 / 参与者", () => {
  const task = { id: "T5", stage: "review", stageBefore: null, agent: null, pm: null } as unknown as LedgerTaskView;
  test("复现测试:redacted review 不出空行，也不把 reviewer 诱饵算进参与者", () => {
    const events = [red("review", { reviewer: "agent-bait", round: 1, verdict: "pass" }), red("review")];
    expect(reviewRows(events)).toEqual([]);
    expect(participants({ task, events } as Pick<TaskDetail, "task" | "events" | "sessions">)).toEqual([]);
  });
  test("复现测试:脱敏审查与真实审查混排，只留真实那一行和那位审查员", () => {
    const events = [red("review"), ev("review", { reviewer: "agent-review", round: 1, verdict: "changes", p0: 0, p1: 1, p2: 0 }, "要改")];
    expect(reviewRows(events).map((r) => [r.round, r.verdict, r.reviewer, r.text])).toEqual([[1, "changes", "agent-review", "要改"]]);
    expect(participants({ task, events } as Pick<TaskDetail, "task" | "events" | "sessions">)).toEqual([{ name: "review", role: "reviewer", rounds: [1] }]);
  });
});
