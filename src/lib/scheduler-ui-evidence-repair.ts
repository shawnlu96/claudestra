/**
 * PMQUIET1 · 缺截图自动派作者补齐：UI 卡当前有效审查已过代码门、唯一待补材料是前后截图时，不退人工、不叫 PM，交原作者补 uiEvidence。
 * 只接：ui 模板、auto、完整 head、截图摘要缺失 / 不合格，本轮同 head 的审查经原来源证明成立（reviewSourced）、verdict 不是 block、
 * 没有 P0/P1；owner / PM 截图门没有被拒。P0/P1、无效审查、缺来源证明、截图被拒、审批未通过都不归这里（照旧路）。
 * 走法（纯规划，执行全是现有路径）：review 阶段 uiPassStep 交回 kind=fix（review→fix 不加轮次），fix 阶段 fixSelfHeal 交回补截图工单，
 * 由 dispatchWork 照常经作者 session / channel 派单与回执；补图工单不改代码，只要求随交付带有效 uiEvidence（uiDelivery 原样校验）。
 * 绑定窗口 = 卡 + head + specRev：每窗口最多 UI_REPAIR_MAX 次补图尝试。一次尝试 = 一段因缺图进入的 fix 里有一条已送达（done）的作者派单；
 * 只从台账事件 / 意图读，重复 tick、重启、重复回执都不多计；派单没送达不算。超限才退人工一次（原因带 pm-notice-current.ts 的复核尾签）。
 * head 或规格变了就是新窗口，旧工单的绑定（findingId 带 head / specRev / 轮次）不再适用，按当前门重判。
 * 恢复键 pmQuiet（pm-notice-current.ts pmQuietMode）：off / observe = 原决定逐字不变（含 selfHealBeforeManual 自救）。
 * tests/scheduler-ui-evidence-repair.test.ts。
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { UI_REJECTED } from "./ledger-ui-approve-verdict.js";
import { pmNoticeTag, pmQuietMode, UI_REPAIR_TODO } from "./pm-notice-current.js";
import { reviewSourced } from "./review-source-proof.js";
import { currentReviewFacts, type ReviewFacts, type ReviewFinding } from "./scheduler-review.js";
import { DIGEST_RE } from "./scheduler-ui-merge-refusal.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";

const UI_REPAIR_MAX = 2;
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
export function uiRepairAttempts(s: Pick<PlannerSnapshot, "task" | "events" | "intents">): number {
  const head = s.task.headSHA ?? "", entries = s.events.filter((e) => e.kind === "stage" && e.data.to === "fix" &&
    (e.data.specRev === undefined || e.data.specRev === s.task.specRev) && repairEntry(s.events, e, head));
  return entries.filter((e) => {
    const next = s.events.find((x) => x.kind === "stage" && x.seq > e.seq)?.seq ?? Infinity;
    return s.intents.some((i) => i.action === "dispatch" && i.status === "done" && i.head === head && i.causalSeq >= e.seq && i.causalSeq < next);
  }).length;
}

/** 唯一缺项是截图：返回本轮成立的审查，否则 null */
function screenshotOnly(s: PlannerSnapshot, facts: ReviewFacts | null): ReviewFacts | null {
  const { task, workflow } = s;
  if (workflow?.template !== "ui" || workflow.mode !== "auto" || !SHA.test(task.headSHA ?? "") || !missingShots(s.screenshotsDigest)) return null;
  if (s.uiGate.state === "rejected" || s.pmUiGate?.state === "rejected") return null;
  if (!facts || facts.head !== task.headSHA || facts.round !== task.round || !codeClean(facts)) return null;
  return reviewSourced(s, facts) ? facts : null;
}

// 理由码沿用缺截图那一支（manual-reason.ts 认它、UI 人工恢复按它接回），原因写明是补图超限
const exhausted = (s: PlannerSnapshot): Exhausted => ({ kind: "escalate", code: "ui_missing_screenshots",
  reason: `作者已 ${UI_REPAIR_MAX} 次补截图仍未补齐（head ${s.task.headSHA}，规格第 ${s.task.specRev} 版）：请 PM 接手${pmNoticeTag({ kind: UI_REPAIR_TODO, taskId: s.task.id, key: uiRepairWindow(s.task) })}` });

/** review 阶段（uiPassStep 缺图那一支）：on 时进 fix 交作者补图，超限退人工一次；null = 照旧 */
export function uiRepairPassStep(s: PlannerSnapshot, reviewSeq: number): RepairStep | null {
  if (pmQuietMode(s.task.project) !== "on" || s.task.stage !== "review") return null;
  const read = currentReviewFacts(s.task, s.events);
  const facts = screenshotOnly(s, read.kind === "facts" && read.facts.eventSeq === reviewSeq ? read.facts : null);
  if (!facts) return null;
  if (uiRepairAttempts(s) >= UI_REPAIR_MAX) return exhausted(s);
  return { kind: "fix", note: `代码已过审查，只缺前后截图：交原作者在 head ${s.task.headSHA} 补交 uiEvidence（不改代码）`, seq: reviewSeq };
}

/** fix 阶段（fixSelfHeal 之前）：缺图那一支交补截图工单而不是 fix→review 回审；超限退人工一次；null = 照旧 */
export function uiRepairFix(s: PlannerSnapshot, facts: ReviewFacts | null): UiRepairOrder | Exhausted | null {
  if (pmQuietMode(s.task.project) !== "on" || s.task.stage !== "fix") return null;
  const f = screenshotOnly(s, facts);
  if (!f) return null;
  if (uiRepairAttempts(s) >= UI_REPAIR_MAX) return exhausted(s);
  const { task } = s, bind = `head ${task.headSHA} / 规格第 ${task.specRev} 版 / 第 ${task.round} 轮`;
  return { reportPath: f.reportPath, fallbackWarning: null, findings: [{
    findingId: `ui-evidence-repair-${task.headSHA!.slice(0, 12)}-s${task.specRev}-r${task.round}`, family: UI_REPAIR_FAMILY, severity: "P1",
    probe: `补截图（${bind}）：代码已过审查 #${f.eventSeq}，不用改代码；在同一 head 拍前后截图，交付时带有效 uiEvidence（绑定本卡、该 head、` +
      `规格版本与交付后轮次）。截图只登记证据，视觉验收仍由 PM / owner 做`,
  }] };
}
