/**
 * 网页顶部额度提醒条的纯模型（QWARN1）：输入是 QLINE1 的 GET /lend/quota-lines 回包（lend-quota-model.ts QuotaLinesView），
 * 输出「哪几族要提醒、提醒什么、关掉记什么」。状态只看 bridge 判好的 state / limit，不按百分比自己猜、不算 slots。
 * - 只有 warn / stop 出提醒；unknown（读不到、已过重置）不出肯定提醒，也不当 0 或「已恢复」；below 不出。
 * - 模式 off = 没有生效的线，不出；observe 照出但写明「只观察、未执行」。
 * - 两族各一条，互不顶替。
 * 关掉按「本设备（localStorage）+ 本实例（机器 fp）+ 家族」记，只认最近一个线世代（周窗口 resetAt + 两条线 + 模式，带开始时刻）里
 * 关掉过的状态 + 收窄档：同一条线不再弹；提醒→停接、改线 / 改模式（改回旧值也算新一代）、新的一周就再出现。tests/web-quota-warning-*.test.ts。
 */
import type { FamilyLine, QuotaFamily, QuotaLinesView } from "./lend-quota-model";

export interface WarnItem {
  family: QuotaFamily;
  /** 关掉时记下的 key（不含实例；实例在 dismiss 存储里另作作用域） */
  key: string;
  level: "warn" | "stop";
  usedPct: number;
  resetAt: number | null;
  /** 已停止接新单（bridge limit = zero） */
  stopped: boolean;
  /** 线在执行（mode on）；false = 只观察 */
  enforced: boolean;
  /** 读数是同一周窗口内的上次读数，不是刚读到的 */
  lastKnown: boolean;
}

export const FAMILY_LABEL: Record<QuotaFamily, string> = { claude: "Claude", codex: "Codex" };

const itemKey = (f: FamilyLine, mode: string): string =>
  [f.resetAt ?? "noreset", `${f.state}:${f.limit}`, `${f.warnPct}/${f.stopPct}`, mode].join("|");

/** 回包 → 要显示的提醒（每族最多一条，顺序同回包）；null / undefined（无权限 / 还没读到）= 不显示 */
export function warningItems(view: QuotaLinesView | null | undefined, now: number): WarnItem[] {
  if (!view || view.config.mode === "off") return [];
  const out: WarnItem[] = [];
  for (const f of view.families) {
    if (f.state !== "warn" && f.state !== "stop") continue;
    if (f.weekUsedPct === null) continue; // 理论上 bridge 不会给，防御：缺值不出肯定提醒
    if (f.resetAt !== null && f.resetAt <= now) continue; // 读数所属的周窗口已过：等下一次读数，不当已恢复也不再断言
    out.push({
      family: f.family, key: itemKey(f, view.config.mode), level: f.state, usedPct: f.weekUsedPct, resetAt: f.resetAt,
      stopped: f.limit === "zero", enforced: view.config.mode === "on", lastKnown: f.freshness === "last_known",
    });
  }
  return out;
}

/** 一条提醒的文案（中文原文 + 变量，渲染处经 quota-warning-i18n 翻译） */
export function warnTexts(it: WarnItem): { title: string; status: string } {
  const title = it.level === "stop" ? "{family} 本周已用 {pct}%，达到停接线" : "{family} 本周已用 {pct}%，达到提醒线";
  const status = it.stopped ? "已停止接新单，在跑的单照常做完"
    : it.level === "stop" ? "只观察：未停接，仍在接新单"
    : it.enforced ? "未停接，新单名额已减半" : "只观察：未停接，名额未缩减";
  return { title, status };
}

// ── 关掉记录（本设备 localStorage；跨 tab 经 storage 事件同步） ──

export const DISMISS_KEY = "cstra_quota_warning_dismissed";
const MAX_SCOPES = 32;
/** 同一世代里记几种关掉过的状态（实际只有 warn / stop 各一种，留余量） */
const MAX_STATES = 8;

/** 实例|家族 → 只记最近一个线世代的关掉记录。gen = 周窗口（resetAt）+ 两条线（阈值版本）+ 模式；since = 这一代开始被关掉的时刻
 * （同设备各 tab 同一时钟），把「70/80 → 60/80 → 改回 70/80」的两次 70/80 区分成两代；states = 本代关掉过的「状态:收窄档」。
 * 世代一变，旧世代的关掉整条作废、不会因为数值改回来而复活（settings-return-1）；合并两份记录时同一代取并集，
 * 不同代取 since 新的那代，旧内存里再多旧代也挤不掉别的 tab 已落盘的当前代（dismiss-memory-1）。 */
export interface DismissRec { gen: string; since: number; states: string[] }
export type DismissMap = Record<string, DismissRec>;

const scopeOf = (instance: string, family: QuotaFamily) => `${instance}|${family}`;
/** key = resetAt|状态:收窄档|warn/stop|模式 → [世代, 状态] */
const splitKey = (key: string): [string, string] => {
  const [reset, state, line, mode] = key.split("|");
  return [[reset, line, mode].join("|"), state ?? ""];
};

const isRec = (v: unknown): v is DismissRec => !!v && typeof v === "object" && typeof (v as DismissRec).gen === "string"
  && typeof (v as DismissRec).since === "number" && Number.isFinite((v as DismissRec).since) && Array.isArray((v as DismissRec).states);

export function parseDismissed(raw: string | null): DismissMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: DismissMap = {};
    for (const [scope, r] of Object.entries(v)) {
      if (isRec(r)) {
        const states = r.states.filter((k): k is string => typeof k === "string").slice(-MAX_STATES);
        if (states.length) out[scope] = { gen: r.gen, since: r.since, states };
        continue;
      }
      // 旧格式（每 scope 一条 key / 多条 key 数组）：只认最后一条，按最旧的一代（since 0）收进来
      const last = typeof r === "string" ? r : Array.isArray(r) ? r.filter((k): k is string => typeof k === "string").at(-1) : undefined;
      if (last) { const [gen, state] = splitKey(last); out[scope] = { gen, since: 0, states: [state] }; }
    }
    return out;
  } catch {
    return {}; // 记录损坏 = 当没关过：最多多弹一次提醒，不会把该出的提醒吞掉
  }
}

export function isDismissed(m: DismissMap, instance: string, it: WarnItem): boolean {
  const r = m[scopeOf(instance, it.family)];
  if (!r) return false;
  const [gen, state] = splitKey(it.key);
  return r.gen === gen && r.states.includes(state);
}

const capScopes = (entries: [string, DismissRec][]): DismissMap => Object.fromEntries(entries.slice(-MAX_SCOPES));

/** 同一 scope 两条记录合并：同一代（gen 与 since 都同）状态取并集；否则留 since 新的那代（同刻再按 gen 定，结果与先后无关） */
function mergeRec(x: DismissRec, y: DismissRec): DismissRec {
  if (x.gen === y.gen && x.since === y.since) return { ...x, states: [...x.states.filter((k) => !y.states.includes(k)), ...y.states].slice(-MAX_STATES) };
  if (x.since !== y.since) return x.since > y.since ? x : y;
  return x.gen > y.gen ? x : y;
}

/** 两份关掉记录合并（b 动过的 scope 排后），总数封顶 */
export function mergeDismissed(a: DismissMap, b: DismissMap): DismissMap {
  const out = new Map<string, DismissRec>(Object.entries(a));
  for (const [scope, r] of Object.entries(b)) {
    const prev = out.get(scope);
    out.delete(scope);
    out.set(scope, prev ? mergeRec(prev, r) : r);
  }
  return capScopes([...out.entries()]);
}

/** 记下这一条被关掉：当前就是这一代则追加状态，否则以 at 开新一代（旧代作废）；最近动过的 scope 排最后，总数封顶 */
export function withDismissed(m: DismissMap, instance: string, it: WarnItem, at: number = Date.now()): DismissMap {
  const scope = scopeOf(instance, it.family);
  const [gen, state] = splitKey(it.key);
  const cur = m[scope];
  const rec: DismissRec = cur && cur.gen === gen ? { ...cur, states: [...cur.states.filter((k) => k !== state), state].slice(-MAX_STATES) }
    : { gen, since: Math.max(at, cur ? cur.since + 1 : at), states: [state] };
  const out = new Map<string, DismissRec>(Object.entries(m));
  out.delete(scope);
  out.set(scope, rec);
  return capScopes([...out.entries()]);
}
