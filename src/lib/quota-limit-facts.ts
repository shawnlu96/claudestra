/**
 * 额度的「已撞限」事实与满额边界（纯函数；tests/quota-audit-limit.test.ts）。
 *   - 撞限事实是提供方自己说的（wham/usage 的 limit_reached / allowed、rollout 的 rate_limit_reached_type），与百分比互不推导：
 *     true = 明确已撞限，false = 明确没撞限，null = 没说（缺字段、形状不对、观测时刻不可信）。null 不是 false。
 *   - 满额边界：舍入不能把不到 100 的读数变成 100；100 以外的数值照原精度舍入，各处阈值的比较不归这里管。
 */

/** true = 提供方明确已撞限；false = 明确没撞限；null = 不知道 */
export type LimitFact = boolean | null;

/** DTO 里只在「不是明确没撞限」时才出现的标记；不带 = 接口明确说没撞限 */
export type LimitMark = "reached" | "unknown";

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

/** wham/usage 的 rate_limit 块：limit_reached=true 或 allowed=false 任一成立就是已撞限；两个都没给布尔值 = 不知道 */
export function whamLimitFact(rl: { limit_reached?: unknown; allowed?: unknown }): LimitFact {
  const reached = bool(rl.limit_reached);
  const allowed = bool(rl.allowed);
  if (reached === true || allowed === false) return true;
  return reached === false || allowed === true ? false : null;
}

export const limitMarkOf = (fact: LimitFact): LimitMark | undefined => (fact === true ? "reached" : fact === null ? "unknown" : undefined);

/** 落盘的 Codex 用量快照 → 撞限事实。没有 limitFact 标记的旧快照只剩 limitReached 一个布尔值，照它读 */
function dtoLimitFact(d: { limitReached?: unknown; limitFact?: unknown } | null | undefined): LimitFact {
  if (!d) return null;
  if (d.limitFact === "reached" || d.limitReached === true) return true;
  if (d.limitFact === "unknown") return null;
  return d.limitReached === false ? false : null;
}

/** rollout 的 rate_limit_reached_type：有类型串 = 已撞限；null 与缺字段在解析后分不开，一律按不知道，不当成「没撞限」 */
function rolloutLimitFact(reachedType: unknown): LimitFact {
  return typeof reachedType === "string" && reachedType.length > 0 ? true : null;
}

/** 留存的「已撞限」：at = 提供方明确说已撞限的那次观测时刻；until = 那次观测里的窗口全部重置完的时刻，算不出来 = null（不编日期） */
export interface HeldLimit { at: number; until: number | null }

/** 此刻作数的撞限事实与它自己的观测时刻（与百分比的观测时刻分开：没有一个窗口有数时事实照样有时刻） */
export interface TimedLimitFact { fact: LimitFact; at: number | null }

type ResetWindow = { resetsAtMs?: number | null };
type LimitDto = { limitReached?: unknown; limitFact?: unknown; limitHeld?: unknown; windows?: readonly ResetWindow[] };

const UNKNOWN: TimedLimitFact = { fact: null, at: null };
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 「已撞限」最晚作数到什么时候。撞的是哪个窗口接口没说，单个窗口过了重置时刻不算解除：那次观测里每个窗口都在事实之后重置过，事实才失效。
 * 有窗口没给重置时刻，或重置时刻不晚于事实的观测时刻（早于声明的重置证明不了声明失效）→ null：没有截止，只等明确的解闸或更新的观测。
 */
export function limitHorizon(at: number, windows: readonly ResetWindow[]): number | null {
  const resets = windows.map((w) => w.resetsAtMs);
  return resets.length && resets.every((t): t is number => finite(t) && t > at) ? Math.max(...resets) : null;
}

/** 这份快照带着的「已撞限」：自己明确说的，或缺标志时从同账户上一份快照留下来的（retainLimitFact）；形状不对的留存不认 */
function heldOf(d: LimitDto, observedAt: number): HeldLimit | null {
  const own = dtoLimitFact(d);
  if (own === true) return { at: observedAt, until: limitHorizon(observedAt, d.windows ?? []) };
  const h = own === null && d.limitHeld && typeof d.limitHeld === "object" ? (d.limitHeld as Partial<HeldLimit>) : null;
  if (!h || !finite(h.at) || h.at <= 0 || h.at > observedAt || !(h.until === null || finite(h.until))) return null;
  return { at: h.at, until: h.until };
}

const standing = (h: HeldLimit | null, now: number): TimedLimitFact => (h && (h.until === null || h.until > now) ? { fact: true, at: h.at } : UNKNOWN);

/** 落盘的 Codex 用量快照此刻作数的事实：明确没撞限照读；已撞限（自己说的或留存的）作数到 limitHorizon */
export function snapshotLimitFact(d: LimitDto | null | undefined, observedAt: number, now: number): TimedLimitFact {
  if (!d) return UNKNOWN;
  return dtoLimitFact(d) === false ? { fact: false, at: observedAt } : standing(heldOf(d, observedAt), now);
}

/** rollout 观测此刻作数的事实：百分比有没有数不影响它 */
export function rolloutLimitNow(reachedType: unknown, observedAt: number, windows: readonly ResetWindow[], now: number): TimedLimitFact {
  return rolloutLimitFact(reachedType) === true ? standing({ at: observedAt, until: limitHorizon(observedAt, windows) }, now) : UNKNOWN;
}

/**
 * 同账户的新快照接替旧快照时调用（quota-scheduler 入库处）：新响应没说撞没撞限，而旧快照带着还作数的「已撞限」→ 把它连同原观测时刻带进新快照。
 * 缺字段不是解闸；新响应明确 allowed=true / limit_reached=false（或再次明确已撞限）时原样返回，旧事实就此被纠正。
 */
export function retainLimitFact<T extends object>(prev: { data: object; observedAt: number } | null | undefined, next: T, at: number): T {
  if (!prev || dtoLimitFact(next) !== null) return next;
  const held = heldOf(prev.data, prev.observedAt);
  return standing(held, at).fact === true ? { ...next, limitHeld: held } : next;
}

/**
 * 按 digits 位小数四舍五入（与原来各处的精度相同），只多一条：原值不到 100 时结果最多 99.9（digits 1）/ 99（digits 0）。
 * 99.96 → 99.9、99.5 → 99：读数没到 100 就不能显示或上报成用满。
 */
export function roundPctBelowFull(raw: number, digits: 0 | 1): number {
  const k = digits === 1 ? 10 : 1;
  const rounded = Math.round(raw * k) / k;
  return raw < 100 && rounded >= 100 ? (100 * k - 1) / k : rounded;
}
