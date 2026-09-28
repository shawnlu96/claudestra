/**
 * 用量看板的纯逻辑：token / 花费按 runtime 分行、额度卡的来源与窗口文案。单测 tests/web-usage-view.test.ts。
 * bridge /stats 的新字段一律可选：老 bridge 没有 quotas / reportedCostUsd / machine / window，照常显示老的那部分。
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

/** bridge /stats 的 window：今日从本地 00:00，本周 = 周额度周期（quota）或拿不到重置时刻时的滚动 7 天（rolling） */
export interface UsageWindowView {
  dayStart?: number;
  weekStart?: number;
  weekSource?: string;
}

/** bridge /stats 的 machine：这台机器上全部会话（含已结束的、子 agent、终端里直接开的），按响应去重 */
export interface MachineView {
  today?: UsageWin;
  week?: UsageWin;
  byRuntime?: Record<string, { today?: UsageWin; week?: UsageWin }>;
  scannedAt?: number;
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

function sumCell(list: Array<UsageWin | undefined>): UsageCell {
  const c: UsageCell = { tokens: 0, costUsd: 0, reportedCostUsd: 0 };
  for (const w of list) {
    c.tokens += w?.tokens || 0;
    c.costUsd += w?.costUsd || 0;
    c.reportedCostUsd += w?.reportedCostUsd || 0;
  }
  return c;
}

/** a − b，逐项不小于 0（全机合计与 agent 行不是同一时刻算的，相减可能出现小负数） */
function minusCell(a: UsageCell, b: UsageCell): UsageCell {
  return {
    tokens: Math.max(0, a.tokens - b.tokens),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
    reportedCostUsd: Math.max(0, a.reportedCostUsd - b.reportedCostUsd),
  };
}

function rowsFor(key: string, label: string, list: Array<{ today?: UsageWin; week?: UsageWin }>): UsageRow[] {
  const today = sumCell(list.map((a) => a.today));
  const week = sumCell(list.map((a) => a.week));
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

/** 合计一行 + 每种 runtime 一行；只有一种 runtime 时不拆（拆出来和合计一模一样） */
function totalAndRuntimeRows(label: string, groups: Map<string, Array<{ today?: UsageWin; week?: UsageWin }>>): UsageRow[] {
  const flat = [...groups.values()].flat();
  if (groups.size < 2) return rowsFor("all", label, flat);
  const all = rowsFor("all", label, flat).filter((r) => r.kind === "usage");
  const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return [...all, ...keys.flatMap((k) => rowsFor(k, RUNTIME_LABEL[k] ?? k, groups.get(k)!))];
}

/**
 * 有全机合计（新 bridge）：这台机器合计 → 各 runtime → agent 当前会话 → 其他会话（= 合计 − agent，不为负）。
 * 没有（老 bridge / 首次扫描还没出结果）：只有 agent 当前会话的合计，按 runtime 逐家分——标签如实写「当前会话」，不冒充全机。
 */
export function groupUsageRows(agents: StatAgent[], machine?: MachineView | null): UsageRow[] {
  const byRuntime = new Map<string, StatAgent[]>();
  for (const a of agents) {
    const k = runtimeKey(a.runtime);
    byRuntime.set(k, [...(byRuntime.get(k) ?? []), a]);
  }
  if (!machine) return totalAndRuntimeRows("agent 当前会话", byRuntime);
  const groups = new Map(Object.entries(machine.byRuntime ?? {}).map(([k, v]) => [runtimeKey(k), [v]]));
  if (groups.size === 0) groups.set("claude-code", [{ today: machine.today, week: machine.week }]);
  const rows = totalAndRuntimeRows("这台机器合计", groups);
  const mine = rowsFor("agents", "agent 当前会话", agents)[0];
  const total = rows[0];
  const others = minusCell(total.today, mine.today);
  const othersWeek = minusCell(total.week, mine.week);
  return [...rows, mine, { key: "others", label: "其他会话", kind: "usage", today: others, week: othersWeek }];
}

/** 用量表的三样数据；老 bridge 没有 machine / window → null（表格退回「agent 当前会话」口径、列头不写起点） */
export interface UsageTableData {
  agents: StatAgent[];
  machine: MachineView | null;
  window: UsageWindowView | null;
}

export function usageTableData(j: { agents?: unknown; machine?: unknown; window?: unknown }): UsageTableData {
  const obj = <T>(v: unknown): T | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as T) : null);
  return { agents: Array.isArray(j.agents) ? j.agents : [], machine: obj<MachineView>(j.machine), window: obj<UsageWindowView>(j.window) };
}

/** 「本周」列头下的起点说明：周额度周期写「自 9/23 06:00」（手机本地时间），滚动写「近 7 天」；老 bridge 没有 window → 空 */
export function weekColumnNote(w: UsageWindowView | null | undefined, en: boolean): string {
  if (!w || typeof w.weekStart !== "number") return "";
  if (w.weekSource !== "quota") return en ? "last 7 days" : "近 7 天";
  const d = new Date(w.weekStart);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${en ? "since" : "自"} ${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtTok(n: number): string {
  // 全机一周是几十亿 token，「3287.9M」要数位才读得出量级
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
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
