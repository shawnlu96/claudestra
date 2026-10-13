/**
 * Default owner and deadline of one manual episode (merge-arch-VIEW1). Pure: who should move the card next and by when, derived
 * from the MAN1 reason code alone, each value with the source it came from. No event records an owner / due date yet; OWN1 adds an
 * explicit override on top of this function, so the view must call it rather than inline the table.
 * An unknown code or an unknown entry time stays unknown (PM checks; no due date is invented). tests/manual-case-view*.test.ts.
 */
import type { LedgerTask } from "./ledger-stages.js";
import type { LedgerMeta } from "./ledger-store.js";
import type { ManualReasonCode } from "./manual-reason.js";

export type ManualCaseRole = "pm" | "owner" | "executor";

const ROLE_BY_CODE: Readonly<Record<ManualReasonCode, ManualCaseRole>> = {
  safety_refusal: "pm", ui_evidence_stale: "executor", merge_unknown: "pm", write_lease_ended: "pm", deps_not_live: "pm", materials_gate: "pm",
  questionnaire: "pm", review_unresolved: "executor", review_source_missing: "pm", runtime_unavailable: "pm", spec_drift: "pm", owner_hold: "owner",
  start_rollback: "pm", pm_hold: "pm", pm_takeover: "pm", foreign_repo: "pm",
};

/** Default SLA per role, hours from the episode's entry. */
export const MANUAL_CASE_SLA_HOURS: Readonly<Record<ManualCaseRole, number>> = { pm: 24, executor: 24, owner: 72 };

export interface ManualCaseDefaults {
  owner: { role: ManualCaseRole; who: string | null; source: string };
  due: { at: number | null; slaHours: number; source: string };
}

function whoFor(role: ManualCaseRole, task: Pick<LedgerTask, "agent" | "pm">, meta: Pick<LedgerMeta, "activePm" | "pms">): { who: string | null; from: string } {
  if (role === "owner") return { who: "owner", from: "owner" };
  if (role === "executor") return task.agent ? { who: task.agent, from: "卡的执行者" } : { who: null, from: "卡没有执行者" };
  if (task.pm) return { who: task.pm, from: "卡的 PM" };
  if (meta.activePm) return { who: meta.activePm, from: "项目当班 PM" };
  return meta.pms[0] ? { who: meta.pms[0], from: "项目 PM 名单第一位" } : { who: null, from: "项目没有 PM" };
}

/** since = the episode's entry time (null = unknown: no entry event, never the card's updatedAt). */
export function manualCaseDefaults(code: ManualReasonCode | null, since: number | null, task: Pick<LedgerTask, "agent" | "pm">,
  meta: Pick<LedgerMeta, "activePm" | "pms">): ManualCaseDefaults {
  const role: ManualCaseRole = code ? ROLE_BY_CODE[code] : "pm";
  const { who, from } = whoFor(role, task, meta);
  const slaHours = MANUAL_CASE_SLA_HOURS[role];
  return {
    owner: { role, who, source: `缺省：${code ? `理由码 ${code}` : "理由未知，PM 核对"} → ${role}（${from}）` },
    due: since === null ? { at: null, slaHours, source: "进入时间未知，不起算期限" }
      : { at: since + slaHours * 3_600_000, slaHours, source: `缺省 SLA：${role} ${slaHours} 小时，从进入 manual 起算` },
  };
}
