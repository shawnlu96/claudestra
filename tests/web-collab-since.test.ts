/**
 * 「上次以来」摘要（web/features/collab/collab-since.ts）与回放帧（collab-replay.ts）。
 */
import { describe, expect, test } from "bun:test";
import type { LedgerEventView } from "../web/features/collab/collab-model";
import { nextIndex, replayFrames, segmentsAt, timelineAt } from "../web/features/collab/collab-replay";
import { SINCE_MAX, sinceDigest } from "../web/features/collab/collab-since";

const MIN = 60_000;
let seq = 0;
const ev = (target: string, kind: string, data: Record<string, unknown> = {}, text = "", actor = "agent-claudestra"): LedgerEventView => ({
  seq: ++seq, ts: seq * MIN, actor, target, kind, text, data,
});
const TASKS = ["T5", "T6", "T7", "T8", "T9", "T10", "T11"].map((id) => ({ id, title: `任务 ${id}` }));

describe("sinceDigest", () => {
  test("每条任务只说最要紧的一件：返工压过后来的交付审查；上线压过进入合并；审查通过压过进入合并", () => {
    const d = sinceDigest([
      ev("T5", "review", { round: 2, verdict: "changes" }),
      ev("T5", "stage", { from: "review", to: "fix", round: 2 }),
      ev("T5", "stage", { from: "fix", to: "review", round: 3 }),
      ev("T10", "stage", { from: "review", to: "merge" }),
      ev("T10", "deploy", { version: "v2.31.0" }),
      ev("T6", "review", { round: 1, verdict: "pass" }),
      ev("T6", "stage", { from: "review", to: "merge" }),
    ], TASKS);
    expect(d.items.map((i) => [i.text, i.tone, i.title])).toEqual([
      ["T5 被退回返工 · 第 2 轮", "red", "任务 T5"],
      ["T10 上线", "green", "任务 T10"],
      ["T6 审查通过", "green", "任务 T6"],
    ]);
    expect([...d.changed].sort()).toEqual(["T10", "T5", "T6"]);
    expect(d.more).toBe(0);
  });

  test("出问题的几类：回滚、线上验证失败、受阻、审查拦下；新派发与普通推进排在后面", () => {
    const d = sinceDigest([
      ev("T5", "stage", { from: "spec", to: "restate" }),
      ev("T6", "task", { op: "new" }),
      ev("T7", "rollback"),
      ev("T8", "verify", { result: "fail" }),
      ev("T9", "stage", { from: "build", to: "blocked" }),
      ev("T11", "review", { verdict: "block" }),
    ], TASKS);
    expect(d.items.map((i) => i.text)).toEqual(["T11 被退回返工", "T9 受阻", "T8 线上验证失败", "T7 回滚", "新派 T6"]);
    expect(d.more).toBe(1);
    expect(d.items.length).toBe(SINCE_MAX);
    expect(d.changed.size).toBe(6);
  });

  test("不值得说的事件（交付、改字段）不成条，但任务照样算变过；空台账事件 → 空摘要", () => {
    const d = sinceDigest([ev("T5", "deliver", { headSHA: "abc" }), ev("T6", "task", { op: "set" })], TASKS);
    expect(d.items).toEqual([]);
    expect([...d.changed].sort()).toEqual(["T5", "T6"]);
    expect(sinceDigest([], TASKS)).toEqual({ items: [], more: 0, changed: new Set() });
  });

  test("英文：文案走 tr", () => {
    const tr = (s: string, p?: Record<string, string | number>) => `[${s}]${p ? JSON.stringify(p) : ""}`;
    expect(sinceDigest([ev("T5", "deploy")], TASKS, tr).items[0].text).toBe('[{id} 上线]{"id":"T5"}');
  });
});

describe("回放", () => {
  const events = [
    ev("T5", "task", { op: "new" }),
    ev("T5", "task", { op: "set" }),
    ev("T5", "stage", { from: "spec", to: "restate" }),
    ev("T5", "stage", { from: "restate", to: "build" }),
    ev("T5", "stage", { from: "build", to: "blocked" }, "等 owner 拍板"),
    ev("T5", "stage", { from: "blocked", to: "build" }),
    ev("T5", "deliver", { headSHA: "0b7b79c1234" }, "", "agent-task-t5"),
    ev("T5", "stage", { from: "build", to: "review" }),
  ];
  const frames = replayFrames(events);

  test("建任务是第一帧；改字段不成帧；每帧带那一刻的阶段，受阻记住受阻前的阶段", () => {
    expect(frames.map((f) => [f.text, f.stage, f.stageBefore])).toEqual([
      ["建任务", "spec", null],
      ["claudestra 推到「复述」", "restate", null],
      ["claudestra 推到「开发」", "build", null],
      ["claudestra 推到「受阻」：等 owner 拍板", "blocked", "build"],
      ["claudestra 推到「开发」", "build", null],
      ["task-t5 交付 · 0b7b79c", "build", null],
      ["claudestra 推到「审查」", "review", null],
    ]);
  });

  test("阶段条画成那一刻：之后开始的段不算、跨过的段截在那一刻；受阻落在受阻前的列", () => {
    const timeline = [
      { stage: "spec", from: events[0].ts, to: events[2].ts },
      { stage: "restate", from: events[2].ts, to: events[3].ts },
      { stage: "build", from: events[3].ts, to: events[4].ts },
      { stage: "blocked", from: events[4].ts, to: events[5].ts },
      { stage: "build", from: events[5].ts, to: events[7].ts },
      { stage: "review", from: events[7].ts, to: events[7].ts + 30 * MIN },
    ] as const;
    expect(timelineAt([...timeline], events[3].ts).map((e) => e.stage)).toEqual(["spec", "restate", "build"]);
    const blocked = segmentsAt(frames[3], [...timeline]);
    expect(blocked.map((s) => s.state)).toEqual(["past", "past", "current", "future", "future", "future", "future"]);
    expect(blocked[2].ms).toBe(MIN);
    const last = segmentsAt(frames[6], [...timeline]);
    expect(last[3]).toMatchObject({ state: "current", ms: 0 });
  });

  test("播放头走到末帧就停", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBeNull();
    expect(replayFrames([])).toEqual([]);
  });
});
