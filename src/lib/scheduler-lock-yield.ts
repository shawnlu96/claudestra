/**
 * RLOCK2：停滞卡让出 scheduler_resources 里的锁。纯函数：台账事实（scheduler-lock-yield-read.ts）+ 本机 agent 活动进，判定与计划出。
 * 停滞（前提：卡持锁）任一即算：a. blocked 已满 LOCK_YIELD_STALL_MS（以进 blocked 的阶段事件为准）；b. 同样长没进展：
 * 没有 pending / submitted / unknown 意图、没有 pooled / claimed / unknown 出借单、没有 deliver / review / stage / step 事件、
 * 绑定的本机执行者 / 审查员没有活动回合（LIFE1 的 recent 判定）。豁免：冻结卡、合并在途、security 模板、判定数据读不出。
 * 让锁只删这张卡的锁行；去重按卡 + 停滞起点。模式走恢复策略键 lockYield（默认 observe）；阈值是常量，改它 = owner 改代码。
 * MRGSTALE1：最新合并记录只剩 await_review（没有活的 merge 意图）另算 mergeAwaitReview，是否仍按合并在途豁免看恢复策略键 mergeStaleYield
 * （mergeExempt，车道 dag-lane-lock-yield.ts 同调）：off / observe 照旧豁免（observe 停滞成立时另记一条「本可让锁」），on 不再豁免。
 */
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { RecoveryMode } from "./recovery-policy.js";

export const LOCK_YIELD_KEY = "lockYield" as const;
export const MERGE_STALE_KEY = "mergeStaleYield" as const;
export const LOCK_YIELD_STALL_MS = 2 * 3_600_000;
const FROZEN_CARDS: readonly string[] = ["T13f", "T48", "T60b", "T78", "T75", "T41c", "T44", "T82"];
export const RELEASED_OP = "lock_yield_released";
export const CONTEND_OP = "lock_yield_contended";
/** 等锁的卡在这些阶段还要拿文件锁（与 ledger-deadlock.ts 的 WRITE_WAIT 同口径） */
const WRITE_WAIT: readonly string[] = ["spec", "restate", "build", "fix"];
/** 恢复后真正要重新拿文件锁的阶段：调度器只在 build / fix 派单时拿文件锁 */
const RELOCK_STAGES: readonly string[] = ["build", "fix"];
/** 这些阶段的卡锁由 releaseFinishedCardLeases 收，不归这里 */
const FINISHED: readonly string[] = ["live", "verified", "done", "cancelled"];

export interface YieldHeld { resource: string; taskId: string; intentId: string; acquiredAt: number; scope: string }
/**
 * 绑定到卡上的本机 agent：recent = LIFE1 的 recent 判定；lastAt = 最近一次活动时刻（读不到 = null）；sessionId 供写侧核 ACP 心跳；
 * unknown = 活动数据在但读坏（不判）；sig = 读到的活动原料签名，写事务里重读比对
 */
export interface YieldAgent { name: string; recent: boolean; lastAt: number | null; sessionId?: string | null; unknown?: string; sig?: string }
export interface YieldCard {
  id: string; project: string; stage: string; branch: string | null;
  /** null = tasks.extra 读不了 */
  extra: { fileGlobs?: unknown; frozen?: unknown } | null;
  workflow: { template: string; mode: string } | null;
  /** 最近一次进 blocked 的阶段事件时刻 */
  blockedAt: number | null;
  /** 最近一条 deliver / review / stage / step 事件 */
  progressAt: number | null;
  liveIntents: string[]; intentAt: number | null;
  liveOrders: string[]; orderAt: number | null;
  /** merge-begin 之后到结清之前（最新一条 scheduler_merges 是 ready / updating / await_ci / merging / unknown，或 merge 意图未结） */
  mergeOpen: boolean;
  /** 最新一条 scheduler_merges 是 await_review、没有活的 merge 意图：那条记录；否则 null（缺省 = null） */
  mergeAwaitReview?: MergeAwaitReview | null;
}
export interface MergeAwaitReview { intentId: string; updatedAt: number }
export interface YieldFacts { project: string; cards: readonly YieldCard[]; held: readonly YieldHeld[]; unknown: readonly string[] }

export type Basis = "blocked" | "idle";
export type Stall =
  | { kind: "stalled"; basis: Basis; since: number; evidence: string }
  | { kind: "skip"; why: string };
export interface Waiter { taskId: string; files: string[]; canStart: boolean; stillBlockedBy: string[] }
export interface YieldCandidate { taskId: string; basis: Basis; since: number; evidence: string; resources: string[]; waiters: Waiter[] }

const isFile = (r: string): boolean => !r.includes(":") && !r.startsWith("/");
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const maxOf = (xs: readonly (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null);
  return ok.length ? Math.max(...ok) : null;
};

/** 按合并在途豁免与否（让锁判定与车道同一份）：mergeOpen 一律豁免；只剩 await_review 旧记录的，mergeStaleYield 是 on 才不豁免 */
export function mergeExempt(card: Pick<YieldCard, "mergeOpen" | "mergeAwaitReview">, mergeStale: RecoveryMode): boolean {
  return card.mergeOpen || (!!card.mergeAwaitReview && mergeStale !== "on");
}

/** 豁免一律不让；返回 null = 不豁免 */
function exemption(card: YieldCard, held: readonly YieldHeld[], mergeStale: RecoveryMode): string | null {
  if (card.extra === null) return "extra 读不了，冻结与否不确定";
  if (FROZEN_CARDS.includes(card.id) || card.extra.frozen === true) return "冻结卡";
  if (!card.workflow) return "没有调度流程记录，模板不确定";
  if (card.workflow.template === "security") return "security 模板";
  if (mergeExempt(card, mergeStale) || held.some((h) => h.taskId === card.id && h.resource.startsWith("merge:"))) return "合并在途";
  if (FINISHED.includes(card.stage)) return `已在 ${card.stage}`;
  return null;
}

/** b 的「没进展」：任一活着的事实都不算停滞；起点 = 各类事实里最晚的一刻 */
function idleStall(card: YieldCard, agents: readonly YieldAgent[] | null, mine: readonly YieldHeld[], now: number, stallMs: number): Stall {
  if (card.liveIntents.length) return { kind: "skip", why: `有未结调度意图 ${card.liveIntents[0]}` };
  if (card.liveOrders.length) return { kind: "skip", why: `有活着的出借单 ${card.liveOrders[0]}` };
  if (agents === null) return { kind: "skip", why: "本机 agent 活动读不了" };
  const bad = agents.find((a) => a.unknown);
  if (bad) return { kind: "skip", why: `本机 agent 活动读不了（${bad.name} ${bad.unknown}）` };
  const busy = agents.find((a) => a.recent);
  if (busy) return { kind: "skip", why: `绑定的 ${busy.name} 有活动回合` };
  const since = maxOf([card.progressAt, card.intentAt, card.orderAt, ...agents.map((a) => a.lastAt), ...mine.map((h) => h.acquiredAt)]);
  if (since === null) return { kind: "skip", why: "进展时刻读不出" };
  if (now - since < stallMs) return { kind: "skip", why: `没进展未满 ${stallMs / 3_600_000} 小时` };
  return { kind: "stalled", basis: "idle", since, evidence: `自 ${iso(since)} 起无意图 / 出借单 / 交付 / 审查 / 阶段 / 步骤事件，绑定 agent 无活动回合` };
}

/** a 先于 b：blocked 时 b 的起点不早于进 blocked 那一刻，同一段停滞总落在同一个起点上。mergeStale = 当次 mergeStaleYield 模式（缺省 off = 改前口径） */
export function stallOf(card: YieldCard, held: readonly YieldHeld[], agents: readonly YieldAgent[] | null, now: number,
  stallMs = LOCK_YIELD_STALL_MS, mergeStale: RecoveryMode = "off"): Stall {
  const mine = held.filter((h) => h.taskId === card.id);
  if (!mine.length) return { kind: "skip", why: "没持锁" };
  const exempt = exemption(card, held, mergeStale);
  if (exempt) return { kind: "skip", why: exempt };
  if (card.stage === "blocked" && card.blockedAt !== null && now - card.blockedAt >= stallMs) {
    return { kind: "stalled", basis: "blocked", since: card.blockedAt, evidence: `自 ${iso(card.blockedAt)} 起在 blocked` };
  }
  return idleStall(card, agents, mine, now, stallMs);
}

/** 卡登记的文件范围；不合法 = null */
function globsOf(card: YieldCard): string[] | null {
  const raw = card.extra?.fileGlobs;
  if (!Array.isArray(raw) || !raw.length) return null;
  const keys = raw.map((g) => (typeof g === "string" ? resourceKey(g) : null));
  return keys.includes(null) ? null : [...new Set(keys as string[])].sort();
}

const overlapping = (wanted: readonly string[], rows: readonly YieldHeld[]): YieldHeld[] =>
  rows.filter((h) => isFile(h.resource) && wanted.some((w) => resourcesOverlap(w, resourceKey(h.resource) ?? h.resource.toLowerCase())));

/** 让出这些锁后哪些等锁的卡能开工：auto、还要拿文件锁、与让出的锁相交；canStart = 剩下的持锁行不再挡它 */
export function waitersFor(f: YieldFacts, taskId: string): Waiter[] {
  const released = f.held.filter((h) => h.taskId === taskId);
  const rest = f.held.filter((h) => h.taskId !== taskId);
  const out: Waiter[] = [];
  for (const c of f.cards) {
    if (c.id === taskId || c.workflow?.mode !== "auto" || !WRITE_WAIT.includes(c.stage)) continue;
    const wanted = globsOf(c);
    if (!wanted) continue;
    const freed = overlapping(wanted, released);
    if (!freed.length) continue;
    const still = [...new Set(overlapping(wanted, rest.filter((h) => h.taskId !== c.id)).map((h) => h.taskId))].sort();
    out.push({ taskId: c.id, files: [...new Set(freed.map((h) => h.resource))].sort(), canStart: !still.length, stillBlockedBy: still });
  }
  return out;
}

/**
 * mergeStaleYield 是 observe 时「本可让锁」的那张卡：只因最新合并记录只剩 await_review 才豁免（按 on 判停滞成立）。
 * 返回按 on 判出的候选与那条合并记录；别的情况 null。写侧重核调同一个函数。
 */
export function mergeStaleCandidate(f: YieldFacts, card: YieldCard, agents: readonly YieldAgent[] | null, now: number,
  mergeStale: RecoveryMode, stallMs = LOCK_YIELD_STALL_MS): { candidate: YieldCandidate; merge: MergeAwaitReview } | null {
  if (mergeStale !== "observe" || !card.mergeAwaitReview) return null;
  const s = stallOf(card, f.held, agents, now, stallMs, "on");
  if (s.kind === "skip") return null;
  const resources = f.held.filter((h) => h.taskId === card.id).map((h) => h.resource).sort();
  return { candidate: { taskId: card.id, basis: s.basis, since: s.since, evidence: s.evidence, resources, waiters: waitersFor(f, card.id) },
    merge: card.mergeAwaitReview };
}

/**
 * 本轮该让锁（或在 observe 下记一条）的卡；取数有 unknown 时整轮不让。mergeStale = 当次 mergeStaleYield 模式（缺省 off = 改前口径）；
 * mergeStale 列的是 mergeStaleYield observe 下「本可让锁」的卡（它们照旧在 skipped 里按合并在途豁免）。
 */
export function planLockYield(f: YieldFacts, agents: (taskId: string) => readonly YieldAgent[] | null, now: number,
  stallMs = LOCK_YIELD_STALL_MS, mergeStale: RecoveryMode = "off"): {
  candidates: YieldCandidate[]; skipped: { taskId: string; why: string }[]; mergeStale: { candidate: YieldCandidate; merge: MergeAwaitReview }[];
} {
  if (f.unknown.length) return { candidates: [], skipped: [{ taskId: "", why: `取数不完整：${f.unknown.join("；").slice(0, 300)}` }], mergeStale: [] };
  const holders = new Set(f.held.map((h) => h.taskId));
  const candidates: YieldCandidate[] = [], skipped: { taskId: string; why: string }[] = [], stale: { candidate: YieldCandidate; merge: MergeAwaitReview }[] = [];
  for (const c of f.cards) {
    if (!holders.has(c.id)) continue;
    const s = stallOf(c, f.held, agents(c.id), now, stallMs, mergeStale);
    if (s.kind === "skip") {
      skipped.push({ taskId: c.id, why: s.why });
      const m = mergeStaleCandidate(f, c, agents(c.id), now, mergeStale, stallMs);
      if (m) stale.push(m);
      continue;
    }
    const resources = f.held.filter((h) => h.taskId === c.id).map((h) => h.resource).sort();
    candidates.push({ taskId: c.id, basis: s.basis, since: s.since, evidence: s.evidence, resources, waiters: waitersFor(f, c.id) });
  }
  return { candidates, skipped, mergeStale: stale };
}

export const yieldDedupKey = (taskId: string, since: number): string => `lock-yield:${taskId}:${since}`;
export const observeActionKey = (since: number): string => `stall:${since}`;
export const contendKey = (releaseSeq: number): string => `lock-yield-contend:${releaseSeq}`;

const waiterText = (ws: readonly Waiter[]): string => ws.length
  ? ws.map((w) => `${w.taskId}${w.canStart ? "可开工" : `仍被 ${w.stillBlockedBy.join("、")} 挡`}`).join("、") : "暂无等锁的卡";

/** mergeStaleYield observe 的「本可让锁」文案：先说合并记录那句（不被截掉），再接 lockYield 的候选文案 */
export function mergeStaleText(c: YieldCandidate, m: MergeAwaitReview): string {
  return `合并记录只剩 await_review（${m.intentId}，${iso(m.updatedAt)}），mergeStaleYield 切 on 后会让：${candidateText(c)}`.slice(0, 560);
}

export function candidateText(c: YieldCandidate): string {
  const res = c.resources.length > 8 ? `${c.resources.slice(0, 8).join("、")} 等 ${c.resources.length} 个` : c.resources.join("、");
  return `让出 ${c.taskId} 的锁（${c.basis === "blocked" ? "blocked 满 2 小时" : "2 小时无进展"}：${c.evidence}）：${res}；${waiterText(c.waiters)}`.slice(0, 500);
}

/** 让过锁的卡恢复推进后要重新拿锁：只看 auto 卡、build / fix 阶段；被别卡占着的文件锁 */
export interface Contention { holders: { taskId: string; branch: string | null; files: string[] }[] }
export function contentionOf(card: YieldCard, f: Pick<YieldFacts, "cards" | "held">): Contention | null {
  if (card.workflow?.mode !== "auto" || !RELOCK_STAGES.includes(card.stage)) return null;
  const wanted = globsOf(card);
  if (!wanted) return null;
  const rows = overlapping(wanted, f.held.filter((h) => h.taskId !== card.id));
  if (!rows.length) return null;
  const by = new Map<string, string[]>();
  for (const h of rows) by.set(h.taskId, [...(by.get(h.taskId) ?? []), h.resource]);
  const branch = (id: string) => f.cards.find((c) => c.id === id)?.branch ?? null;
  return { holders: [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([taskId, files]) => ({ taskId, branch: branch(taskId), files: files.sort() })) };
}

export function contentionText(card: YieldCard, releaseSeq: number, c: Contention): string {
  const who = c.holders.map((h) => `${h.taskId}（分支 ${h.branch ?? "未知"}）占着 ${h.files.slice(0, 6).join("、")}${h.files.length > 6 ? ` 等 ${h.files.length} 个` : ""}`);
  return (`[调度引擎] ${card.id} 停滞时让出过文件锁（事件 #${releaseSeq}），现已恢复推进但拿不回：${who.join("；")}。` +
    `本卡分支 ${card.branch ?? "未知"}。照常等待，不抢回、不踢后来的卡；合并时两边的改动都要保留。`).slice(0, 900);
}
