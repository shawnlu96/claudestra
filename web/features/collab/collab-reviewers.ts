/**
 * 审查员信号（T12c）：PM 会话里的后台子 agent（bridge bg-activity 的 subagent）按 description 挂到任务线上（解析在 collab-reviewer-parse.ts）。
 * 只认台账 meta.pms 里 PM 的子 agent：执行者自己起的子 agent 标题里也可能出现「review T12c」，挂上去就是误报。
 * 约定写法是 `Review <任务号> r<N>` / `Adversarial review <任务号> r<N>`（PM 09-28），旧写法（round 3、Recheck、PR #142）照样认。
 * 不持久：bridge 重启时在跑的审查员丢了就丢了（bg watcher 的 baseline 设计），跑完自然恢复。单测 tests/web-collab-reviewers.test.ts。
 */
import { bareAgent, sortLines, type HomeView, type LineView, type Tr } from "./collab-model";
import { parseReviewer, type ReviewerHit, type ReviewTarget } from "./collab-reviewer-parse";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export interface RunningReviewer extends ReviewerHit {
  /** bg 活动的稳定 id（agent-xxx），completed 事件只带它 */
  id: string;
  pm: string;
  startedAt: number;
}
export type ReviewerMap = ReadonlyMap<string, RunningReviewer>;

export interface BgEvent {
  type: string;
  agent: string;
  /** bridge 发事件的时刻（ISO）：「已跑多久」按它算，不用收到时的本机时钟 */
  ts?: string;
  data?: Record<string, unknown>;
}
interface BgSnapshot {
  id: string;
  kind: string;
  title: string;
  startedAt: number;
}

/** 规范成前端会话名的 PM 集合（meta.pms 可能带 agent- 前缀） */
export function pmSet(pms: readonly string[]): Set<string> {
  return new Set(pms.map((p) => bareAgent(p)!).filter(Boolean));
}

function hitOf(pm: string, id: string, kind: unknown, title: unknown, startedAt: number, pms: ReadonlySet<string>, targets: readonly ReviewTarget[]): RunningReviewer | null {
  if (kind !== "subagent" || !pms.has(pm) || typeof title !== "string") return null;
  const hit = parseReviewer(title, targets);
  return hit ? { ...hit, id, pm, startedAt } : null;
}

/** 连上 / 重连：以各 PM 的 bg-tasks 快照为准整表重建（断线期间的 completed 收不到，旧表不可信） */
export function seedReviewers(snaps: readonly { pm: string; tasks: readonly BgSnapshot[] }[], pms: ReadonlySet<string>, targets: readonly ReviewTarget[]): ReviewerMap {
  const out = new Map<string, RunningReviewer>();
  for (const { pm, tasks } of snaps) {
    const name = bareAgent(pm)!;
    for (const t of tasks) {
      const r = hitOf(name, t.id, t.kind, t.title, t.startedAt, pms, targets);
      if (r) out.set(r.id, r);
    }
  }
  return out;
}

/**
 * bridge 在子 agent 的 meta 还没落盘时起的占位标题（bg-activity-watcher.ts 的 titleFor）：description 晚到，
 * 这种 started 先不挂，过一会儿按快照重建（那时 bridge 会重读 meta）。
 */
export function isPlaceholderStart(e: BgEvent, pms: ReadonlySet<string>): boolean {
  const d = e.data ?? {};
  return e.type === "bg_task_started" && d.kind === "subagent" && pms.has(bareAgent(e.agent)!) && typeof d.title === "string" && /^🤖 subagent [\w-]{1,20}$/u.test(d.title);
}

/** bg_task_started 进表、bg_task_completed 出表；其余事件原样返回同一个引用 */
export function reduceReviewer(map: ReviewerMap, e: BgEvent, pms: ReadonlySet<string>, targets: readonly ReviewTarget[], now: number): ReviewerMap {
  const d = e.data ?? {};
  const id = typeof d.id === "string" ? d.id : null;
  if (!id) return map;
  if (e.type === "bg_task_completed") {
    if (!map.has(id)) return map;
    const next = new Map(map);
    next.delete(id);
    return next;
  }
  if (e.type !== "bg_task_started") return map;
  const at = e.ts ? Date.parse(e.ts) : NaN;
  const r = hitOf(bareAgent(e.agent)!, id, d.kind, d.title, Number.isFinite(at) ? at : now, pms, targets);
  return r ? new Map(map).set(id, r) : map;
}

export function reviewersByTask(map: ReviewerMap): Map<string, RunningReviewer[]> {
  const out = new Map<string, RunningReviewer[]>();
  for (const r of map.values()) out.set(r.taskId, [...(out.get(r.taskId) ?? []), r]);
  for (const list of out.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

/** 第几轮：标题写了用标题的；review 阶段按台账的轮次（交付一次 +1）；其它阶段的复核不硬猜 */
function roundOf(running: readonly RunningReviewer[], l: Pick<LineView, "stage" | "round" | "roundUnknown">): number | null {
  const given = running.map((r) => r.round).filter((n): n is number => n !== null);
  if (given.length) return Math.max(...given);
  // 团队卡没有轮次：标题也没写就不编
  return l.stage === "review" && !l.roundUnknown ? Math.max(1, l.round) : null;
}

/** 首页一条线上的审查员信号：review 阶段改写阶段短语；其它阶段（返工中起的复核等）只挂一个小标 */
export function reviewerOverlay(l: LineView, running: readonly RunningReviewer[] | undefined, tr: Tr = zh): { stageLabel: string; tag: string | null } {
  if (!running?.length) return { stageLabel: l.stageLabel, tag: null };
  const adv = running.some((r) => r.adversarial) ? ` · ${tr("对抗式")}` : "";
  const n = roundOf(running, l);
  if (l.stage === "review") {
    const label = n === null ? `${tr("审查中")} · ${tr("审查员在跑")}` : tr("审查中 · 第 {n} 轮 · 审查员在跑", { n });
    return { stageLabel: label + adv, tag: null };
  }
  return { stageLabel: l.stageLabel, tag: (n ? tr("审查员在跑 · 第 {n} 轮", { n }) : tr("审查员在跑")) + adv };
}

export interface ReviewedLine extends LineView {
  reviewerTag: string | null;
}

/**
 * 把审查员信号叠到首页：review 阶段有审查员在跑 = 有人在干活，不算「卡住」（降回等待、去掉超时原因），
 * 一句话状态的卡住数与排序跟着重算。没有审查员在跑的线原样保留。
 */
export function applyReviewers(v: HomeView, byTask: ReadonlyMap<string, readonly RunningReviewer[]>, tr: Tr = zh): { lines: ReviewedLine[]; headline: HomeView["headline"] } {
  const lines = v.lines.map((l): ReviewedLine => {
    const running = byTask.get(l.id);
    const o = reviewerOverlay(l, running, tr);
    const unstick = !!running?.length && l.stage === "review" && l.attention === "stuck";
    return { ...l, stageLabel: o.stageLabel, reviewerTag: o.tag, ...(unstick ? { attention: "waiting" as const, stuck: false, reason: "" } : {}) };
  });
  const sorted = sortLines(lines) as ReviewedLine[];
  return { lines: sorted, headline: { ...v.headline, stuck: sorted.filter((l) => l.attention === "stuck").length } };
}
