/**
 * 上线后提醒的观察期（agents-PVDEFER1）：规格 `## 上线后 PM` 一节正文第一行整行写「观察期：N 小时」（N ≥ 1 整数，超过 168 按 168 算）时，
 * 按项目开关 autostart.postVerifyDefer（缺省 observe）决定提醒时机；只管「何时提醒」，发不发仍由 specWait 决定。
 * - off：现在的行为，不解析、不加说明。
 * - observe：时机照旧；到点（最近一次进 verified + N 小时）前写的 remind 正文末尾注明开关 on 时本该何时才提醒。
 * - on：到点前调度侧不调台账、不写、不发；到点后照旧每 30 分钟一条，超时分界改为距到点超过 72 小时。
 * 第一行含「观察期」却不整行匹配 = 格式没认出：时机照旧，正文末尾加说明（off 除外）。
 * 纯函数加一个只读开关的 postVerifyDeferMode；调度侧（scheduler-post-verify.ts）与台账 writer（scheduler-post-verify-ledger.ts）读同一份规格与开关各算一遍。
 * tests/scheduler-post-verify-defer.test.ts。
 */
import type { Database } from "bun:sqlite";
import { localTime } from "./ledger-audit-lend-grant.js";
import { readSwitch } from "./scheduler-autostart.js";

const POST_VERIFY_DEFER_MAX_HOURS = 168;
const HOUR_MS = 3600_000;
const OBSERVATION_RE = /^观察期\s*[:：]\s*(\d+)\s*小时$/;
const BAD_NOTE = "（本节第一行的观察期格式没认出，照常提醒；只认「观察期：N 小时」，N 为 1 以上整数）";

export type PostVerifyDeferMode = "on" | "observe" | "off";
export interface Observation { hours: number; capped: boolean }

/** 项目级开关 autostart.postVerifyDefer，缺省 observe */
export const postVerifyDeferMode = (db: Database, project: string): PostVerifyDeferMode => readSwitch(db, project).postVerifyDefer ?? "observe";

/** written：规格里写的原数（封顶前），只用于说明文字 */
function observe(section: string | null | undefined): (Observation & { written: string }) | "bad" | null {
  if (!section) return null;
  const line = section.split(/\r?\n/)[0].trim();
  if (!line.includes("观察期")) return null;
  const m = OBSERVATION_RE.exec(line);
  const n = m ? Number(m[1]) : 0;
  if (!(n >= 1)) return "bad";
  return { hours: Math.min(n, POST_VERIFY_DEFER_MAX_HOURS), capped: n > POST_VERIFY_DEFER_MAX_HOURS, written: m![1] };
}

/** 该节第一行的观察期：认出 → { hours（已封顶）, capped }；含「观察期」但格式不对 → "bad"；第一行没写 → null */
export function parseObservation(section: string | null | undefined): Observation | "bad" | null {
  const o = observe(section);
  return o === null || o === "bad" ? o : { hours: o.hours, capped: o.capped };
}

export interface DeferPlan {
  /** on 档认出的观察期小时数：超时分界与超时正文按它算；其余档不设 = 照旧从 verified 算 */
  hours?: number;
  /** on 档到点前：不调台账、不写、不发 */
  hold: boolean;
  /** 正文末尾的说明行 */
  remindNote?: string;
  overdueNote?: string;
}

/** 按模式、该节与最近一次进 verified 的时间算这一刻的时机与说明 */
export function deferPlan(mode: PostVerifyDeferMode, section: string, verifiedTs: number, now: number): DeferPlan {
  if (mode === "off") return { hold: false };
  const o = observe(section);
  if (o === null) return { hold: false };
  if (o === "bad") return { hold: false, remindNote: BAD_NOTE, overdueNote: BAD_NOTE };
  const until = verifiedTs + o.hours * HOUR_MS;
  if (mode === "on") return { hours: o.hours, hold: now < until };
  if (now >= until) return { hold: false };
  const cap = o.capped ? `；超过 ${POST_VERIFY_DEFER_MAX_HOURS} 小时按 ${POST_VERIFY_DEFER_MAX_HOURS} 小时算` : "";
  return { hold: false, remindNote: `（观察期开关 observe：规格写了观察期 ${o.written} 小时，开关 on 时本该在 ${localTime(until)} 之后才提醒${cap}）` };
}
