/**
 * 用量看板的纯逻辑：token / 花费按 runtime 分行、额度卡的来源与窗口文案。单测 tests/web-usage-view.test.ts。
 * bridge /stats 的新字段一律可选：老 bridge 没有 quotas / reportedCostUsd，照常显示老的那部分。
 */

export interface UsageWin {
  tokens: number;
  /** 按 API 牌价折算（没有牌价的模型为 0） */
  costUsd?: number;
  /** 运行时报告的费用（目前只有 Pi）；与 costUsd 不重叠 */
  reportedCostUsd?: number;
}

/** bridge /stats agents 项（只取看板要用的字段） */
export interface StatAgent {
  name: string;
  runtime?: string | null;
  today?: UsageWin;
  week?: UsageWin;
}

export interface UsageCell {
  tokens: number;
  costUsd: number;
  reportedCostUsd: number;
}

export interface UsageRow {
  key: string;
  /** 中文原文（组件里过 t()）或品牌名 */
  label: string;
  /** usage = token · 牌价折算；reported = 运行时报告的费用（挂在所属 runtime 下面一行） */
  kind: "usage" | "reported";
  today: UsageCell;
  week: UsageCell;
}

const RUNTIME_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", pi: "Pi" };
const RUNTIME_ORDER = ["claude-code", "codex", "pi"];

/** 空 / 缺省 runtime = 老 bridge / 老 registry，那时只有 Claude Code */
export function runtimeKey(runtime: string | null | undefined): string {
  return runtime || "claude-code";
}

function sumCell(list: StatAgent[], win: "today" | "week"): UsageCell {
  const c: UsageCell = { tokens: 0, costUsd: 0, reportedCostUsd: 0 };
  for (const a of list) {
    c.tokens += a[win]?.tokens || 0;
    c.costUsd += a[win]?.costUsd || 0;
    c.reportedCostUsd += a[win]?.reportedCostUsd || 0;
  }
  return c;
}

function rowsFor(key: string, label: string, list: StatAgent[]): UsageRow[] {
  const today = sumCell(list, "today");
  const week = sumCell(list, "week");
  const rows: UsageRow[] = [{ key, label, kind: "usage", today, week }];
  if (today.reportedCostUsd > 0 || week.reportedCostUsd > 0) {
    rows.push({ key: `${key}:reported`, label: "运行时报告的费用", kind: "reported", today, week });
  }
  return rows;
}

const rank = (k: string) => {
  const i = RUNTIME_ORDER.indexOf(k);
  return i < 0 ? RUNTIME_ORDER.length : i;
};

/**
 * 全机合计一行 + 每种 runtime 一行；只有一种 runtime 时不拆（拆出来和合计一模一样）。
 * 按 runtime 字段逐家分——以前只认 pi，Codex agent 被算进了 Claude Code。
 */
export function groupUsageRows(agents: StatAgent[]): UsageRow[] {
  const byRuntime = new Map<string, StatAgent[]>();
  for (const a of agents) {
    const k = runtimeKey(a.runtime);
    byRuntime.set(k, [...(byRuntime.get(k) ?? []), a]);
  }
  if (byRuntime.size < 2) return rowsFor("all", "全机合计", agents);
  const all = rowsFor("all", "全机合计", agents).filter((r) => r.kind === "usage");
  const keys = [...byRuntime.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...all, ...keys.flatMap((k) => rowsFor(k, RUNTIME_LABEL[k] ?? k, byRuntime.get(k)!))];
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** 牌价折算一格为 null = 有 token 却一分钱都没折算出来（没有牌价：Codex、未知模型），显示「—」而不是 $0.00 */
export function listPriceUsd(c: UsageCell): number | null {
  return c.tokens > 0 && c.costUsd === 0 ? null : c.costUsd;
}

/** 一格的文字：usage 行 "1.2M · $3.40"（无牌价 "1.2M · —"），reported 行 "$0.12" */
export function fmtUsageCell(row: UsageRow, win: "today" | "week"): string {
  const c = row[win];
  if (row.kind === "reported") return `$${c.reportedCostUsd.toFixed(2)}`;
  const usd = listPriceUsd(c);
  return `${fmtTok(c.tokens)} · ${usd === null ? "—" : `$${usd.toFixed(2)}`}`;
}

// ── 额度卡 ──────────────────────────────────────────────────────────────

/** Claude 卡的数据来源。global.raw 是 bridge 写的来源标记，或 /status 面板抓下来的原文 */
export function claudeQuotaSource(raw: string | undefined): "statusline" | "statusline-stale" | "status-panel" | null {
  if (!raw) return null;
  if (raw === "statusline cache") return "statusline";
  if (raw === "statusline cache (stale)") return "statusline-stale";
  return "status-panel";
}

export interface QuotaWindowView {
  id: string;
  windowMinutes?: number | null;
  pct?: number | null;
  resets?: string;
  resetPassed?: boolean;
}

/** bridge quotas 数组里的一项（lib/codex-usage.ts 的 CodexQuotaObservation） */
export interface QuotaView {
  source: string;
  plan?: string | null;
  windows?: QuotaWindowView[];
  credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
  limitReached?: string | null;
  observedAt?: number;
  sessionId?: string;
  cwd?: string | null;
  agent?: string | null;
}

/** 认得的额度卡（未知 source 的是更新的 bridge 加的，老前端不认就不画） */
export function codexQuotas(quotas: unknown): QuotaView[] {
  if (!Array.isArray(quotas)) return [];
  return quotas.filter((q): q is QuotaView => !!q && typeof q === "object" && (q as QuotaView).source === "codex-rollout");
}

/** "5h" → 5 小时窗口 / 5h window；"7d" → 7 天窗口 / 7d window；认不出的（槽位名）原样 */
export function windowLabel(id: string, en: boolean): string {
  const m = /^(\d+)([mhd])$/.exec(id);
  if (!m) return id;
  if (en) return `${id} window`;
  return `${m[1]} ${{ m: "分钟", h: "小时", d: "天" }[m[2] as "m" | "h" | "d"]}窗口`;
}

/** 卡片上「来自哪个会话」：registry agent 名 > 工作目录末段，再带会话 id 前 8 位 */
export function quotaOrigin(q: QuotaView): string {
  const who = q.agent?.replace(/^agent-/, "") || q.cwd?.split("/").filter(Boolean).pop() || "";
  const sid = q.sessionId ? q.sessionId.slice(0, 8) : "";
  return [who, sid].filter(Boolean).join(" · ");
}
