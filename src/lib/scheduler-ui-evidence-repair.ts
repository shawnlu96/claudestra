/**
 * PMQUIET1 · 缺截图自动派作者补齐：UI 卡当前有效审查已过代码门、唯一待补材料是前后截图时，不退人工、不叫 PM，交原作者补 uiEvidence。
 * 只接：ui 模板、auto、完整 head、截图摘要缺失 / 不合格，本轮同 head 的审查经原来源证明成立（reviewSourced）、verdict 不是 block、
 * 没有 P0/P1；owner / PM 截图门没有被拒。P0/P1、无效审查、缺来源证明、截图被拒、审批未通过都不归这里（照旧路）。
 * 走法（纯规划，执行全是现有路径）：review 阶段 uiPassStep 交回 kind=fix（review→fix 不加轮次），fix 阶段 fixSelfHeal 交回补截图工单，
 * 由 dispatchWork 照常经作者 session / channel 派单与回执；补图工单不改代码，只要求随交付带有效 uiEvidence（uiDelivery 原样校验）。
 * 绑定窗口 = 卡 + head + specRev：每窗口最多 UI_REPAIR_MAX 次补图尝试。一次尝试 = 一段因缺图进入的 fix 里有一条已送达（done）的作者派单；
 * 只从台账事件 / 意图读，重复 tick、重启、重复回执都不多计；派单没送达不算。超限才退人工一次（原因带 pmNoticeTag 复核尾签）。
 * head 或规格变了就是新窗口，旧工单的绑定（findingId 带 head / specRev / 轮次）不再适用，按当前门重判。
 * 恢复键 pmQuiet（本模块 pmQuietMode，复核与出口也读它）：off / observe = 原决定逐字不变（含 selfHealBeforeManual 自救）。
 * 领单（take_order，order-take.ts 一行接线）：wake 派单时作者只看得到 take_order 的单，uiRepairTakeOrder 按台账同一口径给出与规划器
 * 同一张补截图工单（findingId / probe 一致），否则作者领到的是原 pass 审查的空修复列表。
 * 本模块是叶子（领单 order-take.ts 也引它）：不引复核 / 调度服务模块，审查来源证明（review-source-proof.ts reviewSourced）由规划器调用方传进来，
 * 领单时的来源重核由 scheduler-fix-selfheal.ts 注入（configureUiRepairTakeSource）。
 * tests/scheduler-ui-evidence-repair.test.ts。
 */
import type { Database } from "bun:sqlite";
import { fixStartReviewFacts } from "./lend-fix-start-review.js";
import { getWorkflow, type SchedulerIntent, type TaskWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { wireFindings } from "./order-findings.js";
import { UI_REJECTED, type PmUiGate } from "./ledger-ui-approve-verdict.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import { currentReviewFacts, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";
import { DIGEST_RE } from "./scheduler-ui-merge-refusal.js";

/** PMQUIET1 恢复键（本模块补图、pm-notice-current.ts 复核、pm-notify.ts 出口共用；放在这个叶子模块里，领单 / 规划器引它不经复核模块绕成环） */
export const PM_QUIET_KEY = "pmQuiet";
/** 补截图超限后的 PM 待办类型（本模块 exhausted 发） */
export const UI_REPAIR_TODO = "ui_evidence_repair";
/** 复核认得的待办类型；别的类型照旧投 */
export type PmNoticeKind = "review_pm_wait" | "merge_pm_wait" | typeof UI_REPAIR_TODO;
/** 可复核的提醒引用：卡号 + 待办类型 + 绑定窗口（实例键，或补图窗口键） */
export interface PmNoticeRef { kind: PmNoticeKind; taskId: string; key: string }
/** 显式引用随正文走的尾行（只在 pmQuiet 不是 off 时加） */
export const pmNoticeTag = (ref: PmNoticeRef): string => `\n〔提醒复核 ${ref.kind} ${ref.taskId} ${ref.key}〕`;

export type PmQuietModePort = (project: string) => RecoveryMode;
/** 读不了 / 未知键 = off（旧路） */
const policyMode: PmQuietModePort = (project) => {
  try { const p = recoveryPolicy(project, PM_QUIET_KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
};
let modePort: PmQuietModePort = policyMode;
/** Tests only: swap the mode reader; returns the restore. */
export function configurePmQuietMode(port: PmQuietModePort | null): () => void {
  const was = modePort;
  modePort = port ?? policyMode;
  return () => { modePort = was; };
}
export const pmQuietMode = (project: string): RecoveryMode => modePort(project);

const UI_REPAIR_MAX = 2;
/** 规划器快照（scheduler-plan.ts PlannerSnapshot）里本模块读的那几项：不引 scheduler-plan，领单引本模块才不成环 */
export interface RepairSnapshot {
  task: LedgerTask; workflow: Pick<TaskWorkflow, "template" | "mode"> | null; events: readonly LedgerEvent[]; intents: readonly SchedulerIntent[];
  uiGate: { state: string }; pmUiGate?: PmUiGate; screenshotsDigest: string | null;
}
export const UI_REPAIR_FAMILY = "ui_evidence_repair";
const SHA = /^[0-9a-f]{40}$/;

/** 补截图的工单材料（与规划器的 fix 工单同形，dispatchWork 原样派出） */
export interface UiRepairOrder { reportPath: string; findings: ReviewFinding[]; fallbackWarning: null }
type Exhausted = { kind: "escalate"; code: string; reason: string };
type RepairStep = { kind: "fix"; note: string; seq: number } | Exhausted;

const uiRepairWindow = (task: Pick<LedgerTask, "headSHA" | "specRev">): string => `${task.headSHA}:s${task.specRev}`;
const missingShots = (digest: unknown): boolean => typeof digest !== "string" || !DIGEST_RE.test(digest);
const codeClean = (f: ReviewFacts): boolean => f.verdict !== "block" && !f.findings.some((x) => x.severity === "P0" || x.severity === "P1");

/** 某一轮因缺图进的 fix：那一轮同 head 的审查无 P0/P1、不是 block，且那一轮没有截图被拒的决定 */
function repairEntry(events: readonly LedgerEvent[], e: LedgerEvent, head: string): boolean {
  const round = e.data.round;
  const review = events.findLast((x) => x.kind === "review" && x.data.round === round && x.seq < e.seq);
  if (!review || review.data.head !== head || review.data.verdict === "block") return false;
  const rows = Array.isArray(review.data.findings) ? review.data.findings as { severity?: unknown }[] : [];
  if (rows.some((f) => f?.severity === "P0" || f?.severity === "P1") || (typeof review.data.p1 === "number" && review.data.p1 > 0)) return false;
  return !events.some((x) => x.kind === "decision" && x.data.op === UI_REJECTED && x.data.round === round && x.seq < e.seq);
}

/** 本窗口（head + specRev）已用掉的补图尝试：每段缺图 fix 里有一条已送达的作者派单算一次 */
export function uiRepairAttempts(s: Pick<RepairSnapshot, "task" | "events" | "intents">): number {
  const head = s.task.headSHA ?? "", entries = s.events.filter((e) => e.kind === "stage" && e.data.to === "fix" &&
    (e.data.specRev === undefined || e.data.specRev === s.task.specRev) && repairEntry(s.events, e, head));
  return entries.filter((e) => {
    const next = s.events.find((x) => x.kind === "stage" && x.seq > e.seq)?.seq ?? Infinity;
    return s.intents.some((i) => i.action === "dispatch" && i.status === "done" && i.head === head && i.causalSeq >= e.seq && i.causalSeq < next);
  }).length;
}

/** 审查经原来源证明成立（规划器传 review-source-proof.ts reviewSourced） */
export type ReviewSourcedPort<S extends RepairSnapshot> = (s: S, facts: ReviewFacts) => boolean;

/** 唯一缺项是截图：返回本轮成立的审查，否则 null */
function screenshotOnly<S extends RepairSnapshot>(s: S, facts: ReviewFacts | null, reviewSourced: ReviewSourcedPort<S>): ReviewFacts | null {
  const { task, workflow } = s;
  if (workflow?.template !== "ui" || workflow.mode !== "auto" || !SHA.test(task.headSHA ?? "") || !missingShots(s.screenshotsDigest)) return null;
  if (s.uiGate.state === "rejected" || s.pmUiGate?.state === "rejected") return null;
  if (!facts || facts.head !== task.headSHA || facts.round !== task.round || !codeClean(facts)) return null;
  return reviewSourced(s, facts) ? facts : null;
}

// 理由码沿用缺截图那一支（manual-reason.ts 认它、UI 人工恢复按它接回），原因写明是补图超限
const exhausted = (s: RepairSnapshot): Exhausted => ({ kind: "escalate", code: "ui_missing_screenshots",
  reason: `作者已 ${UI_REPAIR_MAX} 次补截图仍未补齐（head ${s.task.headSHA}，规格第 ${s.task.specRev} 版）：请 PM 接手${pmNoticeTag({ kind: UI_REPAIR_TODO, taskId: s.task.id, key: uiRepairWindow(s.task) })}` });

/** review 阶段（uiPassStep 缺图那一支）：on 时进 fix 交作者补图，超限退人工一次；null = 照旧 */
export function uiRepairPassStep<S extends RepairSnapshot>(s: S, reviewSeq: number, sourced: ReviewSourcedPort<S>): RepairStep | null {
  if (pmQuietMode(s.task.project) !== "on" || s.task.stage !== "review") return null;
  const read = currentReviewFacts(s.task, s.events);
  const facts = screenshotOnly(s, read.kind === "facts" && read.facts.eventSeq === reviewSeq ? read.facts : null, sourced);
  if (!facts) return null;
  if (uiRepairAttempts(s) >= UI_REPAIR_MAX) return exhausted(s);
  return { kind: "fix", note: `代码已过审查，只缺前后截图：交原作者在 head ${s.task.headSHA} 补交 uiEvidence（不改代码）`, seq: reviewSeq };
}

/** fix 阶段（fixSelfHeal 之前）：缺图那一支交补截图工单而不是 fix→review 回审；超限退人工一次；null = 照旧 */
export function uiRepairFix<S extends RepairSnapshot>(s: S, facts: ReviewFacts | null, sourced: ReviewSourcedPort<S>): UiRepairOrder | Exhausted | null {
  if (pmQuietMode(s.task.project) !== "on" || s.task.stage !== "fix") return null;
  const f = screenshotOnly(s, facts, sourced);
  if (!f) return null;
  if (uiRepairAttempts(s) >= UI_REPAIR_MAX) return exhausted(s);
  return repairOrder(s.task, f);
}

/** 补截图工单本身：规划器（uiRepairFix）与领单（uiRepairTakeOrder）同一份 */
function repairOrder(task: LedgerTask, f: ReviewFacts): UiRepairOrder {
  const bind = `head ${task.headSHA} / 规格第 ${task.specRev} 版 / 第 ${task.round} 轮`;
  return { reportPath: f.reportPath, fallbackWarning: null, findings: [{
    findingId: `ui-evidence-repair-${task.headSHA!.slice(0, 12)}-s${task.specRev}-r${task.round}`, family: UI_REPAIR_FAMILY, severity: "P1",
    probe: `补截图（${bind}）：代码已过审查 #${f.eventSeq}，不用改代码；在同一 head 拍前后截图，交付时带有效 uiEvidence（绑定本卡、该 head、` +
      `规格版本与交付后轮次）。截图只登记证据，视觉验收仍由 PM / owner 做`,
  }] };
}

const hasIntents = (db: Database): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get();
/**
 * 领单的工单身份：本段 fix（同轮、同规格）里规划器派出的 fix 派单，同 head、同规格版本、没被取消（与 order-take.ts currentIntent 同口径）。
 * 只认身份不认投递回执：wake 已送出、回执丢了（unknown）的作者照样要领到补图要求；计次仍只数已送达（uiRepairAttempts）
 */
function repairDispatched(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  const entry = events.findLast((e) => e.kind === "stage" && e.data.to === "fix");
  if (!entry || entry.data.round !== task.round || (entry.data.specRev !== undefined && entry.data.specRev !== task.specRev)) return false;
  const row = hasIntents(db) && db.query(`SELECT 1 FROM scheduler_intents WHERE taskId = ? AND action = 'dispatch' AND node = 'fix' AND status != 'cancelled'
    AND head = ? AND specRev = ? AND causalSeq >= ? LIMIT 1`).get(task.id, task.headSHA, task.specRev, entry.seq);
  return !!row;
}

/**
 * 领单时重核审查来源（规划器同一份快照 + review-source-proof.ts reviewSourced）：派单之后来源失效，领单就不再出补图单。
 * 快照与来源证明模块都经调度服务绕回 order-take，本叶子静态引不了，由 scheduler-fix-selfheal.ts 注入；没注入 / 出错 = 不出补图单
 */
export type TakeSourcePort = (db: Database, task: LedgerTask, facts: ReviewFacts) => boolean;
let takeSource: TakeSourcePort | null = null;
/** 注入领单来源重核；返回恢复函数 */
export function configureUiRepairTakeSource(port: TakeSourcePort | null): () => void {
  const was = takeSource;
  takeSource = port;
  return () => { takeSource = was; };
}
const takeSourced = (db: Database, task: LedgerTask, facts: ReviewFacts): boolean => {
  try { return !!takeSource && takeSource(db, task, facts); } catch { return false; }
};

/**
 * take_order 领到的补截图单（order-take.ts ownFixContext）：pmQuiet on、ui 卡 auto、fix 阶段、截图仍缺，进 fix 的那轮同 head 审查
 * 无 P0/P1 且不是 block，本轮没有截图被拒，本段 fix 有规划器派出的补图派单（repairDispatched，不看回执），且领单此刻审查来源仍成立
 * （takeSourced）；不是这种卡返回 null（领单逐字照旧）
 */
export function uiRepairTakeOrder(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): { findings: ReviewFinding[]; report: string } | null {
  if (task.stage !== "fix" || pmQuietMode(task.project) !== "on" || !SHA.test(task.headSHA ?? "") || !missingShots(task.extra.screenshotsDigest)) return null;
  const wf = getWorkflow(db, task.id);
  if (wf?.template !== "ui" || wf.mode !== "auto") return null;
  if (events.some((x) => x.kind === "decision" && x.data.op === UI_REJECTED && x.data.round === task.round)) return null;
  const read = fixStartReviewFacts(task, events);
  if (read.kind !== "facts" || read.facts.head !== task.headSHA || read.facts.round !== task.round || !codeClean(read.facts)) return null;
  if (!repairDispatched(db, task, events) || !takeSourced(db, task, read.facts)) return null;
  const order = repairOrder(task, read.facts);
  return { findings: wireFindings(order.findings), report: order.reportPath };
}
