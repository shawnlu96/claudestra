/**
 * 详情里的「回放」（T12c，ux.md 第三层的只读简化版）：把一条任务的台账事件排成帧，播放头走到哪一帧，
 * 阶段条就画成那一刻的样子。只用 GET /ledger/:project/tasks/:id 已有的 events + timeline，不新增接口；
 * agent 间消息、工具历史没有持久化（data-gaps 第 8、9 项），不在回放里。单测 tests/web-collab-replay.test.ts。
 */
import { eventLine, stageSegments, type Segment, type StageEntryView } from "./collab-detail-model";
import type { LedgerEventView, Stage, Tr } from "./collab-model";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export interface ReplayFrame {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  /** 这一帧之后任务所处的阶段 */
  stage: Stage;
  /** stage 为 blocked 时受阻前的阶段（阶段条落列用） */
  stageBefore: Stage | null;
  approx: boolean;
}

function newTaskStage(e: LedgerEventView): Stage {
  const patch = e.data.patch as { stage?: unknown } | undefined;
  return typeof patch?.stage === "string" ? (patch.stage as Stage) : "spec";
}

/** 事件 → 帧：建任务算第一帧；「最近 3 件事」不说的事件（改字段、事项）不成帧，但阶段照样跟着走 */
export function replayFrames(events: readonly LedgerEventView[], tr: Tr = zh): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  let stage: Stage = "spec";
  let before: Stage | null = null;
  for (const e of events) {
    let text: string | null;
    if (e.kind === "task" && e.data.op === "new") {
      stage = newTaskStage(e);
      text = tr("建任务");
    } else {
      if (e.kind === "stage" && typeof e.data.to === "string") {
        const to = e.data.to as Stage;
        before = to === "blocked" ? (stage === "blocked" ? before : stage) : null;
        stage = to;
      }
      text = eventLine(e, tr);
    }
    if (text) out.push({ seq: e.seq, ts: e.ts, kind: e.kind, text, stage, stageBefore: before, approx: e.data.approxTime === true });
  }
  return out;
}

/** 截到 ts 那一刻的时间线：之后开始的段不算，跨过 ts 的段截在 ts */
export function timelineAt(timeline: readonly StageEntryView[], ts: number): StageEntryView[] {
  return timeline.filter((e) => e.from <= ts).map((e) => ({ ...e, to: Math.min(e.to, ts) }));
}

/** 某一帧的阶段条：当前段按帧的阶段，各段用时按截到这一刻的时间线 */
export function segmentsAt(frame: ReplayFrame, timeline: readonly StageEntryView[]): Segment[] {
  return stageSegments({ task: frame, timeline: timelineAt(timeline, frame.ts) });
}

/** 播放头的下一步：到末帧就停在末帧（返回 null = 该停了） */
export function nextIndex(i: number, total: number): number | null {
  return i + 1 < total ? i + 1 : null;
}
