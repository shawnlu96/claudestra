/**
 * 按卡汇总「已耗额度」（UXUSAGE1）：GET /usage/task/:id 在逐行结果之外给的 summary 对象。这里只放纯函数，数由 usage-query.ts taskUsageFacts /
 * lendOrderCounts 读、额度周窗口由 quota-week.ts readWeekQuota 给，路由（bridge/local-api/usage.ts）只负责把三样拼起来。
 * 口径：总数 = 归档（清理明细时留的底）+ 仍在保留期内的明细；借出去的单对方不回传用量，只给单数不编数；占本周额度只是估算，输入缺一样就不给。
 * 单测 tests/usage-task-summary.test.ts。
 */
import type { FamilyPart, TaskUsageFacts, TokenSums } from "./usage-query.js";

const FAMILIES = ["claude", "codex"] as const;
type Family = (typeof FAMILIES)[number];
const WEEK_MS = 7 * 24 * 3600_000;

type Tokens = TokenSums;

interface FamilyUsage extends Tokens {
  /** 计入的会话数（明细与归档里的会话合起来去重） */
  sessions: number;
  firstAt: number | null;
  lastAt: number | null;
  /** 仍在保留期内的明细部分：和逐行结果（rows）里这个家族的行加总一致 */
  detail: Tokens;
  /** 清理时归档的部分；没有归档 = null */
  archived: Tokens | null;
}

/** 估算占本周额度：本卡本周 token ÷ 本机同家族本周 token × 本周已用百分比。界面必须写「约」 */
export interface WeekEstimate {
  /** 取整到 1%；不到 1% 时为 null，看 estimateLabel */
  estimatePct: number | null;
  estimateLabel: string;
  weekStart: number;
  weekUsedPct: number;
  taskWeekTokens: number;
  machineWeekTokens: number;
}

interface LentUsage {
  /** 这张卡挂进出借池的单数（全部状态）与按状态的分布，取自台账 lend_orders */
  orders: number;
  byStatus: Record<string, number>;
  tokensReported: false;
  note: string;
}

export interface TaskUsageSummary {
  families: Partial<Record<Family, FamilyUsage>>;
  totalTokens: number;
  calls: number;
  /** 有没有归档部分（明细已清、靠清理时留底的数） */
  hasArchive: boolean;
  /** 明细最早可查日期（本机全部明细里最早的一天）；没有明细 = null */
  detailFrom: string | null;
  /** 归档上线前已清掉明细的日子：早于这一天的部分已不可查，数里没有；null = 没有丢过 */
  unavailableBefore: string | null;
  unavailableNote: string | null;
  lent: Partial<Record<Family, LentUsage>>;
  weekEstimate: Partial<Record<Family, WeekEstimate>>;
}

export interface WeekQuotaInput { weekUsedPct: number; resetAt: number }

const LENT_NOTE = "用量对方未回传";
const zero = (): Tokens => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0, reasoning: 0, totalTokens: 0, calls: 0 });
const KEYS = ["input", "cacheCreation", "cacheRead", "output", "reasoning", "totalTokens", "calls"] as const;

function add(a: Tokens, b: Tokens): Tokens {
  const out = zero();
  for (const k of KEYS) out[k] = a[k] + b[k];
  return out;
}
const tokensOf = (p: FamilyPart): Tokens => add(zero(), p);
const familyOf = (f: string): Family | null => (FAMILIES as readonly string[]).includes(f) ? f as Family : null;
const minOf = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.min(...v) : null; };
const maxOf = (xs: (number | undefined)[]) => { const v = xs.filter((x): x is number => x !== undefined); return v.length ? Math.max(...v) : null; };

/** 各家族额度周的起点（重置时刻往前 7 天）：额度读不到的家族不出现，也就不算本周 token */
export function weekStartsOf(quota: Partial<Record<string, WeekQuotaInput>>): Partial<Record<Family, number>> {
  const out: Partial<Record<Family, number>> = {};
  for (const f of FAMILIES) if (quota[f]) out[f] = quota[f]!.resetAt - WEEK_MS;
  return out;
}

/**
 * 估算占比：百分比与本机本周同家族总 token 都拿得到（总 token > 0）才给，缺一样返回 null，不写 0。
 * 本卡本周 token 不会超过本机同家族本周总数（同一张 calls 表算的），超了说明数不对，也不给。
 */
export function estimateWeekShare(quota: WeekQuotaInput | undefined, week: { task: number; machine: number } | undefined): WeekEstimate | null {
  if (!quota || !week || !Number.isFinite(quota.weekUsedPct) || !(week.machine > 0) || week.task < 0 || week.task > week.machine) return null;
  const raw = (week.task / week.machine) * quota.weekUsedPct;
  const pct = raw < 1 ? null : Math.round(raw);
  return {
    estimatePct: pct, estimateLabel: pct === null ? "不到 1%" : `约 ${pct}%`, weekStart: quota.resetAt - WEEK_MS, weekUsedPct: quota.weekUsedPct,
    taskWeekTokens: week.task, machineWeekTokens: week.machine,
  };
}

function familyUsage(f: Family, facts: TaskUsageFacts): FamilyUsage | null {
  const d = facts.detail.find((p) => p.family === f), a = facts.archive.find((p) => p.family === f);
  if (!d && !a) return null;
  const detail = d ? tokensOf(d) : zero(), archived = a ? tokensOf(a) : null;
  return {
    ...add(detail, archived ?? zero()), sessions: facts.sessions[f] ?? 0, detail, archived,
    firstAt: minOf([d?.firstAt, a?.firstAt]), lastAt: maxOf([d?.lastAt, a?.lastAt]),
  };
}

function lentOf(counts: Record<string, Record<string, number>>): Partial<Record<Family, LentUsage>> {
  const out: Partial<Record<Family, LentUsage>> = {};
  for (const [family, byStatus] of Object.entries(counts)) {
    const f = familyOf(family);
    const orders = Object.values(byStatus).reduce((s, n) => s + n, 0);
    if (f && orders > 0) out[f] = { orders, byStatus, tokensReported: false, note: LENT_NOTE };
  }
  return out;
}

/** 拼 summary：facts 来自 taskUsageFacts（weekStarts 用 weekStartsOf(quota) 算），lendCounts 来自 lendOrderCounts，quota 是 readWeekQuota 的结果 */
export function summarizeTaskUsage(facts: TaskUsageFacts, lendCounts: Record<string, Record<string, number>>,
  quota: Partial<Record<string, WeekQuotaInput>>): TaskUsageSummary {
  const families: Partial<Record<Family, FamilyUsage>> = {};
  const weekEstimate: Partial<Record<Family, WeekEstimate>> = {};
  let total = zero();
  for (const f of FAMILIES) {
    const u = familyUsage(f, facts);
    if (u) {
      families[f] = u;
      total = add(total, u);
    }
    const est = estimateWeekShare(quota[f], facts.week[f]);
    if (est) weekEstimate[f] = est;
  }
  const lost = facts.unarchivedBefore;
  return {
    families, totalTokens: total.totalTokens, calls: total.calls, hasArchive: facts.archive.length > 0, detailFrom: facts.detailFrom,
    unavailableBefore: lost, unavailableNote: lost ? `早于 ${lost} 的部分已不可查` : null, lent: lentOf(lendCounts), weekEstimate,
  };
}
