/**
 * Manual reasons (dispatch-recovery-MAN1): every entry into workflow manual carries a structured reason code, the blocking fact /
 * event it stands on and the condition that lifts it. A missing or unrecognised reason refuses the manual write; manual is never an
 * approval of anything. The text form rides the existing `--reason`: `<code>: 说明[；解除：…][；事件：#seq]`; an older free-text
 * reason is accepted only when the keyword table below recognises it.
 * The read side is diagnosis only: the patrol (ledger-audit.ts) alarms an old manual without a usable reason and, in observe, reports
 * once per state version that a card's release condition looks met ("would resume"). Nothing here hands a card back, plans,
 * dispatches, merges or touches capacity: real recovery is MAN2, and a safety refusal or an owner / PM hold is never liftable here.
 * tests/manual-reason*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask, LedgerEvent } from "./ledger-stages.js";
import { TERMINAL_STAGES } from "./ledger-stages.js";
import { LedgerError, listEvents } from "./ledger-store.js";

/** Table order is the legacy-text match order: the narrower words come first. */
export const MANUAL_REASON_CODES = [
  "safety_refusal", "ui_evidence_stale", "merge_unknown", "write_lease_ended", "deps_not_live", "materials_gate", "questionnaire",
  "review_unresolved", "review_source_missing", "runtime_unavailable", "spec_drift", "owner_hold", "start_rollback", "pm_hold", "pm_takeover",
] as const;
export type ManualReasonCode = (typeof MANUAL_REASON_CODES)[number];

interface CodeSpec {
  label: string;
  /** what has to become true before the card may leave manual */
  release: string;
  /** the formal node / command that lifts it */
  node: string;
  /** a person decides; no recovery mechanism may ever lift it */
  sticky: boolean;
  /** legacy free-text recognition (the existing callers' fixed sentences), tried in table order */
  words: RegExp;
}

const MANUAL_REASONS: Record<ManualReasonCode, CodeSpec> = {
  safety_refusal: { label: "安全拒绝", release: "PM / owner 核对拒绝内容并明确处置", node: "PM 处置后 workflow-resume", sticky: true,
    words: /安全拒绝|safety|拒答|模型拒绝|provider ?拒绝|refus/i },
  ui_evidence_stale: { label: "UI 证据失效", release: "按当前 head 重截图并验收", node: "UI 截图验收", sticky: false, words: /UI ?证据|截图|screenshot/i },
  merge_unknown: { label: "merge 结果未知", release: "scheduler-merge-resolve 凭外部回执结清", node: "ledger scheduler-merge-resolve", sticky: false,
    words: /合并结果|部署结果|结果不明|merge.*(unknown|未知)|merge_retry|合并意图|仓库方|交接|合并队列外/i },
  write_lease_ended: { label: "写租约结束", release: "写租约重新授予或本机接回", node: "lend-reclaim / 重新放置", sticky: false, words: /租约|lease|池单/i },
  deps_not_live: { label: "依赖未上线", release: "前置任务已上线（live / done，不是 planned 或只 CI 绿）", node: "前置上线", sticky: false,
    words: /依赖|前置|\bdeps?\b/i },
  materials_gate: { label: "材料闸", release: "外发材料修正并重新过闸", node: "材料闸复核", sticky: false, words: /材料闸|外发闸|材料|materials|文件范围/i },
  questionnaire: { label: "问卷", release: "问卷答复齐全并入账", node: "问卷答复", sticky: false, words: /问卷|questionnaire/i },
  review_source_missing: { label: "派审来源缺失", release: "本轮派审回执 / 审查来源补齐", node: "审查派单回执", sticky: false,
    words: /派审|审查来源|来源缺失|review.?source|审查 ?(worktree|目录|session)|审查员|复验/i },
  review_unresolved: { label: "审查 / 检查未过", release: "按审查结论修复并重新审查通过", node: "fix → review", sticky: false,
    words: /\bP[01]\b|轮次已?到顶|审查阻塞|检查单/i },
  owner_hold: { label: "owner hold", release: "owner 明确放行", node: "owner 拍板", sticky: true, words: /owner/i },
  runtime_unavailable: { label: "执行环境不可用", release: "执行者 / 会话 / 运行时恢复可用", node: "PM 指定执行者", sticky: false,
    words: /委托|委派|runtime|会话|session|家族|\bPi\b|registry|工作目录|撞额度|登录失效|回合失败|监护|归不到派单/i },
  spec_drift: { label: "规格 / PR 漂移", release: "按当前规格 / PR 重新核对", node: "PM 核对规格后 workflow-resume", sticky: false,
    words: /规格|复述|PR ?#|\bbase\b|跨仓/i },
  start_rollback: { label: "开卡回滚", release: "重新开卡流程", node: "start_node / autostart", sticky: false, words: /回滚|rollback/i },
  pm_hold: { label: "PM hold", release: "PM 明确交回", node: "PM workflow-resume", sticky: true, words: /暂停|留人工|\bhold\b|pause|handoff/i },
  pm_takeover: { label: "PM 接管", release: "PM 核对后明确交回", node: "PM workflow-resume", sticky: true, words: /接管|接手|核对|takeover|人工|\bPM\b/i },
};

/** The planner's escalation codes (`<code>：<reason>`, scheduler-plan.ts / review-converge-notice.ts): a fixed, verified mapping. */
const PLAN_CODES: Readonly<Record<string, ManualReasonCode>> = {
  model_safety_hold: "safety_refusal", model_recovery_manual: "safety_refusal",
  merge_review_missing: "review_source_missing", merge_review_unproven: "review_source_missing", review_unsolicited: "review_source_missing",
  reviewer_mismatch: "review_source_missing", reviewer_replaced: "review_source_missing", reviewer_independence: "review_source_missing",
  review_invalid: "review_source_missing", review_history: "review_source_missing",
  review_block: "review_unresolved", review_inconsistent: "review_unresolved", merge_review_changes: "review_unresolved",
  three_p1_rounds: "review_unresolved", review_round_cap: "review_unresolved", fix_report: "review_unresolved", fix_history: "review_unresolved",
  verify_failed: "review_unresolved",
  merge_retry_requires_pm: "merge_unknown", merge_bounce_limit: "merge_unknown",
  ui_missing_screenshots: "ui_evidence_stale", ui_stale: "ui_evidence_stale", ui_rejected: "ui_evidence_stale", ui_unverified: "ui_evidence_stale",
  merge_ui_unapproved: "ui_evidence_stale",
  placement_lease: "write_lease_ended", pool_order_open: "write_lease_ended",
  file_scope: "materials_gate", resource_name: "materials_gate", worker_slot_invalid: "materials_gate",
  session_mismatch: "runtime_unavailable", author_family: "runtime_unavailable",
  workflow_drift: "spec_drift", restate_missing: "spec_drift", spec_missing: "spec_drift", task_origin: "spec_drift", stage_unknown: "spec_drift",
};

export const isManualReasonCode = (v: string): v is ManualReasonCode => (MANUAL_REASON_CODES as readonly string[]).includes(v);

export interface ParsedReason { code: ManualReasonCode; text: string; release: string | null; eventSeq: number | null; explicit: boolean }

/**
 * `<code>: 说明[；解除：…][；事件：#seq]` with a manual code or a planner escalation code; otherwise the whole line through the
 * keyword table (the existing callers' fixed sentences). null = missing / not recognised.
 */
export function parseManualReason(raw: string | undefined | null): ParsedReason | null {
  const line = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  const head = /^([a-z0-9_]+)\s*[:：]\s*(.*)$/.exec(line);
  const parts = (head ? head[2] : line).split(/[；;]\s*/);
  const field = (re: RegExp) => parts.map((p) => re.exec(p)?.[1]?.trim()).find(Boolean) ?? null;
  const release = field(/^(?:解除|release)\s*[:：]\s*(.+)$/i);
  const ev = field(/^(?:事件|event)\s*[:：]\s*#?(\d+)$/i);
  const text = parts.filter((p) => !/^(?:解除|release|事件|event)\s*[:：]/i.test(p)).join("；").trim();
  const eventSeq = ev ? Number(ev) : null;
  if (head && isManualReasonCode(head[1])) return text ? { code: head[1], text, release, eventSeq, explicit: true } : null;
  if (head && PLAN_CODES[head[1]] && text) return { code: PLAN_CODES[head[1]], text: line, release, eventSeq, explicit: true };
  const code = MANUAL_REASON_CODES.find((c) => MANUAL_REASONS[c].words.test(line));
  return code ? { code, text: line, release, eventSeq, explicit: false } : null;
}

export interface ManualReasonRecord {
  v: 1;
  code: ManualReasonCode;
  label: string;
  text: string;
  /** the fact the manual stands on: a referenced event, else the card's last event before this write */
  blocking: { seq: number; kind: string; op: string | null; text: string } | null;
  release: string;
  node: string;
  /** a manual entry is never an approval (of a merge, a review, a resume) */
  approval: false;
  /** card state at entry: a later drift voids any would-resume diagnosis */
  specRev: number;
  head: string | null;
  uiDigest: string | null;
}

const usage = () => `用「<理由码>: 说明[；解除：…][；事件：#seq]」，理由码：${MANUAL_REASON_CODES.join(" / ")}`;

/**
 * Build the record inside the caller's write transaction; throws invalid for a missing / unrecognised reason or an event reference
 * that is not on this card. `events` defaults to the card's events read from the same db.
 */
export function manualReasonRecord(db: Database, task: LedgerTask, reason: string | undefined, events?: readonly LedgerEvent[]): ManualReasonRecord {
  if (!reason?.trim()) throw new LedgerError("invalid", `进入 manual 要带理由（--reason），manual 不是批准；${usage()}`);
  const p = parseManualReason(reason);
  if (!p) throw new LedgerError("invalid", `manual 理由不认识，拒绝写入：${reason.slice(0, 120)}；${usage()}`);
  const own = events ?? listEvents(db, { project: task.project, target: task.id });
  const ref = p.eventSeq === null ? own.at(-1) : own.find((e) => e.seq === p.eventSeq);
  if (p.eventSeq !== null && !ref) throw new LedgerError("invalid", `理由引用的事件 #${p.eventSeq} 不在 ${task.id} 上`);
  const spec = MANUAL_REASONS[p.code];
  return {
    v: 1, code: p.code, label: spec.label, text: p.text.slice(0, 400),
    blocking: ref ? { seq: ref.seq, kind: ref.kind, op: typeof ref.data.op === "string" ? ref.data.op : null, text: ref.text.replace(/\s+/g, " ").slice(0, 200) } : null,
    release: (p.release ?? spec.release).slice(0, 200), node: spec.node, approval: false,
    specRev: task.specRev, head: task.headSHA ?? null, uiDigest: typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null,
  };
}

// ── read side (pure) ──

const MODE_OPS = new Set(["workflow", "fallback_manual", "workflow_resume", "merge_resolve", "deploy_resolve"]);

export interface ManualEntry {
  event: LedgerEvent;
  /** recorded at write time (MAN1+) */
  record: ManualReasonRecord | null;
  /** what the entry says, structured or recognised from legacy text; null = no usable reason */
  code: ManualReasonCode | null;
  text: string;
}

const legacyText = (e: LedgerEvent): string =>
  String(e.data.takeover ?? e.data.hold ?? e.data.reason ?? e.data.receipt ?? "").replace(/\s+/g, " ").trim();

/**
 * The event that put the card into its current manual, or null when the card is not manual or was manual from the start (a card
 * PM runs by hand never entered manual from automation).
 */
export function manualEntry(events: readonly LedgerEvent[]): ManualEntry | null {
  let mode: string | null = null, entry: LedgerEvent | null = null;
  for (const e of events) {
    if (e.kind !== "scheduler" || !MODE_OPS.has(String(e.data.op))) continue;
    const op = String(e.data.op);
    let next: string | null = mode;
    if (op === "workflow") next = String(e.data.mode);
    else if (op === "fallback_manual") next = "manual";
    else if (op === "workflow_resume") next = "auto";
    else if ((e.data.outcome === "failed" || e.data.outcome === "cancelled") && mode === "auto") next = "manual";
    else continue;
    const entering = next === "manual" && mode !== null && (mode !== "manual" || (op === "workflow" && !!e.data.hold));
    if (entering) entry = e;
    else if (next !== "manual") entry = null;
    mode = next;
  }
  if (mode !== "manual" || !entry) return null;
  const record = (entry.data.manualReason ?? null) as ManualReasonRecord | null;
  if (record && isManualReasonCode(record.code)) return { event: entry, record, code: record.code, text: record.text };
  const text = legacyText(entry);
  const op = String(entry.data.op);
  const code = op === "merge_resolve" || op === "deploy_resolve" ? "merge_unknown" : parseManualReason(text)?.code ?? null;
  return { event: entry, record: null, code, text };
}

/** Read-only facts the would-resume check may use; a source missing (null / undefined) is a gap, never a pass. */
export interface ManualFactsIn {
  task: LedgerTask;
  events: readonly LedgerEvent[];
  blockedBy?: readonly string[];
  /** task ids with a merge / deploy journal still unknown; undefined = not read this round */
  mergeUnknown?: readonly string[];
}

export interface ManualDiagnosis {
  taskId: string;
  entrySeq: number;
  code: ManualReasonCode | null;
  label: string;
  text: string;
  structured: boolean;
  release: string;
  node: string;
  /** evidence still missing before anyone may judge the release met */
  gaps: string[];
  /** release condition looks met on read-only facts (a report only, never an action) */
  wouldResume: boolean;
  next: string;
  /** state version: the report is deduplicated on it */
  fingerprint: string;
}

/** Intents still open on the card according to its own events (plan without a terminal settle or a cancel). */
function openIntents(events: readonly LedgerEvent[]): string[] {
  const open = new Map<string, true>();
  for (const e of events) {
    if (e.kind !== "scheduler") continue;
    if (e.data.op === "plan" && typeof e.data.id === "string") open.set(e.data.id, true);
    if (e.data.op === "settle" && ["done", "failed", "cancelled"].includes(String(e.data.to))) open.delete(String(e.data.id));
    for (const id of Array.isArray(e.data.cancelledIntents) ? e.data.cancelledIntents : []) open.delete(String(id));
  }
  return [...open.keys()];
}

/** One manual card's diagnosis; null when it is not in a manual it entered from automation. Contains no credentials. */
export function diagnoseManual(f: ManualFactsIn): ManualDiagnosis | null {
  const { task, events } = f;
  if (TERMINAL_STAGES.includes(task.stage)) return null;
  const entry = manualEntry(events);
  if (!entry) return null;
  const spec = entry.code ? MANUAL_REASONS[entry.code] : null;
  const gaps: string[] = [];
  if (!entry.code) gaps.push(entry.text ? `理由不认识：${entry.text.slice(0, 80)}` : "进入 manual 时没记理由");
  else if (!entry.record) gaps.push("旧记录没有结构化理由码 / 阻塞事件 / 解除条件");
  const rec = entry.record;
  if (rec) {
    if (rec.specRev !== task.specRev) gaps.push(`规格已变（specRev ${rec.specRev}→${task.specRev}）`);
    if ((rec.head ?? null) !== (task.headSHA ?? null)) gaps.push("head 已变");
    const ui = typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null;
    if ((rec.uiDigest ?? null) !== ui) gaps.push("UI 截图摘要已变");
  }
  const after = events.filter((e) => e.seq > entry.event.seq);
  const open = openIntents(events);
  if (open.length) gaps.push(`未结意图 / 旧订单：${open.slice(0, 3).join("、")}`);
  const fake = after.find((e) => e.kind === "review" && Array.isArray((e.data.witness as { mismatch?: unknown } | undefined)?.mismatch)
    && ((e.data.witness as { mismatch: unknown[] }).mismatch.length > 0));
  if (fake) gaps.push(`审查旁证对不上 #${fake.seq}`);
  // release check on read-only facts; every other code has no read-only proof here
  let met = false;
  if (entry.code === "deps_not_live") {
    if (f.blockedBy === undefined) gaps.push("依赖没读到");
    else if (f.blockedBy.length) gaps.push(`前置未上线：${f.blockedBy.join("、")}`);
    else met = true;
  } else if (entry.code === "merge_unknown") {
    if (f.mergeUnknown === undefined) gaps.push("合并 journal 没读到");
    else if (f.mergeUnknown.includes(task.id)) gaps.push("合并 / 部署结果仍不明");
    else met = true;
  } else if (spec?.sticky) gaps.push(`${spec.label}只由人解除`);
  else if (spec) gaps.push(`「${spec.release}」没有只读证据可核`);
  const wouldResume = met && !!rec && gaps.length === 0;
  const last = events.at(-1)?.seq ?? entry.event.seq;
  return {
    taskId: task.id, entrySeq: entry.event.seq, code: entry.code, label: spec?.label ?? "无理由", text: entry.text.slice(0, 200), structured: !!rec,
    release: rec?.release ?? spec?.release ?? "先补理由", node: spec?.node ?? "PM 补理由",
    gaps, wouldResume,
    next: !entry.code ? "PM 核对后 workflow-set --mode manual --reason \"<理由码>: 说明\" 补记理由"
      : wouldResume ? `解除条件看似已满足：PM 核对后按 ${spec!.node}（本巡检不执行恢复）`
      : `按 ${spec!.node} 处理：${gaps[0] ?? spec!.release}`,
    fingerprint: `t${task.rev}:s${task.specRev}:e${last}`,
  };
}

export type ManualResumeMode = "on" | "observe" | "off";

/**
 * The would-resume report's mode from CFG's port (mechanism manualStall). Absent port = observe, broken / invalid = off. on is
 * read as observe: real recovery belongs to MAN2 and this card has no execution entry.
 */
export function manualResumeMode(port: ((project: string, mechanism: "manualStall") => { mode: string }) | undefined, project: string): ManualResumeMode {
  if (!port) return "observe";
  try {
    const m = port(project, "manualStall")?.mode;
    return m === "off" ? "off" : m === "observe" || m === "on" ? "observe" : "off";
  } catch { return "off"; }
}
