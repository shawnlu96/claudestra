/**
 * Default owner and response deadline of one manual episode (merge-arch-VIEW1 table, made formal by OWN1). Pure: who answers for the
 * card next and by when, from the MAN1 reason code (plus the merge_unknown sub-reason / a takeover's basis), each value with its source.
 * Owner chain: the card's valid PM → the project's valid on-duty PM → owner; an executor is only ever named explicitly (OWN1 PM 定 3).
 * The SLA is a response deadline from the episode's entry, never refreshed by a later note, and never lifts anything (PM 定 4/5).
 * An unknown entry time stays unknown (no due date is invented). Explicit records sit on top: manual-case-owner.ts. tests/manual-case-*.test.ts.
 */
import type { LedgerTask } from "./ledger-stages.js";
import type { LedgerMeta } from "./ledger-store.js";
import type { ManualReasonCode } from "./manual-reason.js";

export type ManualCaseRole = "pm" | "owner" | "executor";
type MetaPart = Pick<LedgerMeta, "activePm" | "pms"> & { team?: LedgerMeta["team"] };

/**
 * Hours per reason: UI / CI / result check 2, lease / runtime / source / materials / spec 4, review fix / real conflict 8, holds 24.
 * pm_takeover is not a hold: it answers at the tier of the reason it took over (SlaBasis), 4h when none is known.
 */
export const MANUAL_CASE_SLA_BY_CODE: Readonly<Record<ManualReasonCode, number>> = {
  safety_refusal: 2, ui_evidence_stale: 2, merge_unknown: 2,
  write_lease_ended: 4, runtime_unavailable: 4, review_source_missing: 4, materials_gate: 4, spec_drift: 4, questionnaire: 4, start_rollback: 4,
  pm_takeover: 4,
  review_unresolved: 8,
  owner_hold: 24, pm_hold: 24, foreign_repo: 24, deps_not_live: 24,
};
/** The classified reason a pm_takeover took over (manual-case-owner.ts finds it inside the same manual run). */
export interface SlaBasis { code: ManualReasonCode; sub: string | null }
/**
 * A bounce-limit merge_unknown whose escalating bounce is, by its structured merge_conflict.cause, a real conflict: 8h. The raw sub-reason
 * merge_bounce_limit alone also covers CI failures / update failures / unsent limits, which keep merge_unknown's 2h (manual-case-owner.ts
 * classifies the episode and passes this tag).
 */
export const REAL_CONFLICT_SUB = "merge_bounce_limit:conflict";
const REAL_CONFLICT_HOURS = 8;
/** Per role, for an episode whose reason is unknown (old / unrecognised entries): 24h, the hold bucket. */
export const MANUAL_CASE_SLA_HOURS: Readonly<Record<ManualCaseRole, number>> = { pm: 24, executor: 24, owner: 24 };

export interface ManualCaseDefaults {
  owner: { role: ManualCaseRole; who: string | null; source: string };
  due: { at: number | null; slaHours: number; source: string };
}

/** PMs who may answer for a card: on the project's list and not the dispatcher assistant. */
const validPms = (meta: MetaPart): string[] => meta.pms.filter((p) => p !== meta.team?.dispatcher);

/** The chain without the card's own PM: on-duty PM if still valid, else the first valid PM, else owner. */
function projectFallback(meta: MetaPart): { role: ManualCaseRole; who: string; from: string } {
  const valid = validPms(meta);
  if (meta.activePm && valid.includes(meta.activePm)) return { role: "pm", who: meta.activePm, from: "项目当班 PM" };
  if (valid[0]) return { role: "pm", who: valid[0], from: "项目 PM 名单第一位有效 PM" };
  return { role: "owner", who: "owner", from: "项目没有有效 PM，回落 owner" };
}

export function defaultOwner(task: Pick<LedgerTask, "pm">, meta: MetaPart): { role: ManualCaseRole; who: string; from: string } {
  if (task.pm && validPms(meta).includes(task.pm)) return { role: "pm", who: task.pm, from: "卡的 PM" };
  const f = projectFallback(meta);
  return task.pm ? { ...f, from: `卡的 PM ${task.pm} 已不是有效 PM，${f.from}` } : f;
}

function manualCaseSlaHours(code: ManualReasonCode | null, sub: string | null = null, basis: SlaBasis | null = null): number {
  if (!code) return MANUAL_CASE_SLA_HOURS.pm;
  if (code === "pm_takeover" && basis && basis.code !== "pm_takeover") return manualCaseSlaHours(basis.code, basis.sub);
  return code === "merge_unknown" && sub === REAL_CONFLICT_SUB ? REAL_CONFLICT_HOURS : MANUAL_CASE_SLA_BY_CODE[code];
}

/**
 * since = the episode's entry time (null = unknown: no entry event, never the card's updatedAt). sub = the (classified) sub-reason if known.
 * basis = for a pm_takeover, the reason it took over; it only moves the hours, the texts still name the entry's own code.
 */
export function manualCaseDefaults(code: ManualReasonCode | null, since: number | null, task: Pick<LedgerTask, "agent" | "pm">,
  meta: MetaPart, sub: string | null = null, basis: SlaBasis | null = null): ManualCaseDefaults {
  const { role, who, from } = defaultOwner(task, meta);
  const slaHours = manualCaseSlaHours(code, sub, basis);
  const why = code ? `理由码 ${code}${code === "merge_unknown" && sub?.startsWith("merge_bounce_limit") ? `/${sub}` : ""}` : "理由未知，PM 核对";
  return {
    owner: { role, who, source: `缺省：${why} → ${role}（${from}）` },
    due: since === null ? { at: null, slaHours, source: "进入时间未知，不起算期限" }
      : { at: since + slaHours * 3_600_000, slaHours, source: `缺省 SLA：${why} 响应 ${slaHours} 小时，从进入 manual 起算` },
  };
}
