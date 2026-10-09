/**
 * 审查已回待 PM 处置提醒（dispatch-recovery-RVWAKE1）的纯候选：调度 tick 的只读预筛与台账 writer 的事务重核用同一个 reviewPmCandidate。
 * 只认 workflow manual、停在 review 的 code 卡：本轮、准确当前 head 的结构化审查按原判据成立——currentReviewFacts → 出借池结论须过签名回执证明
 * （poolReviewRefusal，调度派单或 PM lend-offer 各按原证明）、本机 MCP 结论须是审查员本人按单入账、调度身份写的非出借结论无可核来源不算 →
 * reviewRefusal（写入人 / 作者独立 / 跨族 / 无 P0·P1 / 结论过合并闸，收件 PM 作请求人，与 manual-merge-request 受理同一判据）。
 * 新一轮审查在跑（未结调度意图、在跑的出借审查单、结论之后本机又派审）、规格版本与流程不一致、仓库方交接项目都不算；收件人不是作者 / 审查员。阻塞实例键 = 卡 + head + specRev + 轮次
 * + 审查 seq + 收件 PM；hold / 冻结 / 未答审批 / 截图门只进正文上下文，不进键、不被解除。记录与节流见 scheduler-review-pm-ledger.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow, type TaskWorkflow } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { authorOf, stepsOf } from "./ledger-steps.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { configHandoff, reviewRefusal, type HandoffPort } from "./manual-merge-queue-facts.js";
import { claimsPoolReview, poolReviewRefusal } from "./pool-review-proof.js";
import { verdictKey } from "./review-verdict.js";
import { projectPm } from "./scheduler-autostart.js";
import { mergePmTarget } from "./scheduler-merge-pm-wait.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { openSafetyHold } from "./scheduler-review-swap.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export interface ReviewPmCandidate {
  taskId: string; project: string; head: string; specRev: number; round: number; reviewSeq: number; pm: string; key: string; text: string;
}

/**
 * 新一轮审查在跑（旧结论不压它）：卡上有未结调度意图、活着的出借审查单，或本机 review / final_review 步骤在这条结论之后又派过人
 * （manual 本机派审只落 task_steps；同 head 重派也算，派出去的人还没交结论）
 */
function reviewRunning(db: Database, taskId: string, events: readonly LedgerEvent[], reviewSeq: number): boolean {
  const assigned = events.some((e) => e.seq > reviewSeq && e.kind === "step" && e.data.op === "assign" &&
    (e.data.step === "review" || e.data.step === "final_review"));
  if (assigned) return true;
  if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId)) return true;
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return false;
  const live = LEND_LIVE.map(() => "?").join(",");
  return !!db.query(`SELECT 1 FROM lend_orders WHERE taskId = ? AND step = 'review' AND status IN (${live}) LIMIT 1`).get(taskId, ...LEND_LIVE);
}

/** 结论的入账来源按各自原规则可核：出借池要签名回执链，本机 MCP 要本人按单入账，调度身份写的非出借结论没有可核来源 */
function sourceHolds(db: Database, task: LedgerTask, wf: TaskWorkflow, ev: LedgerEvent, f: ReviewFacts): boolean {
  if (ev.data.lend !== undefined || claimsPoolReview({ reviewer: f.reviewer, session: f.reviewerSessionId })) {
    return !poolReviewRefusal(db, task, wf, f) || !poolReviewRefusal(db, task, wf, f, { pmOffered: true });
  }
  if (ev.actor === "scheduler") return false;
  if (ev.data.via !== "mcp") return true; // CLI 行：写入人是否合规由 reviewRefusal 判
  return typeof ev.data.orderId === "string" && ev.actor === f.reviewer && ev.dedupKey === verdictKey({ orderId: ev.data.orderId, head: f.head });
}

/** 本轮、准确当前 head 的正规审查（经原判据成立）；不成立为 null */
function formalReview(db: Database, task: LedgerTask, wf: TaskWorkflow, events: readonly LedgerEvent[], pm: string): ReviewFacts | null {
  const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project));
  if (read.kind !== "facts" || read.facts.head !== task.headSHA) return null;
  const f = read.facts, ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev || !sourceHolds(db, task, wf, ev, f)) return null;
  const binding = { seq: ev.seq, actor: ev.actor, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily,
    reportPath: f.reportPath, verdict: f.verdict };
  return reviewRefusal(db, task, events, { review: binding, requestedBy: pm }) === null ? f : null;
}

/** 原有的合法阻塞，如实写进正文让 PM 照原规则处置；这里不判它们、不解除 */
function standingBlocks(db: Database, task: LedgerTask, wf: TaskWorkflow, events: readonly LedgerEvent[], now: number): string[] {
  const out: string[] = [];
  if (getMeta(db, task.project).queueFrozen.frozen) out.push("项目合并队列冻结中");
  const flow = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow");
  if (flow?.data.hold) out.push(`卡被明确留在人工 #${flow.seq}`);
  const safety = openSafetyHold(events);
  if (safety) out.push(`安全留证 #${safety.seq} 未处置`);
  if (task.featureId && getFeature(db, task.featureId)?.status === "paused") out.push(`feature ${task.featureId} 已暂停`);
  const asks = (db.query("SELECT COUNT(*) AS n FROM asks WHERE taskId = ? AND state = 'open'").get(task.id) as { n: number }).n;
  if (asks) out.push(`${asks} 条审批未答`);
  if (wf.template === "ui" && uiMergeRefusal(db, task, now)) out.push("当前 head 截图门未过");
  return out;
}

/**
 * 收件人：合法 feature PM（mergePmTarget，已排除名单外与调度助理），不适格再退项目当班 PM；卡的作者（卡上 agent 与改出当前 head 的写 / 修执行者）
 * 和本条结论的审查员都不收——按它的身份审查经原判据成立（reviewRefusal 以收件人为请求人）才算。都不适格 null
 */
function recipientAndReview(db: Database, task: LedgerTask, wf: TaskWorkflow, events: readonly LedgerEvent[]): { pm: string; f: ReviewFacts } | null {
  const meta = getMeta(db, task.project), authors = [task.agent, authorOf(stepsOf(db, task), task.headSHA)?.executor];
  for (const pm of new Set([mergePmTarget(db, task.id), projectPm(db, task.project)])) {
    if (!pm || !meta.pms.includes(pm) || pm === meta.team?.dispatcher || authors.includes(pm)) continue;
    const f = formalReview(db, task, wf, events, pm);
    if (f && f.reviewer !== pm) return { pm, f };
  }
  return null;
}

export function reviewPmCandidate(db: Database, taskId: string, now: number, handoff: HandoffPort = configHandoff): ReviewPmCandidate | null {
  const task = getTask(db, taskId), wf = task && getWorkflow(db, task.id);
  if (!task || !wf || wf.mode !== "manual" || task.kind !== "code" || task.stage !== "review" || !task.headSHA) return null;
  if (wf.specRev !== task.specRev || handoff(task.project)) return null;
  const events = listEvents(db, { project: task.project, target: task.id });
  const hit = recipientAndReview(db, task, wf, events);
  if (!hit || reviewRunning(db, task.id, events, hit.f.eventSeq)) return null;
  const { pm, f } = hit;
  const base = { taskId: task.id, project: task.project, head: task.headSHA, specRev: task.specRev, round: task.round, reviewSeq: f.eventSeq, pm };
  const key = createHash("sha256").update(JSON.stringify(base)).digest("hex").slice(0, 16);
  const p2 = f.findings.filter((x) => x.severity === "P2").length, ui = wf.template === "ui";
  const blocks = standingBlocks(db, task, wf, events, now);
  const at = `head ${base.head.slice(0, 12)} / specRev ${base.specRev} / 第 ${base.round} 轮`;
  const text = `[审查已回] ${task.id} ${at}：正规跨族审查 #${f.eventSeq}（${f.verdict}）已登记、无 P0/P1` +
    `${p2 ? `，另有 ${p2} 条 P2 未关、合并后要另行跟进` : ""}；卡仍停在 review，不会自动继续。请 PM 核当前完整门（CI` +
    `${ui ? " / 当前 head 截图（符合原沿用门时才沿用）" : ""} / 授权等，本提醒不代为确认）` +
    `${blocks.length ? `，现有阻塞：${blocks.join("、")}（照原规则处置，本提醒不解除）` : ""}；都过了再推 merge，` +
    `并提交绑定当前 ${at} / 审查 #${f.eventSeq} 的 manual-merge-request。实例 ${key}`;
  return { ...base, key, text };
}
