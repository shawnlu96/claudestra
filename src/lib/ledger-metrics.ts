/**
 * 内置台账的任务指标（docs 10-ledger §3「指标」）：输入一个任务与它的事件，算用时、审查轮数、返工、等复核、P0/P1/P2、回滚。
 * 纯函数、只 import 类型——指标由读接口（T8c）算好下发，网页不直接 import src。
 * 时间一律 epoch ms；事件按 seq 顺序给（listEvents 的默认顺序），同一毫秒的多条以 seq 定先后。
 */
import { endStages, TERMINAL_STAGES, type LedgerEvent, type LedgerTask, type Stage } from "./ledger-stages.js";

export interface StageEntry {
  stage: Stage;
  /** 进入时刻 */
  from: number;
  /** 离开时刻；还停在这里 = now；终态（done / cancelled）不计时，from === to */
  to: number;
}

export interface TaskMetrics {
  /** 时间线上第一段不是 spec / blocked / cancelled 的：通常是 restate（ops 为 build），导入任务就是它落下的阶段 */
  startTs: number | null;
  /** code / ops 取第一次进 verified（没有才看 done），investigate 取 done；cancelled 也算结束；没结束为 null */
  endTs: number | null;
  /** end（没结束则 now）− start */
  totalMs: number;
  /** totalMs 减去这段时间里 blocked 的部分 */
  workMs: number;
  /** blocked 单列：整个生命周期里停在 blocked 的总时长 */
  blockedMs: number;
  /** 同一阶段多次进入累加；不含 blocked，终态不计时 */
  stageMs: Partial<Record<Stage, number>>;
  /** review 事件数 */
  reviewRounds: number;
  /** 进入 fix 的次数（从 blocked 回到 fix 不算） */
  reworkCount: number;
  /** 每段「第一次 deliver → 下一条 review 事件」；中间多次 deliver 只从第一次算 */
  reviewWaits: number[];
  reviewWaitMs: number;
  /** 最后一次交付还没等到 review：从那次（第一次）deliver 到 now；没有则 null */
  reviewWaitPendingMs: number | null;
  p0: number;
  p1: number;
  p2: number;
  /** rollback 事件数 */
  rollbacks: number;
}

/** 任务的阶段时间线：建任务事件给出初始阶段，之后每条 stage 事件一段 */
export function stageTimeline(events: readonly LedgerEvent[], now: number): StageEntry[] {
  const marks: { stage: Stage; ts: number }[] = [];
  for (const e of events) {
    if (e.kind === "task" && e.data.op === "new") {
      const patch = (e.data.patch ?? {}) as { stage?: Stage };
      marks.push({ stage: patch.stage ?? "spec", ts: e.ts });
    } else if (e.kind === "stage") {
      marks.push({ stage: e.data.to as Stage, ts: e.ts });
    }
  }
  return marks.map((m, i) => {
    const terminal = TERMINAL_STAGES.includes(m.stage);
    const to = terminal ? m.ts : i + 1 < marks.length ? marks[i + 1].ts : Math.max(now, m.ts);
    return { stage: m.stage, from: m.ts, to };
  });
}

/** 停在这些阶段不算开工：spec→blocked 不是开工，导入后 review→spec→restate 也不能把起点挪到后面那次 restate */
const NOT_STARTED: readonly Stage[] = ["spec", "blocked", "cancelled"];

function overlap(e: StageEntry, start: number, end: number): number {
  return Math.max(0, Math.min(e.to, end) - Math.max(e.from, start));
}

/** 起止点与总用时 / 干活用时 / 分阶段 / blocked */
function timeMetrics(
  kind: LedgerTask["kind"],
  timeline: readonly StageEntry[],
  now: number,
): Pick<TaskMetrics, "startTs" | "endTs" | "totalMs" | "workMs" | "blockedMs" | "stageMs"> {
  const first = timeline.find((e) => !NOT_STARTED.includes(e.stage));
  const startTs = first?.from ?? null;
  let endTs: number | null = null;
  for (const s of endStages(kind)) {
    const hit = timeline.find((e) => e.stage === s && (startTs === null || e.from >= startTs));
    if (hit) {
      endTs = hit.from;
      break;
    }
  }
  const stageMs: Partial<Record<Stage, number>> = {};
  let blockedMs = 0;
  for (const e of timeline) {
    if (e.stage === "blocked") blockedMs += e.to - e.from;
    else if (!TERMINAL_STAGES.includes(e.stage)) stageMs[e.stage] = (stageMs[e.stage] ?? 0) + (e.to - e.from);
  }
  if (startTs === null) return { startTs, endTs, totalMs: 0, workMs: 0, blockedMs, stageMs };
  const end = endTs ?? now;
  const totalMs = Math.max(0, end - startTs);
  const blockedInside = timeline.filter((e) => e.stage === "blocked").reduce((s, e) => s + overlap(e, startTs, end), 0);
  return { startTs, endTs, totalMs, workMs: totalMs - blockedInside, blockedMs, stageMs };
}

/** 等复核：第一次 deliver 开始计时，遇到下一条 review 事件结算；中间的 deliver 不重开计时 */
function reviewWaits(events: readonly LedgerEvent[], now: number): { waits: number[]; pendingMs: number | null } {
  const waits: number[] = [];
  let pending: number | null = null;
  for (const e of events) {
    if (e.kind === "deliver" && pending === null) pending = e.ts;
    else if (e.kind === "review" && pending !== null) {
      waits.push(e.ts - pending);
      pending = null;
    }
  }
  return { waits, pendingMs: pending === null ? null : Math.max(0, now - pending) };
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** events 可以是整个项目的，这里只取 target === task.id 的 */
export function taskMetrics(task: Pick<LedgerTask, "id" | "kind">, events: readonly LedgerEvent[], now: number): TaskMetrics {
  const own = events.filter((e) => e.target === task.id).sort((a, b) => a.seq - b.seq);
  const time = timeMetrics(task.kind, stageTimeline(own, now), now);
  const reviews = own.filter((e) => e.kind === "review");
  const waits = reviewWaits(own, now);
  return {
    ...time,
    reviewRounds: reviews.length,
    reworkCount: own.filter((e) => e.kind === "stage" && e.data.to === "fix" && e.data.from !== "blocked").length,
    reviewWaits: waits.waits,
    reviewWaitMs: waits.waits.reduce((s, w) => s + w, 0),
    reviewWaitPendingMs: waits.pendingMs,
    p0: reviews.reduce((s, e) => s + count(e.data.p0), 0),
    p1: reviews.reduce((s, e) => s + count(e.data.p1), 0),
    p2: reviews.reduce((s, e) => s + count(e.data.p2), 0),
    rollbacks: own.filter((e) => e.kind === "rollback").length,
  };
}
