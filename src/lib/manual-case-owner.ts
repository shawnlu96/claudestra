/**
 * Who answers for a manual episode, by when, and what happens next (merge-arch-OWN1), read side. A `manual_case_set` decision event
 * bound to the episode's entry seq carries an explicit PM setting (source explicit) or the scheduler's backfill of the defaults (source
 * default); a later explicit one wins, a default one never overrides an explicit one, and a new entry (new hold / episode) starts empty.
 * Without a record the defaults (manual-case-defaults.ts) are derived read-only. A responsible subject that is no longer valid is shown
 * as a gap and falls back to a valid PM; nothing here sends work to anyone. Who may *release* a hold never moves with the responsible.
 */
import { endStages, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import type { LedgerMeta } from "./ledger-store.js";
import { defaultOwner, manualCaseDefaults, REAL_CONFLICT_SUB, type ManualCaseDefaults, type ManualCaseRole, type SlaBasis } from "./manual-case-defaults.js";
import { filePolicyPort, type ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { manualEntry, parseManualReason, type ManualEntry, type ManualReasonCode } from "./manual-reason.js";
import type { RecoveryKey } from "./recovery-policy.js";

export const MANUAL_CASE_OP = "manual_case_set";
export const MANUAL_CASE_KEY: RecoveryKey = "manualCaseOwnership";
export const MANUAL_CASE_ROLES: readonly ManualCaseRole[] = ["pm", "owner", "executor"];
type MetaPart = Pick<LedgerMeta, "activePm" | "pms"> & { team?: LedgerMeta["team"] };

interface ManualCaseRecord {
  seq: number; ts: number; actor: string; source: "explicit" | "default"; entrySeq: number;
  responsible: string; role: ManualCaseRole; dueAt: number; next: string | null; waitingOn: string | null;
}

export interface ManualCaseOwner {
  role: ManualCaseRole; who: string | null; source: string;
  /** explicit = a PM set it; default_record = the scheduler's backfill; derived = read-only default, nothing recorded */
  origin: "explicit" | "default_record" | "derived";
  setSeq: number | null; next: string | null; waitingOn: string | null;
  /** who alone may release this kind of manual; unchanged by any responsible setting (null = the ordinary release path) */
  authorizer: string | null;
  /** what the responsible checks before anyone hands the card back, for holds / refusals / unknown results */
  check: string | null;
  gap: string | null;
}

/** Holds, refusals and unknown results: shown with their authorizer and a check step, never handed back by an assignment. */
const AUTHORITY: Partial<Record<ManualReasonCode, { by: string; check: string }>> = {
  owner_hold: { by: "owner", check: "PM 追踪 owner 拍板；只有 owner 明确放行后才交回" },
  safety_refusal: { by: "PM / owner", check: "核对拒绝内容并明确处置后 workflow-resume" },
  pm_hold: { by: "PM", check: "PM 核对后明确交回" },
  pm_takeover: { by: "PM", check: "PM 核对后明确交回" },
  foreign_repo: { by: "PM", check: "PM 按该仓库流程手动合并 / 部署" },
  merge_unknown: { by: "PM（凭外部结果）", check: "核对合并 / 部署的外部结果后再处置，结果未明前不交回" },
};
const UNKNOWN_AUTHORITY = { by: "PM", check: "旧 / 未知理由：PM 核对事件链与进入点，补记理由后再处置" };

const HEAD = /^\s*merge_bounce_limit\s*[:：]/;
const mergeIntent = (e: LedgerEvent): string | null =>
  e.kind === "scheduler" && typeof e.data.op === "string" && e.data.op.startsWith("merge_") && typeof e.data.intentId === "string" ? e.data.intentId : null;
/**
 * The sub-reason the SLA table reads, classified from structured evidence: a bounce-limit entry is a real conflict only when the merge
 * intent blocking the card (the latest merge intent before the entry, as the planner's cancelled intent) escalated with cause=conflict.
 * A hand-back without a new merge attempt keeps that intent, so a re-entry on the same real conflict stays 8h; a later attempt (CI /
 * update-branch bounce, or an unsent limit with no escalated merge_conflict) replaces it and stays the raw merge_bounce_limit (2h).
 * The view and the backfill both go through here, so they agree.
 */
function slaSub(entry: ManualEntry, events: readonly LedgerEvent[]): string | null {
  const d = entry.event.data;
  if (![entry.record?.text, d.reason, d.takeover, d.hold].some((x) => typeof x === "string" && HEAD.test(x))) return null;
  const before = events.filter((e) => e.seq < entry.event.seq);
  const intent = before.findLast((e) => mergeIntent(e) !== null);
  const esc = intent && before.findLast((e) => mergeIntent(e) === intent.data.intentId && e.data.op === "merge_conflict" && e.data.escalated === true);
  return esc && esc.data.cause === "conflict" ? REAL_CONFLICT_SUB : "merge_bounce_limit";
}

/**
 * A non-entry event inside a manual run that names its blocking reason in structured form: an escalated merge bounce (cause decides
 * real conflict vs the raw limit, as slaSub does), or an escalation whose reason carries a code head (parseManualReason's explicit codes;
 * a code-less sentence is never guessed at).
 */
function evidenceBasis(e: LedgerEvent): SlaBasis | null {
  if (e.kind === "scheduler" && e.data.op === "merge_conflict" && e.data.escalated === true)
    return { code: "merge_unknown", sub: e.data.cause === "conflict" ? REAL_CONFLICT_SUB : "merge_bounce_limit" };
  const p = e.kind === "escalate" ? parseManualReason(typeof e.data.reason === "string" ? e.data.reason : e.text) : null;
  return p?.explicit ? { code: p.code, sub: null } : null;
}

/**
 * The reason a pm_takeover took over: the latest classifiable one earlier in the same manual run (an evidence event, else the previous
 * entry's own code, walking back over nested takeovers / unknown entries), never past where the run began. A run that begins at the
 * takeover itself (auto → manual) has none, and the table's 4h stands. tests/manual-case-owner-takeover.test.ts.
 */
function takeoverBasis(entry: ManualEntry, events: readonly LedgerEvent[]): SlaBasis | null {
  for (let cut = entry.event.seq; ;) {
    const before = events.filter((e) => e.seq < cut);
    const prev = manualEntry(before);
    if (!prev) return null;
    const hit = before.findLast((e) => e.seq > prev.event.seq && evidenceBasis(e) !== null);
    if (hit) return evidenceBasis(hit);
    if (prev.code && prev.code !== "pm_takeover") return { code: prev.code, sub: slaSub(prev, events) };
    cut = prev.event.seq;
  }
}

/** The episode's defaults from its structured evidence; the view, the observe note and the backfill all read this one. */
const entryDefaults = (entry: ManualEntry, events: readonly LedgerEvent[], task: Pick<LedgerTask, "agent" | "pm">, meta: MetaPart) =>
  manualCaseDefaults(entry.code, entry.event.ts, task, meta, slaSub(entry, events), entry.code === "pm_takeover" ? takeoverBasis(entry, events) : null);

function asRecord(e: LedgerEvent): ManualCaseRecord | null {
  const d = e.data;
  if (e.kind !== "decision" || d.op !== MANUAL_CASE_OP || typeof d.entrySeq !== "number" || typeof d.responsible !== "string"
    || !MANUAL_CASE_ROLES.includes(d.role as ManualCaseRole) || typeof d.dueAt !== "number") return null;
  return { seq: e.seq, ts: e.ts, actor: e.actor, source: d.source === "explicit" ? "explicit" : "default", entrySeq: d.entrySeq, responsible: d.responsible,
    role: d.role as ManualCaseRole, dueAt: d.dueAt, next: typeof d.next === "string" ? d.next : null, waitingOn: typeof d.waitingOn === "string" ? d.waitingOn : null };
}

/** Records bound to this entry seq, oldest first. */
const manualCaseRecords = (events: readonly LedgerEvent[], entrySeq: number): ManualCaseRecord[] =>
  events.map(asRecord).filter((r): r is ManualCaseRecord => r !== null && r.entrySeq === entrySeq);

/** The record in force: the latest explicit one, else the first default backfill. */
function recordInForce(records: readonly ManualCaseRecord[]): ManualCaseRecord | null {
  return records.findLast((r) => r.source === "explicit") ?? records.find((r) => r.source === "default") ?? null;
}

/** A named subject still able to answer: a valid PM, owner, or the card's current executor. */
export function subjectValid(role: ManualCaseRole, who: string, task: Pick<LedgerTask, "agent">, meta: MetaPart): boolean {
  if (role === "owner") return who === "owner";
  if (role === "executor") return !!task.agent && who === task.agent;
  return meta.pms.includes(who) && who !== meta.team?.dispatcher;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The view's override: explicit / backfilled record over the derived defaults, with authority and gaps. With an entry the defaults are
 * re-derived from the episode's structured evidence (slaSub / takeoverBasis), the same classification the backfill records.
 */
export function manualCaseOwnership(viewDefaults: ManualCaseDefaults, task: Pick<LedgerTask, "agent" | "pm">, events: readonly LedgerEvent[],
  entry: ManualEntry | null, meta: MetaPart): { owner: ManualCaseOwner; due: ManualCaseDefaults["due"] } {
  const d = entry ? entryDefaults(entry, events, task, meta) : viewDefaults;
  const auth = entry?.code ? AUTHORITY[entry.code] ?? null : UNKNOWN_AUTHORITY;
  const base = { authorizer: auth?.by ?? null, check: auth?.check ?? null, waitingOn: null, next: null, setSeq: null };
  if (!entry) return { owner: { ...d.owner, ...base, origin: "derived", gap: null, source: `${d.owner.source}；进入点未知，只读推导，PM 核对` }, due: d.due };
  const rec = recordInForce(manualCaseRecords(events, entry.event.seq));
  if (!rec) return { owner: { ...d.owner, ...base, origin: "derived", gap: null, source: `${d.owner.source}（只读推导，未补记）` }, due: d.due };
  const by = rec.source === "explicit" ? `PM 显式设定 #${rec.seq}（${rec.actor}）` : `缺省补记 #${rec.seq}`;
  const valid = subjectValid(rec.role, rec.responsible, task, meta), fb = defaultOwner(task, meta);
  const owner: ManualCaseOwner = { ...base, origin: rec.source === "explicit" ? "explicit" : "default_record", setSeq: rec.seq, next: rec.next, waitingOn: rec.waitingOn,
    role: valid ? rec.role : fb.role, who: valid ? rec.responsible : fb.who,
    source: valid ? by : `${by} 指定的 ${rec.responsible}（${rec.role}）已失效，回落 ${fb.who}（${fb.from}）`,
    gap: valid ? null : `责任主体 ${rec.responsible}（${rec.role}）已失效：按 ${fb.from} 回落 ${fb.who}，不向原主体发单，PM 重新指派` };
  return { owner, due: { at: rec.dueAt, slaHours: d.due.slaHours, source: `${by}：${iso(rec.dueAt)}` } };
}

export type OwnershipMode = { mode: "on" | "observe" | "off"; why: string } | { mode: "error"; why: string };

/**
 * manualCaseOwnership switch: off = no backfill, observe (default) = record would-assign only, on = backfill. Only an explicit `on` under
 * keys turns it on (a project-wide on reads observe); off anywhere on the path is off; an unreadable policy is an error (nothing written).
 */
export function manualCaseOwnershipMode(project: string, port: ExplicitPolicyPort = filePolicyPort()): OwnershipMode {
  try {
    const got = port(project)(MANUAL_CASE_KEY);
    if (got.policy.source === "error") return { mode: "error", why: got.policy.diagnostic ?? "恢复策略不可用" };
    if (got.policy.mode === "off") return { mode: "off", why: `${MANUAL_CASE_KEY} 是 off` };
    return got.explicit === "on" && got.policy.mode === "on" ? { mode: "on", why: `${MANUAL_CASE_KEY} 显式 on` }
      : { mode: "observe", why: got.policy.mode === "on" ? `${MANUAL_CASE_KEY} 未显式 on（项目总档 on 不开），按 observe` : `${MANUAL_CASE_KEY} 是 observe` };
  } catch (e) { return { mode: "error", why: `读恢复策略失败：${(e as Error).message}` }; }
}

export interface PendingDefault { entrySeq: number; since: number; code: ManualReasonCode | null; role: ManualCaseRole; who: string; dueAt: number; slaHours: number; source: string }

/**
 * What a backfill would record for this card now: an active manual card with a formal entry and no record for that entry yet.
 * An old episode without an entry event is never given a made-up entry seq (it stays derived, the PM checks it).
 */
export function pendingDefault(task: LedgerTask, mode: string, events: readonly LedgerEvent[], meta: MetaPart):
  { ok: true; value: PendingDefault } | { ok: false; why: string } {
  if (mode !== "manual") return { ok: false, why: "卡不在 manual" };
  if (endStages(task.kind).includes(task.stage)) return { ok: false, why: `卡已到终态 ${task.stage}` };
  const entry = manualEntry(events);
  if (!entry) return { ok: false, why: "没有进入 manual 的正式事件：只读推导，不补记" };
  if (manualCaseRecords(events, entry.event.seq).length) return { ok: false, why: `段 #${entry.event.seq} 已有处置记录` };
  const d = entryDefaults(entry, events, task, meta);
  return { ok: true, value: { entrySeq: entry.event.seq, since: entry.event.ts, code: entry.code, role: d.owner.role, who: d.owner.who!,
    dueAt: d.due.at!, slaHours: d.due.slaHours, source: `${d.owner.source}；${d.due.source}` } };
}
