/**
 * team-project-N8B2：团队卡的轮次未知（中心投影没有轮次字段），阶段短语不拼「第 N 轮」，详情 / 时间线 / 审查员标签也不编数；
 * 本机卡 round 是真实值（0 = 还没送审），阶段短语与 main 逐字节相同。旧红：main 上团队卡一律「等审查 · 第 1 轮」「返工中 · 第 1 轮意见」。
 */
import { expect, test } from "bun:test";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { homeView, lineOf, type LedgerOverview, type LedgerTaskView, type Stage } from "@/features/collab/collab-model";
import { reviewerOverlay, type RunningReviewer } from "@/features/collab/collab-reviewers";
import { generateTeamFixture } from "@/features/collab/shared/team-fixture-gen";
import { fillParams } from "@/lib/i18n-fill";

const fx = generateTeamFixture();
const team = teamOverview(fx.list, new Map(fx.details.map((d) => [d.feature.id, d])), fx.now);
const ROUND = /第\s*\d+\s*轮|round \d/i;

test("复现测试：团队夹具 review 卡显示「等审查」、fix 卡显示「返工中」，不含「第 1 轮」", () => {
  const lines = homeView(team.ov, fx.now).lines;
  const review = lines.filter((l) => l.stage === "review"), fix = lines.filter((l) => l.stage === "fix");
  expect(review.length).toBeGreaterThan(0);
  expect(fix.length).toBeGreaterThan(0);
  for (const l of review) expect(l.stageLabel).toBe("等审查");
  for (const l of fix) expect(l.stageLabel).toBe("返工中");
  for (const l of lines) {
    expect(l.stageLabel).not.toMatch(ROUND);
    expect(l.roundUnknown).toBe(true);
  }
});

test("团队卡英文短语也不带轮次", () => {
  const en: Record<string, string> = { "等审查": "Awaiting review", "返工中": "Fixing" };
  const tr = (k: string, p?: Record<string, string | number>) => fillParams(en[k] ?? k, p);
  const lines = homeView(team.ov, fx.now, tr).lines;
  expect(lines.find((l) => l.stage === "review")!.stageLabel).toBe("Awaiting review");
  expect(lines.find((l) => l.stage === "fix")!.stageLabel).toBe("Fixing");
});

test("复现测试：团队卡详情 / 时间线没有编出来的轮次", () => {
  for (const t of team.ov.tasks) {
    expect(t.roundUnknown).toBe(true);
    const d = teamTaskDetail(team, t.id, fx.now)!;
    expect(d.events).toEqual([]);
    expect(d.timeline).toEqual([]);
    expect(d.task.lastReview ?? null).toBeNull();
    const line = lineOf(t, team.ov, new Map(), fx.now);
    expect(`${line.stageLabel} ${line.reason}`).not.toMatch(ROUND);
  }
});

const NOW = new Date(2026, 9, 10, 12, 0).getTime();
function local(id: string, stage: Stage, over: Partial<LedgerTaskView> = {}): LedgerTaskView {
  return { id, itemId: null, title: id, kind: "code", stage, round: 0, agent: `agent-${id}`, pm: "agent-pm", updatedAt: NOW,
    stageSince: NOW - 60_000, lastReview: null, metrics: {}, ...over };
}
const localOv = (tasks: LedgerTaskView[]): LedgerOverview =>
  ({ exists: true, now: NOW, meta: { pms: ["agent-pm"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items: [], tasks });

test("本机卡轮次照旧：round=0 → 第 1 轮，round=6 → 第 6 轮，返工按最近审查轮次；线上不带 roundUnknown 键", () => {
  const review = { round: 3, verdict: "changes", p0: 0, p1: 1, p2: 0, text: "x", ts: NOW };
  const ov = localOv([local("R0", "review"), local("R6", "review", { round: 6 }), local("F", "fix", { round: 3, lastReview: review }),
    local("F0", "fix")]);
  const by = new Map(homeView(ov, NOW).lines.map((l) => [l.id, l]));
  expect(by.get("R0")!.stageLabel).toBe("等审查 · 第 1 轮");
  expect(by.get("R6")!.stageLabel).toBe("等审查 · 第 6 轮");
  expect(by.get("F")!.stageLabel).toBe("返工中 · 第 3 轮意见");
  expect(by.get("F0")!.stageLabel).toBe("返工中 · 第 1 轮意见");
  for (const l of by.values()) expect("roundUnknown" in l).toBe(false);
});

const running = (taskId: string, round: number | null): RunningReviewer[] => [{ id: "bg-1", pm: "pm", startedAt: NOW, taskId, round, adversarial: false }];

test("复现测试：团队卡上有审查员在跑、标题没写轮次：不编「第 1 轮」；标题写了就用标题的", () => {
  const t = team.ov.tasks.find((x) => x.stage === "review")!;
  const line = lineOf(t, team.ov, new Map(), fx.now);
  expect(reviewerOverlay(line, running(t.id, null)).stageLabel).toBe("审查中 · 审查员在跑");
  expect(reviewerOverlay(line, running(t.id, 4)).stageLabel).toBe("审查中 · 第 4 轮 · 审查员在跑");
  const f = team.ov.tasks.find((x) => x.stage === "fix")!;
  expect(reviewerOverlay(lineOf(f, team.ov, new Map(), fx.now), running(f.id, null)).tag).toBe("审查员在跑");
});

test("本机卡审查员覆盖层照旧：标题没写轮次按台账 max(1, round)", () => {
  const ov = localOv([local("R0", "review")]);
  const line = homeView(ov, NOW).lines[0]!;
  expect(reviewerOverlay(line, running("R0", null)).stageLabel).toBe("审查中 · 第 1 轮 · 审查员在跑");
});
