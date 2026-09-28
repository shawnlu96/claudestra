/**
 * 协作视图详情面板纯逻辑（web/features/collab/collab-detail-model.ts）：阶段用时条、最近 3 件事、审查摘要、参与者。
 */
import { describe, expect, test } from "bun:test";
import { actorName, eventLine, participants, recentThree, reviewRows, stageSegments } from "../web/features/collab/collab-detail-model";
import type { LedgerEventView, LedgerTaskView } from "../web/features/collab/collab-model";

const MIN = 60_000;
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, text = "", actor = "agent-pm"): LedgerEventView => ({ seq: ++seq, ts: seq * MIN, actor, target: "T5", kind, text, data });

const task = { id: "T5", stage: "fix", stageBefore: null, agent: "agent-task-t5", pm: "agent-claudestra" } as unknown as LedgerTaskView;

describe("阶段用时条", () => {
  test("7 段与首页列对齐：审查与返工合在一段、同阶段多次进入累加；当前段之前为 past", () => {
    const timeline = [
      { stage: "spec", from: 0, to: 4 * MIN },
      { stage: "restate", from: 4 * MIN, to: 7 * MIN },
      { stage: "build", from: 7 * MIN, to: 82 * MIN },
      { stage: "review", from: 82 * MIN, to: 95 * MIN },
      { stage: "fix", from: 95 * MIN, to: 98 * MIN },
    ] as const;
    const segs = stageSegments({ task, timeline: [...timeline] });
    expect(segs.map((s) => [s.label, s.ms / MIN, s.state])).toEqual([
      ["规格", 4, "past"], ["复述", 3, "past"], ["开发", 75, "past"], ["审查", 16, "current"], ["合并", 0, "future"], ["上线", 0, "future"], ["验证", 0, "future"],
    ]);
  });
});

describe("最近 3 件事", () => {
  test("新的在上；建任务 / 改字段 / 空 note 不算；各类事件的一句话", () => {
    const events = [
      ev("task", { op: "new" }),
      ev("deliver", { headSHA: "0b7b79c1234" }, "", "agent-task-t5"),
      ev("review", { round: 1, verdict: "changes", p0: 0, p1: 2, p2: 1, reviewer: "claude-reviewer" }, "全量重拉后位置没恢复\n细节"),
      ev("note", {}, ""),
      ev("stage", { from: "review", to: "fix" }),
      ev("task", { op: "set" }),
    ];
    expect(recentThree(events).map((r) => r.text)).toEqual([
      "pm 退回返工",
      "审查 · 第 1 轮：要改 · P0 0 · P1 2 · P2 1：全量重拉后位置没恢复",
      "task-t5 交付 · 0b7b79c",
    ]);
  });

  test("导入的近似时间标出来；拍板不写记录人；导入的事件不写操作者", () => {
    expect(recentThree([ev("decision", { approxTime: true }, "先按这个来", "agent-pm")])[0]).toMatchObject({ text: "拍板：先按这个来", approx: true });
    expect(actorName("owner")).toBe("你");
    expect(eventLine(ev("stage", { from: "spec", to: "restate" }, "", "import"))).toBe("推到「复述」");
    expect(eventLine(ev("note", {}, "老台账的一条日志", "import"))).toBe("老台账的一条日志");
    expect(eventLine(ev("stage", { from: "build", to: "review" }))).toBe("pm 推到「审查」");
    expect(eventLine(ev("verify", { result: "fail" }, "白屏"))).toBe("线上验证失败：白屏");
    expect(eventLine(ev("meta"))).toBeNull();
  });
});

describe("审查与参与者", () => {
  const events = [
    ev("review", { round: 1, verdict: "changes", p0: 0, p1: 3, p2: 7, reviewer: "claude-reviewer" }, "意见"),
    ev("review", { round: 2, verdict: "pass", p0: 0, p1: 0, p2: 1, reviewer: "claude-reviewer" }),
    ev("review", { round: 2, verdict: "pass", p0: null, reviewer: "codex" }),
  ];

  test("reviewRows：P 计数解析不出为 null", () => {
    expect(reviewRows(events).map((r) => [r.round, r.verdict, r.p0, r.p1, r.reviewer])).toEqual([
      [1, "changes", 0, 3, "claude-reviewer"],
      [2, "pass", 0, 0, "claude-reviewer"],
      [2, "pass", null, null, "codex"],
    ]);
  });

  test("执行者、PM、审查员按人去重并记轮次", () => {
    expect(participants({ task, events })).toEqual([
      { name: "task-t5", role: "executor" },
      { name: "claudestra", role: "pm" },
      { name: "claude-reviewer", role: "reviewer", rounds: [1, 2] },
      { name: "codex", role: "reviewer", rounds: [2] },
    ]);
  });
});
