/**
 * team-parity-I（docs/team/team-collab-parity-plan.md §5.1 P1-I）：回放只按真实阶段证据定阶段（collab-replay.ts）。
 * 证据 = 非脱敏 task:new 的 patch.stage（合法阶段）或非脱敏 stage 事件的 to（合法阶段）；没有证据前帧的 stage = null，
 * stage 缺 to 时阶段不变，不回落 spec；一条证据都没有就 hasReplay = false（界面显示「回放仅主场」）。
 * 旧红新绿：main 上三条 redacted 事件的帧全是 spec、hasReplay 为 true；修完全为 null、不可回放。完整本机事件帧序列不变。
 */
import { describe, expect, test } from "bun:test";
import { hasReplay, hasStageEvidence, replayFrames, segmentsAt } from "../web/features/collab/collab-replay";
import type { LedgerEventView } from "../web/features/collab/collab-model";

const MIN = 60_000;
let seq = 0;
const ev = (kind: string, data: Record<string, unknown> = {}, text = "", actor = "agent-claudestra"): LedgerEventView => ({ seq: ++seq, ts: seq * MIN, actor, target: "T5", kind, text, data });
const red = (kind: string, bait: Record<string, unknown> = {}) => ev(kind, { redacted: true, ...bait });

describe("没有阶段证据不回放", () => {
  test("复现测试:三条 redacted 事件帧全为 null 且不可回放", () => {
    const events = [red("stage", { to: "build" }), red("review"), red("verify")];
    const frames = replayFrames(events);
    expect(frames.map((f) => [f.text, f.stage, f.stageBefore])).toEqual([
      ["推进阶段（目标阶段仅主场）", null, null],
      ["审查（结论仅主场）", null, null],
      ["线上验证（结果仅主场）", null, null],
    ]);
    expect(hasStageEvidence(events)).toBe(false);
    expect(hasReplay(events)).toBe(false);
  });

  test("复现测试:redacted task:new 带 patch.stage 诱饵也不算证据", () => {
    const events = [red("task", { op: "new", patch: { stage: "build" } }), red("stage"), red("deliver")];
    expect(hasStageEvidence(events)).toBe(false);
    expect(hasReplay(events)).toBe(false);
    expect(replayFrames(events).every((f) => f.stage === null)).toBe(true);
  });

  test("复现测试:task:new 没有 patch.stage、stage 缺 to 时阶段保持未知，不回退 spec", () => {
    const events = [ev("task", { op: "new" }), ev("stage", { from: "spec" }), ev("deliver", { headSHA: "abc1234" })];
    expect(replayFrames(events).map((f) => f.stage)).toEqual([null, null, null]);
    expect(hasReplay(events)).toBe(false);
  });

  test("复现测试:任意文本 / 非法阶段名不当证据", () => {
    const events = [ev("task", { op: "new", patch: { stage: "随便写的" } }), ev("stage", { to: "nope" }), ev("note", {}, "推到 build")];
    expect(hasStageEvidence(events)).toBe(false);
    expect(replayFrames(events).map((f) => f.stage)).toEqual([null, null, null]);
    expect(hasReplay(events)).toBe(false);
  });

  test("复现测试:null 帧的阶段条没有当前段（播放器画成阶段未知）", () => {
    const [f] = replayFrames([red("verify"), red("review")]);
    expect(segmentsAt(f!, []).map((s) => s.state)).toEqual(Array(7).fill("future"));
  });
});

describe("合法阶段证据出现后才开始有阶段", () => {
  test("复现测试:脱敏事件之后出现合法 stage.to → 可回放，之前的帧仍是未知", () => {
    const events = [red("review"), red("verify"), ev("stage", { from: "review", to: "merge" })];
    expect(hasStageEvidence(events)).toBe(true);
    expect(hasReplay(events)).toBe(true);
    expect(replayFrames(events).map((f) => f.stage)).toEqual([null, null, "merge"]);
  });

  test("防回归:task:new 合法 patch.stage 定初始阶段，后续 stage 照走，缺 to 的 stage 保持原阶段", () => {
    const events = [ev("task", { op: "new", patch: { stage: "build" } }), ev("stage", { from: "build" }), ev("stage", { from: "build", to: "blocked" }),
      ev("stage", { from: "blocked", to: "review" })];
    expect(replayFrames(events).map((f) => [f.stage, f.stageBefore])).toEqual([["build", null], ["build", null], ["blocked", "build"], ["review", null]]);
    expect(hasReplay(events)).toBe(true);
  });

  test("防回归:完整本机事件（task:new 带 patch.stage=spec）帧序列与文案不变", () => {
    const events = [
      ev("task", { op: "new", patch: { stage: "spec", title: "x" }, rev: 1 }),
      ev("task", { op: "set" }),
      ev("stage", { from: "spec", to: "restate" }),
      ev("stage", { from: "restate", to: "build" }),
      ev("deliver", { headSHA: "0b7b79c1234" }, "", "agent-task-t5"),
      ev("review", { round: 1, verdict: "pass", p0: 0, p1: 0, p2: 0 }),
      ev("verify", { result: "pass" }),
    ];
    expect(replayFrames(events).map((f) => [f.text, f.stage])).toEqual([
      ["建任务", "spec"],
      ["claudestra 推到「复述」", "restate"],
      ["claudestra 推到「开发」", "build"],
      ["task-t5 交付 · 0b7b79c", "build"],
      ["审查 · 第 1 轮：通过 · P0 0 · P1 0 · P2 0", "build"],
      ["线上验证通过", "build"],
    ]);
    expect(hasReplay(events)).toBe(true);
  });
});
