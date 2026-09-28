/**
 * 审查员信号（web/features/collab/collab-reviewers.ts）：description → 任务号 / 轮次 / 对抗式；只认 PM 的 subagent；
 * 起止事件进出表、重连按快照整表重建；首页叠加（review 阶段改短语、不算卡住，其它阶段挂小标）。
 * 标题样例取自线上 bridge 日志（2026-09-28）。
 */
import { describe, expect, test } from "bun:test";
import { homeView, type LedgerOverview, type LedgerTaskView } from "../web/features/collab/collab-model";
import { parseReviewer, type ReviewTarget } from "../web/features/collab/collab-reviewer-parse";
import { applyReviewers, isPlaceholderStart, pmSet, reduceReviewer, reviewerOverlay, reviewersByTask, seedReviewers, type ReviewerMap } from "../web/features/collab/collab-reviewers";

const IDS = ["T12", "T12b", "T12C", "T8b", "T8e", "T13b", "T2b-2", "T2b-1", "T6a", "T14"];
const tg = (ids: readonly string[]): ReviewTarget[] => ids.map((id) => ({ id }));
const TG: ReviewTarget[] = [...tg(IDS), { id: "T5", pr: "https://github.com/shawnlu96/claudestra/pull/150" }, { id: "T6", pr: "#151" }, { id: "T12d" }, { id: "R2" }, { id: "T1" }];
const P = (title: string, ids?: readonly string[]) => parseReviewer(title, ids ? tg(ids) : TG);

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
  for (const [title, want] of cases) test(title, () => expect(P(title)).toEqual(want));
});

describe("parseReviewer：关键词在开头、对象紧跟其后（审查 T12C r1 P2-2 的样例）", () => {
  const cases: [string, { taskId: string; round: number | null; adversarial?: boolean } | null][] = [
    // 提到 review 但不是审查员：不挂
    ["🤖 Fix T5 review findings", null],
    ["🤖 Merge T12b after review", null],
    ["🤖 Summarize T5 review report", null],
    ["🤖 Write T12d spec from T12c review", null],
    ["🤖 Apply review P1s to T6", null],
    ["🤖 Draft review checklist for T5", null],
    ["🤖 Pre-review T5 spec", null],
    ["🤖 Final pass T5 (reviewer)", null],
    // R2 是轮次写法，不当任务号；轮次只认紧跟对象的
    ["🤖 Review R2 r1", null],
    ["🤖 Review T5 (reviewer r3 left)", { taskId: "T5", round: null }],
    ["🤖 Review T5 v2 r10", { taskId: "T5", round: null }],
    // 该挂上的写法
    ["🤖 Review PR #150", { taskId: "T5", round: null }],
    ["🤖 Review PR 151 r2", { taskId: "T6", round: 2 }],
    ["🤖 Code-review T5", { taskId: "T5", round: null }],
    ["🤖 Reviewing T5 second round", { taskId: "T5", round: null }],
    ["🤖 T5 审查 第二轮", { taskId: "T5", round: 2 }],
    ["🤖 审查T5第2轮", { taskId: "T5", round: 2 }],
    ["🤖 T5: review", { taskId: "T5", round: null }],
    ["🤖 Review t12c r2", { taskId: "T12C", round: 2 }],
    // T1-2 不是台账里的任务号，也不拆成 T1
    ["🤖 Code review for T1-2", null],
    // PR 号对不上任何任务
    ["🤖 Review PR #999", null],
  ];
  for (const [title, want] of cases) test(title, () => expect(P(title)).toEqual(want === null ? null : { adversarial: false, ...want }));
});

describe("parseReviewer：本周实际用过的写法（审查 T12C r2 P2-2，34 条 + PM 点名的）", () => {
  const R2: ReviewTarget[] = [
    { id: "T12C", pr: "https://github.com/shawnlu96/claude-orchestrator/pull/160" },
    { id: "T12d", pr: null }, { id: "T13a", pr: null }, { id: "T26", pr: "#150" }, { id: "T5", pr: null },
    { id: "T1-2", pr: null }, { id: "T6a", pr: null }, { id: "R2", pr: null }, { id: "T12", pr: null },
    { id: "T8g" }, { id: "T24a" }, { id: "T27" },
  ];
  const cases: [string, string | null, number | null][] = [
    ["Review T8G r2", "T8g", 2],
    ["Adversarial review T24a r1", "T24a", 1],
    ["Re-review T12c r2", "T12C", 2],
    ["Adversarial final T13a", "T13a", null],
    ["Adversarial final review T13a r3", "T13a", 3],
    ["Review PR #150 (T26)", "T26", null],
    ["Review PR #155 (T27)", "T27", null],
    ["Review PR #160", "T12C", null],
    ["Review PR ＃150", "T26", null],
    ["Review #150", "T26", null],
    ["Review T12c-r2", "T12C", 2],
    ["review t12c R2", "T12C", 2],
    ["REVIEW T12C ROUND 2", "T12C", 2],
    ["审查 T12c 第二轮", "T12C", 2],
    ["T12c 第二轮审查", "T12C", 2],
    ["对 T12c 做对抗式审查", "T12C", null],
    ["复核T5的修复", "T5", null],
    ["Review T12c and T12d", "T12C", null],
    ["Review T12d/T12c spec", "T12d", null],
    ["Review the T5 fix", "T5", null],
    ["Review task T5", "T5", null],
    ["Code review: T6a", "T6a", null],
    ["Review T12", "T12", null],
    ["Reviewing T5's PR", "T5", null],
    ["Final review of T1-2 r1", "T1-2", 1],
    ["Review: T12c（第2轮）", "T12C", 2],
    ["Review T１２c", "T12C", null],
    ["Review\tT12c", "T12C", null],
    ["🤖 Review T12c r2", "T12C", 2],
    // 不能误挂
    ["T5 review findings fix", null, null],
    ["T12c review-fix verification", null, null],
    ["Recheck T5 CI status", null, null],
    ["Audit T5 logs for crash", null, null],
    ["Review R2", null, null],
    ["Review T12x", null, null],
    ["Merge T12b after review", null, null],
    ["Summarize review of T12c", null, null],
    ["Review PR #150 (T99)", null, null],
  ];
  for (const [title, id, round] of cases) {
    test(title, () => {
      const got = parseReviewer(title, R2);
      expect(got && { taskId: got.taskId, round: got.round }).toEqual(id === null ? null : { taskId: id, round });
    });
  }
  test("对抗式只看关键词那一段", () => {
    expect(parseReviewer("对 T12c 做对抗式审查", R2)?.adversarial).toBe(true);
    expect(parseReviewer("Adversarial final T13a", R2)?.adversarial).toBe(true);
    expect(parseReviewer("Review T12c adversarial notes", R2)?.adversarial).toBe(false);
  });
});

describe("parseReviewer：约定写法与边界", () => {
  test("约定 `Review <任务号> r<N>` / `Adversarial review <任务号> r<N>`；R2、第 2 轮、中文关键词也认", () => {
    expect(P("Review T12c r2")).toEqual({ taskId: "T12C", round: 2, adversarial: false });
    expect(P("Adversarial review T12c r4")).toEqual({ taskId: "T12C", round: 4, adversarial: true });
    expect(P("Re-review T8b R2")).toMatchObject({ taskId: "T8b", round: 2 });
    expect(P("复核 T8e 第 2 轮")).toMatchObject({ taskId: "T8e", round: 2 });
    expect(P("对抗式审查 T14")).toMatchObject({ taskId: "T14", adversarial: true });
  });
  test("任务号两边不接字母数字或连字符：T12b 不中 T12、T2b-2 不中 T2b-1 也不被拆成 T2b；T12 单独出现才是 T12", () => {
    expect(P("Review T12b", ["T12"])).toBeNull();
    expect(P("Review T2b-2", ["T2b-1", "T2b"])).toBeNull();
    expect(P("Review T12, then T12b")).toMatchObject({ taskId: "T12" });
    expect(P("Review T12b-shots")).toBeNull();
  });
  test("「check」「preview」「reviewer」不算审查关键词；PR / r 前面紧贴字母不当轮次", () => {
    expect(P("check T8b CI")).toBeNull();
    expect(P("preview T8b page")).toBeNull();
    expect(P("Review T8e PR2")).toMatchObject({ round: null });
  });
  test("大小写都对得上的优先", () => {
    expect(P("Review T12b", ["T12B", "T12b"])).toMatchObject({ taskId: "T12b" });
    expect(P("Review T12B", ["T12B", "T12b"])).toMatchObject({ taskId: "T12B" });
  });
});

const PMS = pmSet(["agent-claudestra"]);
const started = (agent: string, id: string, title: string, kind = "subagent") => ({ type: "bg_task_started", agent, data: { id, kind, title } });

describe("起止事件与快照", () => {
  test("只认 PM 的 subagent：执行者的子 agent、PM 的后台 shell、不是审查的都不进表", () => {
    let m: ReviewerMap = new Map();
    m = reduceReviewer(m, started("agent-task-t12c", "agent-a", "🤖 Review T12c r1"), PMS, TG, 1);
    m = reduceReviewer(m, started("agent-claudestra", "b1", "🐚 Review T12c", "shell"), PMS, TG, 1);
    m = reduceReviewer(m, started("agent-claudestra", "agent-c", "🤖 Research agents"), PMS, TG, 1);
    expect(m.size).toBe(0);
    m = reduceReviewer(m, started("agent-claudestra", "agent-r", "🤖 Review T12c r2"), PMS, TG, 5);
    expect([...m.values()]).toEqual([{ id: "agent-r", pm: "claudestra", taskId: "T12C", round: 2, adversarial: false, startedAt: 5 }]);
    const same = reduceReviewer(m, { type: "tool_start", agent: "agent-claudestra", data: { id: "agent-r" } }, PMS, TG, 6);
    expect(same).toBe(m);
    m = reduceReviewer(m, { type: "bg_task_completed", agent: "agent-claudestra", data: { id: "agent-r" } }, PMS, TG, 9);
    expect(m.size).toBe(0);
  });
  test("started 的 startedAt 用 bridge 事件时刻（不是收到时的本机时钟）；写坏的 ts 退回本机时刻", () => {
    const at = "2026-09-28T13:00:00.000Z";
    const m = reduceReviewer(new Map(), { ...started("agent-claudestra", "agent-r", "🤖 Review T8b r1"), ts: at }, PMS, TG, 999);
    expect(m.get("agent-r")!.startedAt).toBe(Date.parse(at));
    const bad = reduceReviewer(new Map(), { ...started("agent-claudestra", "agent-r", "🤖 Review T8b r1"), ts: "nope" }, PMS, TG, 999);
    expect(bad.get("agent-r")!.startedAt).toBe(999);
  });
  test("meta 还没落盘的占位标题先不挂，但认得出来（hook 据此过一会儿按快照重建）；只认 PM 的", () => {
    const e = started("agent-claudestra", "agent-z", "🤖 subagent 1a2b3c4d");
    expect(reduceReviewer(new Map(), e, PMS, TG, 1).size).toBe(0);
    expect(isPlaceholderStart(e, PMS)).toBe(true);
    expect(isPlaceholderStart(started("agent-task-t5", "agent-z", "🤖 subagent 1a2b3c4d"), PMS)).toBe(false);
    expect(isPlaceholderStart(started("agent-claudestra", "agent-z", "🤖 Review T8b r1"), PMS)).toBe(false);
  });
  test("快照在途期间到的事件叠在快照上重放：旧快照盖不回已结束的，也不丢在途的 started（hook 的做法）", () => {
    // 快照是在 completed 之前取的：里面还有 agent-old；取完之后又起了 agent-new
    const stale = seedReviewers([{ pm: "claudestra", tasks: [{ id: "agent-old", kind: "subagent", title: "🤖 Review T8b r1", startedAt: 1 }] }], PMS, TG);
    const late = [
      { type: "bg_task_completed", agent: "agent-claudestra", data: { id: "agent-old" } },
      started("agent-claudestra", "agent-new", "🤖 Review T8e r2"),
    ];
    const m = late.reduce<ReviewerMap>((acc, e) => reduceReviewer(acc, e, PMS, TG, 5), stale);
    expect([...m.keys()]).toEqual(["agent-new"]);
  });
  test("快照整表重建：旧表里断线期间结束的不再留着", () => {
    const m = seedReviewers([{ pm: "agent-claudestra", tasks: [{ id: "agent-x", kind: "subagent", title: "🤖 Adversarial review T13b r3", startedAt: 42 }] }], PMS, TG);
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
