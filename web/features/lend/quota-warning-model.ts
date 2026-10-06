/**
 * 网页顶部额度提醒条的纯模型（QWARN1）：输入是 QLINE1 的 GET /lend/quota-lines 回包（lend-quota-model.ts QuotaLinesView），
 * 输出「哪几族要提醒、提醒什么、关掉记什么」。状态只看 bridge 判好的 state / limit，不按百分比自己猜、不算 slots。
 * - 只有 warn / stop 出提醒；unknown（读不到、已过重置）不出肯定提醒，也不当 0 或「已恢复」；below 不出。
 * - 模式 off = 没有生效的线，不出；observe 照出但写明「只观察、未执行」。
 * - 两族各一条，互不顶替。
 * 关掉按「本设备（localStorage）+ 本实例（机器 fp）+ 家族」记一个 key，key 里含周窗口世代（resetAt）、状态 + 收窄档、
 * 两条线（阈值版本）与模式：同一条线不再弹；提醒→停接、改线 / 改模式、新的一周 key 变了就再出现。tests/web-quota-warning.test.ts。
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

export type DismissMap = Record<string, string>;

const scopeOf = (instance: string, family: QuotaFamily) => `${instance}|${family}`;

export function parseDismissed(raw: string | null): DismissMap {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export const isDismissed = (m: DismissMap, instance: string, it: WarnItem): boolean => m[scopeOf(instance, it.family)] === it.key;

/** 记下这一条被关掉（同实例同家族只留最新一个 key，总数封顶，旧的先丢） */
export function withDismissed(m: DismissMap, instance: string, it: WarnItem): DismissMap {
  const scope = scopeOf(instance, it.family);
  const rest = Object.entries(m).filter(([k]) => k !== scope).slice(-(MAX_SCOPES - 1));
  return { ...Object.fromEntries(rest), [scope]: it.key };
}
