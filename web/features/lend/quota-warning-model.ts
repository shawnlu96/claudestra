/**
 * 出借额度线提醒的纯模型（QWARN1，QUOTA1 起并进顶部额度卡 features/quota/quota-notice-model.ts）：输入是 QLINE1 的
 * GET /lend/quota-lines 回包（lend-quota-model.ts QuotaLinesView），输出「哪几族到了提醒线 / 不再接新活」。状态只看 bridge 判好的
 * state / limit，不按百分比自己猜、不算 slots。
 * - 只有 warn / stop 出提醒；unknown（读不到、已过重置）不出肯定提醒，也不当 0 或「已恢复」；below 不出。
 * - 模式 off = 没有生效的线，不出；observe 照出但写明「只观察、未执行」。
 * 旧的关掉记录（DISMISS_KEY）只剩迁移要读：parseDismissed 把它读成每个实例 / 家族一份 { gen, states }，新卡读一次后不再写。
 * Claude 的周重置时刻每次观测都带几百毫秒抖动（同一周 …399963 / …400347），所以比较 resetAt 用 RESET_JITTER_MS 容差，不按全等。
 * tests/web-quota-warning-model.test.ts、tests/web-quota-warning-reset-jitter.test.ts。
 */
import { LEND_WORDS } from "@/lib/owner-words";
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

/** 一条提醒在接活上的状态句（中文原文，渲染处 t() 翻译） */
export function warnStatus(it: Pick<WarnItem, "level" | "stopped" | "enforced">): string {
  return it.stopped ? LEND_WORDS.statusStopped
    : it.level === "stop" ? LEND_WORDS.statusObserveStop
    : it.enforced ? LEND_WORDS.statusHalved : LEND_WORDS.statusObserveWarn;
}

// ── 旧的关掉记录（只读，迁移用） ──

export const DISMISS_KEY = "cstra_quota_warning_dismissed";
/** 同一世代里记几种关掉过的状态（实际只有 warn / stop 各一种，留余量） */
const MAX_STATES = 8;

/** 旧格式：每个实例 / 家族一份当前配置窗口（gen）及关掉过的状态（states，如 "warn:half"）；epoch / since 是旧的跨 tab 合并用的时刻 */
export interface DismissRec { gen: string; since: number; states: string[]; epoch?: number }
export type DismissMap = Record<string, DismissRec>;

/** 同一周的 resetAt 观测抖动上限；跨周至少差一天，远大于它。按分钟取整不行：抖动正好跨分钟边界时会被打成两代 */
export const RESET_JITTER_MS = 5 * 60_000;

/** 世代 = resetAt|warn/stop|模式：线和模式全等，resetAt 两边都是数字时差在 RESET_JITTER_MS 内算同一周 */
export function sameGen(a: string, b: string): boolean {
  if (a === b) return true;
  const [ra, ...ta] = a.split("|"), [rb, ...tb] = b.split("|");
  if (ta.join("|") !== tb.join("|")) return false;
  const x = Number(ra), y = Number(rb);
  return ra !== "" && rb !== "" && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= RESET_JITTER_MS;
}

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
        if (!states.length && !(typeof r.epoch === "number" && Number.isFinite(r.epoch))) continue;
        out[scope] = { gen: r.gen, since: r.since, states,
          ...(typeof r.epoch === "number" && Number.isFinite(r.epoch) ? { epoch: r.epoch } : {}) };
        continue;
      }
      // 旧数组可能包含同配置的 warn 和 stop：保留最后配置所属的全部状态。
      const keys = typeof r === "string" ? [r] : Array.isArray(r) ? r.filter((k): k is string => typeof k === "string") : [];
      const last = keys.at(-1);
      if (last) {
        const [gen] = splitKey(last);
        const states = [...new Set(keys.map(splitKey).filter(([g]) => sameGen(g, gen)).map(([, state]) => state))].slice(-MAX_STATES);
        out[scope] = { gen, since: 0, states };
      }
    }
    return out;
  } catch {
    return {}; // 记录损坏 = 当没关过：最多多弹一次提醒，不会把该出的提醒吞掉
  }
}
