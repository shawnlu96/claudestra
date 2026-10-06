/**
 * 出借方分家族额度线（QLINE1，owner 决定 42733）：本机某族本周已用 >= 停接线 → 这族报给借入方的容量降到 0、claim 前末刻同样不领；
 * 提醒线 <= 已用 < 停接线 → 缩减（监工 06:44 UTC 批准的缩法，回复 42895）：原 0 仍 0，否则 min(原值, max(1, floor(原值 / 2)))。
 * 只在已有的有效容量上再收窄：输入就是 QP1 / 手动暂停 / 过期 / Claude 登录等都算过之后的数，这里只会取更小，永远不放大；
 * busy 照实报、在跑的单不动（不撤单、不标失败、不 kill）；每族各算各的。周窗口一重置（resetAt 过了、读到新窗口）自动恢复。
 * 用量 unknown（读不到、本代窗口没读数、已过重置）= 这条规则不收窄，交回 QP1 原有的未知处理；模式 observe 只报告、off 不收窄。
 * 配置在 lend-quota-line-config.ts，事实在 lend-quota-line-facts.ts；接线：lend-hello.ts helloBody、lend-drive.ts claimProblem。
 * tests/lend-quota-line.test.ts、tests/lend-quota-line-wiring.test.ts。
 */
import { readQuotaLinesSync, type FamilyLine, type QuotaLineMode, type QuotaLinesRead } from "./lend-quota-line-config.js";
import { factsNow, liveFact, type FactSource, type QuotaFact, type QuotaFacts } from "./lend-quota-line-facts.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";

export type LineState = "below" | "warn" | "stop" | "unknown";
/** none = 不收窄；half = 提醒区间的缩法（warnSlots）；zero = 停接 */
export type LineLimit = "none" | "half" | "zero";

/** 提醒区间的缩法（已批准）：原 0 仍 0，正数减半向下取整、至少留 1，不超过原值；0/1/2/3/4/5 → 0/1/1/1/2/2 */
export const warnSlots = (granted: number): number => (granted <= 0 ? 0 : Math.min(granted, Math.max(1, Math.floor(granted / 2))));

/** 已用对两条线：边界 >=（正好 80 就停、正好 70 就提醒）；没有可用读数 = unknown */
export function lineStateOf(used: number | null, line: FamilyLine): LineState {
  if (used === null) return "unknown";
  if (used >= line.stopPct) return "stop";
  if (used >= line.warnPct) return "warn";
  return "below";
}

/** 这一状态在 on 模式下会怎么收窄（observe / off 也照算，供展示） */
function wouldLimit(state: LineState): LineLimit {
  if (state === "stop") return "zero";
  if (state === "warn") return "half";
  return "none";
}

export const limitFor = (state: LineState, mode: QuotaLineMode): LineLimit => (mode === "on" ? wouldLimit(state) : "none");

/** 在已有有效容量上收窄：只会变小或不变 */
export function capSlots(limit: LineLimit, granted: number): number {
  const g = Math.max(0, Math.floor(granted));
  if (limit === "zero") return 0;
  if (limit === "half") return warnSlots(g);
  return g;
}

export interface LineInputs { lines: QuotaLinesRead; facts: QuotaFacts }

/**
 * fresh = 来源是实时（live）或本机缓存（local_cache）、且真实观测时刻在 FRESH_MS 内；live_stale（订阅接口失败后的上次快照）
 * 或观测更早的 = last_known：照样参与判定（同一周窗口内的上次读数），网页如实标出，不冒充刚读到的。
 */
const FRESH_MS = 15 * 60_000;
type Freshness = "fresh" | "last_known";
const freshnessOf = (f: QuotaFact, now: number): Freshness =>
  (f.source !== "live_stale" && now - f.observedAt <= FRESH_MS ? "fresh" : "last_known");

/** 给网页 / QWARN 的一族视图（脱敏：只有百分比、时刻、阈值、状态） */
export interface FamilyLineView {
  family: LendFamily; warnPct: number; stopPct: number; weekUsedPct: number | null; resetAt: number | null;
  /** 这份读数的真实观测时刻与来源；unknown 时为 null */
  observedAt: number | null; source: FactSource | null;
  freshness: Freshness | null;
  state: LineState; mode: QuotaLineMode; limit: LineLimit; wouldLimit: LineLimit;
}

export function familyLine(family: LendFamily, inp: LineInputs, now: number): FamilyLineView {
  const line = inp.lines.file.families[family];
  const fact = liveFact(inp.facts[family], now);
  const state = lineStateOf(fact ? fact.weekUsedPct : null, line);
  const mode = inp.lines.file.mode;
  return { family, warnPct: line.warnPct, stopPct: line.stopPct, weekUsedPct: fact?.weekUsedPct ?? null, resetAt: fact?.resetAt ?? null,
    observedAt: fact?.observedAt ?? null, source: fact?.source ?? null, freshness: fact ? freshnessOf(fact, now) : null,
    state, mode, limit: limitFor(state, mode), wouldLimit: wouldLimit(state) };
}

/** 此刻的配置与事实：每次现读（配置文件小，claim / hello 的节奏是几十秒一次） */
const currentLineInputs = (now = Date.now()): LineInputs => ({ lines: readQuotaLinesSync(), facts: factsNow(now) });

const isFamily = (f: string): f is LendFamily => (LEND_FAMILIES as readonly string[]).includes(f);

/** claim 前末刻：这族在已有容量 slots 上还能给几个；不认识的家族原样返回（由原有规则判） */
export function lendQuotaLineCap(family: string, slots: number, now = Date.now(), inp: LineInputs = currentLineInputs(now)): number {
  if (!isFamily(family)) return slots;
  return capSlots(familyLine(family, inp, now).limit, slots);
}

/** hello 的 slots：每族 total 按额度线收窄，busy 照实报 */
export function lendQuotaLineSlots<T extends Record<LendFamily, { total: number; busy: number }>>(slots: T, now = Date.now(), inp?: LineInputs): T {
  const i = inp ?? currentLineInputs(now);
  const out = { ...slots };
  for (const f of LEND_FAMILIES) out[f] = { ...slots[f], total: lendQuotaLineCap(f, slots[f].total, now, i) };
  return out;
}
