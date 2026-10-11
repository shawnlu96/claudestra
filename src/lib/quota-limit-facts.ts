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
export function dtoLimitFact(d: { limitReached?: unknown; limitFact?: unknown } | null | undefined): LimitFact {
  if (!d) return null;
  if (d.limitFact === "reached" || d.limitReached === true) return true;
  if (d.limitFact === "unknown") return null;
  return d.limitReached === false ? false : null;
}

/** rollout 的 rate_limit_reached_type：有类型串 = 已撞限；null 与缺字段在解析后分不开，一律按不知道，不当成「没撞限」 */
export function rolloutLimitFact(reachedType: unknown): LimitFact {
  return typeof reachedType === "string" && reachedType.length > 0 ? true : null;
}

/**
 * 观测时的事实此刻还作不作数：观测时刻不可信，或之后已有窗口过了重置时刻（撞的是哪个窗口接口没说，新窗口的状态没人知道）→ null。
 * 留着过期的 true 会让只靠下一次 Codex 请求才更新的 rollout 观测把本机一直拦到周窗口重置。
 */
export function currentLimitFact(fact: LimitFact | undefined, eligible: boolean, windows: readonly { resetPassed: boolean }[]): LimitFact {
  if (!eligible || fact === undefined || fact === null) return null;
  return windows.some((w) => w.resetPassed) ? null : fact;
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
