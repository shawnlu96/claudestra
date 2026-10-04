/**
 * 详情里的「回放」（T12c，ux.md 第三层的只读简化版）：把一条任务的台账事件排成帧，播放头走到哪一帧，
 * 阶段条就画成那一刻的样子。只用 GET /ledger/:project/tasks/:id 已有的 events + timeline，不新增接口；
 * agent 间消息、工具历史没有持久化（data-gaps 第 8、9 项），不在回放里。单测在 tests/web-collab-since.test.ts 的「回放」一节。
 */
import { eventLine, isRedacted, STAGE_NAME, stageSegments, type Segment, type StageEntryView } from "./collab-detail-model";
import type { LedgerEventView, Stage, Tr } from "./collab-model";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export interface ReplayFrame {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  /** 这一帧之后任务所处的阶段；null = 还没有阶段证据（脱敏 / 缺字段的团队数据），播放器画成「阶段未知」 */
  stage: Stage | null;
  /** stage 为 blocked 时受阻前的阶段（阶段条落列用） */
  stageBefore: Stage | null;
  approx: boolean;
}

/** 只认合法阶段名：任意文本不是阶段证据 */
const asStage = (v: unknown): Stage | null => (typeof v === "string" && Object.hasOwn(STAGE_NAME, v) ? (v as Stage) : null);
const isNewTask = (e: LedgerEventView) => e.kind === "task" && !isRedacted(e) && e.data.op === "new";

/**
 * 一条事件给出的阶段证据：非脱敏建任务的 patch.stage（真实 bridge 一律写，src/lib/ledger-write.ts insertTask），
 * 或非脱敏 stage 事件的 to；都要是合法阶段名。没有 = null（阶段保持不变，不回落 spec）。
 */
function stageEvidence(e: LedgerEventView): Stage | null {
  if (isRedacted(e)) return null;
  if (isNewTask(e)) return asStage((e.data.patch as { stage?: unknown } | undefined)?.stage);
  return e.kind === "stage" ? asStage(e.data.to) : null;
}

/** 有没有任何阶段证据：没有就不回放（团队只有类型 / 时间的事件排不出阶段，界面给「回放仅主场」） */
export function hasStageEvidence(events: readonly LedgerEventView[]): boolean {
  return events.some((e) => stageEvidence(e) !== null);
}

/** 会成帧的事件种类（与 eventLine 说话的那几类一致；note 还要有正文，脱敏 note 说类型）；tests 里有一条用例核对两边不走样 */
const FRAME_KINDS = new Set(["stage", "deliver", "review", "decision", "deploy", "verify", "rollback"]);
const framable = (e: LedgerEventView) =>
  isNewTask(e) || FRAME_KINDS.has(e.kind) || (e.kind === "note" && (isRedacted(e) || e.text.trim() !== ""));

/** 能不能回放（至少 2 帧、且有阶段证据）：只数、不拼文案，详情收起时用它决定出不出按钮 */
export function hasReplay(events: readonly LedgerEventView[]): boolean {
  if (!hasStageEvidence(events)) return false;
  let n = 0;
  for (const e of events) if (framable(e) && ++n >= 2) return true;
  return false;
}

/** 事件 → 帧：建任务算第一帧；「最近 3 件事」不说的事件（改字段、事项）不成帧，但阶段照样跟着走 */
export function replayFrames(events: readonly LedgerEventView[], tr: Tr = zh): ReplayFrame[] {
  const out: ReplayFrame[] = [];
  // 没有证据前阶段未知（null）：不假定从 spec 开始
  let stage: Stage | null = null;
  let before: Stage | null = null;
  for (const e of events) {
    let text: string | null;
    const to = stageEvidence(e);
    if (isNewTask(e)) {
      stage = to;
      text = tr("建任务");
    } else {
      if (to) {
        before = to === "blocked" ? (stage === "blocked" ? before : stage) : null;
        stage = to;
      }
      text = eventLine(e, tr);
    }
    if (text) out.push({ seq: e.seq, ts: e.ts, kind: e.kind, text, stage, stageBefore: before, approx: !isRedacted(e) && e.data.approxTime === true });
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
