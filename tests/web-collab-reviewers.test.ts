/**
 * 审查员信号（web/features/collab/collab-reviewers.ts）：description → 任务号 / 轮次 / 对抗式；只认 PM 的 subagent；
 * 起止事件进出表、重连按快照整表重建；首页叠加（review 阶段改短语、不算卡住，其它阶段挂小标）。
 * 标题样例取自线上 bridge 日志（2026-09-28）。
 */
import { describe, expect, test } from "bun:test";
import { homeView, type LedgerOverview, type LedgerTaskView } from "../web/features/collab/collab-model";
import { applyReviewers, parseReviewer, pmSet, reduceReviewer, reviewerOverlay, reviewersByTask, seedReviewers, type ReviewerMap } from "../web/features/collab/collab-reviewers";

const IDS = ["T12", "T12b", "T12C", "T8b", "T8e", "T13b", "T2b-2", "T2b-1", "T6a", "T14"];

describe("parseReviewer：线上真实标题", () => {
  const cases: [string, { taskId: string; round: number | null; adversarial: boolean } | null][] = [
    ["🤖 Review T12b round 3", { taskId: "T12b", round: 3, adversarial: false }],
    ["🤖 Review T12b collab view", { taskId: "T12b", round: null, adversarial: false }],
    ["🤖 Recheck T8b P1 fixes", { taskId: "T8b", round: null, adversarial: false }],
    ["🤖 Adversarial final review T13b", { taskId: "T13b", round: null, adversarial: true }],
    ["🤖 Review T8e PR #142 stage chip", { taskId: "T8e", round: null, adversarial: false }],
    ["🤖 Review T2b-2 PR #141 quota wiring", { taskId: "T2b-2", round: null, adversarial: false }],
    ["🤖 Adversarial review of T6a PR #140", { taskId: "T6a", round: null, adversarial: true }],
    ["🤖 Adversarial review T14 Autopilot #146", { taskId: "T14", round: null, adversarial: true }],
    // N7 不在台账里：不挂
    ["🤖 Targeted recheck of N7 round 5", null],
    // 没有审查关键词：不挂（即使出现了已知任务号）
    ["🤖 N7 live test background sleeper", null],
    ["🤖 Research T12b follow-up ideas", null],
    ["🐚 bg shell b6csgj0qd", null],
  ];
  for (const [title, want] of cases) test(title, () => expect(parseReviewer(title, IDS)).toEqual(want));
});

describe("parseReviewer：约定写法与边界", () => {
  test("约定 `Review <任务号> r<N>` / `Adversarial review <任务号> r<N>`；R2、第 2 轮、中文关键词也认", () => {
    expect(parseReviewer("Review T12c r2", IDS)).toEqual({ taskId: "T12C", round: 2, adversarial: false });
    expect(parseReviewer("Adversarial review T12c r4", IDS)).toEqual({ taskId: "T12C", round: 4, adversarial: true });
    expect(parseReviewer("Re-review T8b R2", IDS)).toMatchObject({ taskId: "T8b", round: 2 });
    expect(parseReviewer("复核 T8e 第 2 轮", IDS)).toMatchObject({ taskId: "T8e", round: 2 });
    expect(parseReviewer("对抗式审查 T14", IDS)).toMatchObject({ taskId: "T14", adversarial: true });
  });
  test("任务号两边不接字母数字或连字符：T12b 不中 T12、T2b-2 不中 T2b-1 也不被拆成 T2b；T12 单独出现才是 T12", () => {
    expect(parseReviewer("Review T12b", ["T12"])).toBeNull();
    expect(parseReviewer("Review T2b-2", ["T2b-1", "T2b"])).toBeNull();
    expect(parseReviewer("Review T12, then T12b", IDS)).toMatchObject({ taskId: "T12" });
    expect(parseReviewer("Review T12b-shots", IDS)).toBeNull();
  });
  test("「check」「preview」「reviewer」不算审查关键词；PR / r 前面紧贴字母不当轮次", () => {
    expect(parseReviewer("check T8b CI", IDS)).toBeNull();
    expect(parseReviewer("preview T8b page", IDS)).toBeNull();
    expect(parseReviewer("Review T8e PR2", IDS)).toMatchObject({ round: null });
  });
  test("大小写都对得上的优先", () => {
    expect(parseReviewer("Review T12b", ["T12B", "T12b"])).toMatchObject({ taskId: "T12b" });
    expect(parseReviewer("Review T12B", ["T12B", "T12b"])).toMatchObject({ taskId: "T12B" });
  });
});

const PMS = pmSet(["agent-claudestra"]);
const started = (agent: string, id: string, title: string, kind = "subagent") => ({ type: "bg_task_started", agent, data: { id, kind, title } });

describe("起止事件与快照", () => {
  test("只认 PM 的 subagent：执行者的子 agent、PM 的后台 shell、不是审查的都不进表", () => {
    let m: ReviewerMap = new Map();
    m = reduceReviewer(m, started("agent-task-t12c", "agent-a", "🤖 Review T12c r1"), PMS, IDS, 1);
    m = reduceReviewer(m, started("agent-claudestra", "b1", "🐚 Review T12c", "shell"), PMS, IDS, 1);
    m = reduceReviewer(m, started("agent-claudestra", "agent-c", "🤖 Research agents"), PMS, IDS, 1);
    expect(m.size).toBe(0);
    m = reduceReviewer(m, started("agent-claudestra", "agent-r", "🤖 Review T12c r2"), PMS, IDS, 5);
    expect([...m.values()]).toEqual([{ id: "agent-r", pm: "claudestra", taskId: "T12C", round: 2, adversarial: false, startedAt: 5 }]);
    const same = reduceReviewer(m, { type: "tool_start", agent: "agent-claudestra", data: { id: "agent-r" } }, PMS, IDS, 6);
    expect(same).toBe(m);
    m = reduceReviewer(m, { type: "bg_task_completed", agent: "agent-claudestra", data: { id: "agent-r" } }, PMS, IDS, 9);
    expect(m.size).toBe(0);
  });
  test("快照整表重建：旧表里断线期间结束的不再留着", () => {
    const m = seedReviewers([{ pm: "agent-claudestra", tasks: [{ id: "agent-x", kind: "subagent", title: "🤖 Adversarial review T13b r3", startedAt: 42 }] }], PMS, IDS);
    expect([...m.values()]).toEqual([{ id: "agent-x", pm: "claudestra", taskId: "T13b", round: 3, adversarial: true, startedAt: 42 }]);
  });
});

const MIN = 60_000;
const NOW = 1_000 * MIN;
function tk(id: string, stage: LedgerTaskView["stage"], since: number, round = 1): LedgerTaskView {
  return { id, itemId: null, title: id, kind: "code", stage, stageBefore: null, round, agent: `agent-${id}`, pm: "agent-claudestra", pr: null, spec: null, model: null, extra: {},
    createdAt: 0, updatedAt: since, lastEvent: null, stageSince: since, metrics: { startTs: 0, endTs: null, stageMs: {}, reviewRounds: 0, reviewWaitPendingMs: null, p0: 0, p1: 0, p2: 0 } };
}
const META: LedgerOverview["meta"] = { pms: ["agent-claudestra"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } };
const ov = (tasks: LedgerTaskView[]): LedgerOverview => ({ exists: true, now: NOW, meta: META, items: [], tasks });

describe("首页叠加", () => {
  test("review 阶段：短语改成「审查中 · 第 N 轮 · 审查员在跑」，轮次标题优先、没写按台账；停得再久也不算卡住", () => {
    const v = homeView(ov([tk("T5", "review", NOW - 50 * MIN, 2), tk("T6", "review", NOW - 45 * MIN, 1)]), NOW);
    expect(v.headline.stuck).toBe(2);
    const by = reviewersByTask(new Map([["a", { id: "a", pm: "claudestra", taskId: "T5", round: null, adversarial: false, startedAt: 1 }]]));
    const out = applyReviewers(v, by);
    const t5 = out.lines.find((l) => l.id === "T5")!;
    expect(t5).toMatchObject({ stageLabel: "审查中 · 第 2 轮 · 审查员在跑", attention: "waiting", stuck: false, reason: "", reviewerTag: null });
    expect(out.headline.stuck).toBe(1);
    // 卡住的 T6 排到了在审的 T5 前面
    expect(out.lines.map((l) => l.id)).toEqual(["T6", "T5"]);
  });
  test("返工中起的复核只挂小标；对抗式另外标出；没有审查员原样返回", () => {
    const [fix] = homeView(ov([tk("T7", "fix", NOW - 5 * MIN, 2)]), NOW).lines;
    const adv = reviewerOverlay(fix, [{ id: "a", pm: "p", taskId: "T7", round: 3, adversarial: true, startedAt: 1 }]);
    expect(adv).toEqual({ stageLabel: fix.stageLabel, tag: "审查员在跑 · 第 3 轮 · 对抗式" });
    expect(reviewerOverlay(fix, [{ id: "a", pm: "p", taskId: "T7", round: null, adversarial: false, startedAt: 1 }]).tag).toBe("审查员在跑");
    expect(reviewerOverlay(fix, undefined)).toEqual({ stageLabel: fix.stageLabel, tag: null });
  });
});
