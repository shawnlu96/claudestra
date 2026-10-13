/**
 * Convergence stall (dispatch-recovery-CONVREPO1, recovery key convergenceStall): a fix_swap / arbitrate intent whose
 * `ledger scheduler-convergence` keeps failing used to stay pending for hours with no record and no notice. Failures are counted
 * here per ledger, per card and per intent base (the `:a<n>` attempt suffix stripped, so a re-planned attempt keeps the count),
 * like the refused-plan counts in scheduler-auto-tick.ts. A restart clears them: the alarm comes at most STALL_MS later.
 * Pure memory and text: the settle / fallback / notice effects stay in fix-strategy-tick.ts. tests/fix-strategy-stall.test.ts.
 */
import type { Database } from "bun:sqlite";

/** Same count as PLAN_REJECT_TICKS; the time floor keeps a few fast passes over one transient error from escalating. */
const STALL_TICKS = 3;
const STALL_MS = 10 * 60_000;

interface Stall { ticks: number; since: number; told: boolean; error: string }
const stalls = new WeakMap<Database, Map<string, Stall>>();
const perDb = (db: Database): Map<string, Stall> => stalls.get(db) ?? stalls.set(db, new Map()).get(db)!;

export const stallKey = (taskId: string, intentId: string): string => `${taskId}\n${intentId.replace(/:a\d+$/, "")}`;

/** Codes that are not a stall: too_large has its own one-time alarm, lease-lost is this service stopping. */
export const uncounted = (code: unknown): boolean => code === "too_large" || code === "lease-lost";

/** An ok convergence result (waiting / pooled / session …) starts the count over. */
export function stallCleared(db: Database, key: string): void {
  stalls.get(db)?.delete(key);
}

/** One more failure; returns the stall once it is past both thresholds (ticks and elapsed time), else null. */
export function stallFailed(db: Database, key: string, error: unknown, now: number): Readonly<Stall> | null {
  const seen = perDb(db), was = seen.get(key);
  const firstLine = String(error ?? "").split("\n")[0].trim().slice(0, 200);
  const s: Stall = was ? { ...was, ticks: was.ticks + 1, error: firstLine } : { ticks: 1, since: now, told: false, error: firstLine };
  seen.set(key, s);
  return s.ticks >= STALL_TICKS && now - s.since >= STALL_MS ? s : null;
}

/** observe tells PM once per base key: the mark lives until an ok result or a restart clears the count. */
export function stallTold(db: Database, key: string): void {
  const s = stalls.get(db)?.get(key);
  if (s) s.told = true;
}

export interface StallFacts { taskId: string; intentId: string; action: string; ticks: number; minutes: number; error: string }

export function stallFacts(taskId: string, intent: { id: string; action: string }, s: Readonly<Stall>, now: number): StallFacts {
  return { taskId, intentId: intent.id, action: intent.action, ticks: s.ticks, minutes: Math.floor((now - s.since) / 60_000), error: s.error };
}

const NEXT = "PM 核对后手派修复单（lend-offer 写租约方）或修好后 workflow-resume";
const body = (f: StallFacts, state: string): string =>
  `收敛意图 ${f.intentId}（${f.action}）连续 ${f.ticks} 次执行失败（${f.minutes} 分钟）：${f.error}。${state}`;
const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/** The fallback reason: an explicit manual code (PM decides when it goes back), ≤ 600 characters as fallbackToManual requires. */
export const stallReason = (f: StallFacts, unknown: boolean): string =>
  oneLine(`pm_takeover: ${body(f, unknown ? "意图记为 unknown 待对账" : "意图已取消")}；${NEXT}`, 600);

export const stallSettleReceipt = (f: StallFacts): string => oneLine(`收敛执行连续 ${f.ticks} 次失败，退回人工前记为 unknown：${f.error}`, 560);

export const stallNotice = (f: StallFacts, unknown: boolean): string =>
  `[调度引擎] ${f.taskId} 退回人工：${body(f, unknown ? "意图记为 unknown 待对账" : "意图已取消")}；${NEXT}`;

export const stallObserveNotice = (f: StallFacts, status: string): string =>
  `[调度引擎] ${f.taskId} 本会退回人工（observe）：${body(f, `意图仍是 ${status}，未动`)}；${NEXT}`;
