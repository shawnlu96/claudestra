/**
 * 审查员信号（T12c）：PM 会话里的后台子 agent（bridge bg-activity 的 subagent）按 description 里的任务号挂到任务线上。
 * 只认台账 meta.pms 里 PM 的子 agent：执行者自己起的子 agent 标题里也可能出现「review T12c」，挂上去就是误报。
 * 约定写法是 `Review <任务号> r<N>` / `Adversarial review <任务号> r<N>`（PM 09-28），旧写法（round 3、Recheck、PR #142）照样认。
 * 不持久：bridge 重启时在跑的审查员丢了就丢了（bg watcher 的 baseline 设计），跑完自然恢复。单测 tests/web-collab-reviewers.test.ts。
 */
import { bareAgent, sortLines, type HomeView, type LineView, type Tr } from "./collab-model";
import { fillParams } from "@/lib/i18n-fill";

const zh: Tr = fillParams;

export interface ReviewerHit {
  taskId: string;
  /** 标题里写了第几轮；没写为 null，由台账推 */
  round: number | null;
  adversarial: boolean;
}

/** 审查类关键词：review / re-review / recheck / audit / 审查 / 复核 / 审核；不认单独的 check（「check T5 CI」不是审查） */
const REVIEW_RE = /(?:^|[^a-z])(?:re-?)?review(?:s|ing)?(?![a-z])|(?:^|[^a-z])re-?check(?:s|ing)?(?![a-z])|(?:^|[^a-z])audit(?![a-z])|审查|复核|审核/i;
const ROUND_RES = [/(?:^|[^a-z])round\s*(\d{1,3})(?!\d)/i, /(?:^|[^a-z0-9])r(\d{1,3})(?![a-z0-9])/i, /第\s*(\d{1,3})\s*轮/];
const ADVERSARIAL_RE = /adversarial|对抗/i;
/** 任务号两边不能再接字母数字或连字符：T12b 不会误中 T12，T2b-2 整体认出 */
const ID_EDGE = "A-Za-z0-9-";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 标题里第一个出现的已知任务号；大小写不敏感（台账写 T12C、PM 写 T12c），同位置大小写都对得上的优先 */
function findTaskId(title: string, taskIds: readonly string[]): string | null {
  let best: { id: string; at: number; exact: boolean } | null = null;
  for (const id of [...taskIds].sort((a, b) => b.length - a.length)) {
    const m = new RegExp(`(?:^|[^${ID_EDGE}])(${escapeRe(id)})(?![${ID_EDGE}])`, "i").exec(title);
    if (!m) continue;
    const at = m.index + m[0].length - m[1].length;
    const exact = m[1] === id;
    if (!best || at < best.at || (at === best.at && exact && !best.exact)) best = { id, at, exact };
  }
  return best?.id ?? null;
}

export function parseReviewer(title: string, taskIds: readonly string[]): ReviewerHit | null {
  const t = title.replace(/^\s*🤖\s*/u, "");
  if (!REVIEW_RE.test(t)) return null;
  const taskId = findTaskId(t, taskIds);
  if (!taskId) return null;
  let round: number | null = null;
  for (const re of ROUND_RES) {
    const m = re.exec(t);
    if (m) {
      round = Number(m[1]);
      break;
    }
  }
  return { taskId, round, adversarial: ADVERSARIAL_RE.test(t) };
}

export interface RunningReviewer extends ReviewerHit {
  /** bg 活动的稳定 id（agent-xxx），completed 事件只带它 */
  id: string;
  pm: string;
  startedAt: number;
}
export type ReviewerMap = ReadonlyMap<string, RunningReviewer>;

interface BgEvent {
  type: string;
  agent: string;
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

function hitOf(pm: string, id: string, kind: unknown, title: unknown, startedAt: number, pms: ReadonlySet<string>, taskIds: readonly string[]): RunningReviewer | null {
  if (kind !== "subagent" || !pms.has(pm) || typeof title !== "string") return null;
  const hit = parseReviewer(title, taskIds);
  return hit ? { ...hit, id, pm, startedAt } : null;
}

/** 连上 / 重连：以各 PM 的 bg-tasks 快照为准整表重建（断线期间的 completed 收不到，旧表不可信） */
export function seedReviewers(snaps: readonly { pm: string; tasks: readonly BgSnapshot[] }[], pms: ReadonlySet<string>, taskIds: readonly string[]): ReviewerMap {
  const out = new Map<string, RunningReviewer>();
  for (const { pm, tasks } of snaps) {
    const name = bareAgent(pm)!;
    for (const t of tasks) {
      const r = hitOf(name, t.id, t.kind, t.title, t.startedAt, pms, taskIds);
      if (r) out.set(r.id, r);
    }
  }
  return out;
}

/** bg_task_started 进表、bg_task_completed 出表；其余事件原样返回同一个引用 */
export function reduceReviewer(map: ReviewerMap, e: BgEvent, pms: ReadonlySet<string>, taskIds: readonly string[], now: number): ReviewerMap {
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
  const r = hitOf(bareAgent(e.agent)!, id, d.kind, d.title, now, pms, taskIds);
  return r ? new Map(map).set(id, r) : map;
}

export function reviewersByTask(map: ReviewerMap): Map<string, RunningReviewer[]> {
  const out = new Map<string, RunningReviewer[]>();
  for (const r of map.values()) out.set(r.taskId, [...(out.get(r.taskId) ?? []), r]);
  for (const list of out.values()) list.sort((a, b) => a.startedAt - b.startedAt);
  return out;
}

/** 第几轮：标题写了用标题的；review 阶段按台账的轮次（交付一次 +1）；其它阶段的复核不硬猜 */
function roundOf(running: readonly RunningReviewer[], l: Pick<LineView, "stage" | "round">): number | null {
  const given = running.map((r) => r.round).filter((n): n is number => n !== null);
  if (given.length) return Math.max(...given);
  return l.stage === "review" ? Math.max(1, l.round) : null;
}

/** 首页一条线上的审查员信号：review 阶段改写阶段短语；其它阶段（返工中起的复核等）只挂一个小标 */
export function reviewerOverlay(l: LineView, running: readonly RunningReviewer[] | undefined, tr: Tr = zh): { stageLabel: string; tag: string | null } {
  if (!running?.length) return { stageLabel: l.stageLabel, tag: null };
  const adv = running.some((r) => r.adversarial) ? ` · ${tr("对抗式")}` : "";
  const n = roundOf(running, l);
  if (l.stage === "review") return { stageLabel: tr("审查中 · 第 {n} 轮 · 审查员在跑", { n: n ?? 1 }) + adv, tag: null };
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
