/**
 * SELFHEAL1 · 没 P1 就回审：fixPackage 两处 `fix_report`（缺上一轮完整审查报告 / 收敛后没有 P1）退人工之前先问这里。
 * on：核对全过就规划一条 fix→review 的 stage 意图（scheduler-apply.ts ENGINE_MOVES 里 fix>review 只为它开），进 review 照常 round+1，
 * 下一轮照正常流程对同一个 head 派新一轮审查（上一轮的报告不算本轮结论）；同一个 head 只自救一次，第二次照旧 fix_report。
 * observe：照旧退人工，原因后附一句「恢复观察 selfHealBeforeManual：本会…」。off：原决定逐字不变。
 * 回审前核对（任一条不满足照旧退人工）：卡是 auto；head 等于最近一次审查结论的 head；那份结论（本轮的）里没有 P1；
 * 进 fix 之后没有新交付；进 fix 时的规格版本、轮次与现在一致。
 * 规划器纯函数：「已自救过」只从快照事件里读（fix→review 的 stage 事件，文字带 SELF_HEAL_MARK 与 head）；开关从恢复策略读（同 nearMarker）。
 * tests/scheduler-fix-selfheal.test.ts。
 */
import type { LedgerEvent } from "./ledger-stages.js";
import { recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { nodeAt, templateFor } from "./scheduler-template.js";
import { intentAttempt, intentKeyPrefix } from "./scheduler-plan-attempt.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";

const SELF_HEAL_KEY = "selfHealBeforeManual";
/** 回审 stage 事件文字里的标记（PM 与 agents-OBSAUTO1 按它找样本；「已自救过」也按它认）。 */
export const SELF_HEAL_MARK = "无 P1 自动回审";
const SHA = /^[0-9a-f]{40}$/;

export type SelfHealModePort = (project: string) => RecoveryMode;
/** 读不了 / 未知键 = off。 */
const policyMode: SelfHealModePort = (project) => {
  try { const p = recoveryPolicy(project, SELF_HEAL_KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
};
let modePort: SelfHealModePort = policyMode;
/** Tests only: swap the mode reader; returns the restore. */
export function configureSelfHealMode(port: SelfHealModePort | null): () => void {
  const was = modePort;
  modePort = port ?? policyMode;
  return () => { modePort = was; };
}
const selfHealMode = (project: string): RecoveryMode => modePort(project);

const fixEntry = (events: readonly LedgerEvent[]): LedgerEvent | undefined =>
  events.findLast((e) => e.kind === "stage" && e.data.to === "fix");

/** The head already had its one self-heal (any round): a fix→review stage event naming it. */
function selfHealedHead(events: readonly LedgerEvent[], head: string): boolean {
  return events.some((e) => e.kind === "stage" && e.data.from === "fix" && e.data.to === "review" &&
    e.text.includes(SELF_HEAL_MARK) && e.text.includes(head));
}

const p1Of = (review: LedgerEvent): number => {
  const rows = Array.isArray(review.data.findings) ? review.data.findings as { severity?: unknown }[] : [];
  return Math.max(rows.filter((f) => f && f.severity === "P1").length, typeof review.data.p1 === "number" ? review.data.p1 : 0);
};

/** Why this card may not self-heal now; null = every check passed. `facts` = the converged report (no-P1 case), null = report missing. */
export function selfHealRefusal(s: PlannerSnapshot, facts: ReviewFacts | null): string | null {
  const { task, workflow, events } = s, head = task.headSHA ?? "";
  if (workflow?.mode !== "auto") return "卡不在自动流程";
  if (task.stage !== "fix" || !SHA.test(head)) return "卡不在 fix 或 head 不完整";
  const latest = events.findLast((e) => e.kind === "review");
  if (!latest || latest.data.head !== head) return "卡的 head 不是最近一次审查结论的 head";
  if (facts ? facts.findings.some((f) => f.severity === "P1") : latest.data.round === task.round && p1Of(latest) > 0) return "修复报告里仍有 P1";
  const entry = fixEntry(events);
  if (!entry || entry.data.round !== task.round || (entry.data.specRev !== undefined && entry.data.specRev !== task.specRev)) return "进 fix 之后轮次或规格版本变了";
  if (events.some((e) => e.kind === "deliver" && e.seq > entry.seq)) return "进 fix 之后已有新交付";
  if (selfHealedHead(events, head)) return "同一个 head 已自动回审过一次";
  return null;
}

/**
 * fixPackage's `fix_report` escalation, passed in as `fallback`, comes back unchanged (off / refused), with the observe note
 * (observe), or replaced by the one fix→review stage intent (on). Nothing here reads outside the snapshot but the switch.
 */
export function fixSelfHeal(s: PlannerSnapshot, facts: ReviewFacts | null, fallback: PlannerDecision): PlannerDecision {
  if (fallback.kind !== "escalate") return fallback;
  const mode = selfHealMode(s.task.project);
  if (mode === "off" || selfHealRefusal(s, facts)) return fallback;
  const head = s.task.headSHA as string, basis = facts ? `依据修复报告 ${facts.reportPath}（收敛后无 P1）` : "依据：上一轮完整审查报告缺失，让审查重出一份";
  const what = `${SELF_HEAL_MARK}：第 ${s.task.round} 轮修复阶段${facts ? "没有 P1" : "缺上一轮完整审查报告"}，回 review 对 head ${head} 重新派审（${SELF_HEAL_KEY}，同 head 只一次），${basis}`;
  if (mode === "observe") return { ...fallback, reason: `${fallback.reason}；恢复观察 ${SELF_HEAL_KEY}：本会自救（${what}）` };
  const template = s.workflow && templateFor(s.workflow.template, s.workflow.templateVersion);
  const node = template && nodeAt(template, "fix");
  if (!node) return fallback;
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? s.events.find((e) => e.kind === "task")?.seq ?? 0;
  const born = s.events.find((e) => e.kind === "task")?.seq ?? 0;
  return { kind: "intent", id: `${intentKeyPrefix(since, s.task.round, node.id)}${intentAttempt(s.intents, node.id, since, s.task.round)}`,
    node: node.id, action: "stage", reason: what, resources: [`task:s${born}`], recipient: null, observedOnly: false, targetStage: "review" };
}
