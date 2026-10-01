/**
 * M3 审查单（T97）：台账当前的审查那一步 → 给审查员的 OrderWire（take_review 出，submit_verdict 按 orderId 现算再核一遍）。
 * 谁是「本步骤审查员」只有两个来源：自动卡 = 台账绑定的审查 session（agent + session 都要对上）且有派给它、同 head 的派审 intent；
 * 其它卡 = currentReview（初审 / 终审按轮次取）那一步的本机执行者。调用方身份只取 bridge 认出的（lib/caller-identity.ts），
 * 从不看参数。单子过期（换了 head、换了人、卡离开 review）就现算不出来，结论自然被拒。tests/review-order.test.ts。
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { IDENTITY_UNVERIFIED, requireVerified, type CallerIdentity } from "./caller-identity.js";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { currentReview, stepsOf } from "./ledger-steps.js";
import { manualOrderId } from "./order-take.js";
import { clipWire as clip, fitFindings, wireFindings } from "./order-findings.js";
import type { ReviewFinding } from "./scheduler-review.js";
import { parseOrderWire, WIRE_LIMITS, type OrderWire } from "./order-wire.js";
import { statePath } from "./paths.js";
import { standardAnswers } from "./order-standard-answers.js";
import { specSection } from "./review-pack.js";
import { runtimeFamily } from "./scheduler-auto-review.js";
import { bounceReviewLine, reviewAfterBounce } from "./scheduler-merge-conflict.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { readTextSoft, specPathFor } from "./task-spec.js";
import { convergeOrderLines } from "./review-converge-order.js";

/** bridge 认出并验证过的调用方（requireVerified 之后）；family 是 registry 的 runtime */
export interface ReviewCaller { agent: string; sessionId: string | null; family: string | null }

/** 两个工具共用的身份门：未验证一律 identity_unverified；认不出会话或家族（Pi 等）也拒——结构化结论要这两项，只能取身份里的 */
export function reviewCallerOf(identity: CallerIdentity): { caller: ReviewCaller & { sessionId: string }; family: AuthorFamily } | { error: string; message: string } {
  if (!requireVerified(identity).ok) return { error: IDENTITY_UNVERIFIED, message: "调用方身份未验证：重启这个 agent 拿新凭据后再来" };
  const family = identity.family ? runtimeFamily(identity.family) : null;
  if (!identity.agent || !identity.sessionId || !family) return { error: "identity_incomplete", message: "认不出调用方的会话或模型家族（只收 Claude Code / Codex 会话）" };
  return { caller: { agent: identity.agent, sessionId: identity.sessionId, family: identity.family }, family };
}

/** 审查单落在哪一步：orderId 之外，submit_verdict 还要知道是不是自动卡、审的是哪个 head */
export interface ReviewSlot { task: LedgerTask; orderId: string; node: string; head: string; auto: boolean }

/** 报告都放这里（和 `ledger review-pack` 同一个目录）；submit_verdict 只认这下面的非空文件 */
export const reviewsDir = (): string => statePath("ledger", "reviews");

/** 自动卡最近一次派审：和 scheduler-auto-review.ts 同一条查询口径（submitted / done 才算发出去了） */
function lastReviewIntent(db: Database, taskId: string): SchedulerIntent | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get()) return null;
  return db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND action = 'review' AND status IN ('submitted','done')
    ORDER BY eventSeq DESC LIMIT 1`).get(taskId) as SchedulerIntent | null;
}

/** 这张卡现在要不要调用方审：要就给出单的位置，不要 null（不报错——领单时「没有」是正常答复） */
function reviewSlotFor(db: Database, task: LedgerTask, caller: ReviewCaller): ReviewSlot | null {
  if (task.stage !== "review" || !task.headSHA) return null;
  if (getWorkflow(db, task.id)?.mode === "auto") {
    const bound = getSchedulerSession(db, task.id, "reviewer");
    if (!bound || bound.state !== "active" || bound.agent !== caller.agent || bound.sessionId !== caller.sessionId) return null;
    const intent = lastReviewIntent(db, task.id);
    if (!intent || intent.recipient !== caller.agent || intent.head !== task.headSHA) return null;
    return { task, orderId: intent.id, node: intent.node, head: task.headSHA, auto: true };
  }
  const s = currentReview(stepsOf(db, task));
  if (!s || s.executorKind !== "agent" || s.executor !== caller.agent) return null;
  return { task, orderId: manualOrderId(task.id, s.step, s.round), node: s.step, head: task.headSHA, auto: false };
}

/** orderId → 调用方现在手上的那张单；单不是它的、已过期、或卡不存在都是 null */
export function slotByOrderId(db: Database, orderId: string, caller: ReviewCaller): ReviewSlot | null {
  const intentTask = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_intents'").get()
    ? (db.query("SELECT taskId FROM scheduler_intents WHERE id = ?").get(orderId) as { taskId: string } | null)?.taskId : undefined;
  const taskId = intentTask ?? orderId.split(":")[0];
  const task = taskId ? getTask(db, taskId) : null;
  const slot = task ? reviewSlotFor(db, task, caller) : null;
  return slot && slot.orderId === orderId ? slot : null;
}

/** 在 review 阶段、调用方是审查员的卡（一个审查员可能同时挂几张） */
function reviewSlotsFor(db: Database, caller: ReviewCaller): ReviewSlot[] {
  const ids = (db.query("SELECT id FROM tasks WHERE stage = 'review' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  return ids.map((id) => getTask(db, id)).flatMap((t) => (t ? [reviewSlotFor(db, t, caller)] : [])).filter((s): s is ReviewSlot => !!s);
}

/** 规格的「验收线」（没有这一节就退到「验收」）：条目行，最多 WIRE_LIMITS.items 条 */
function acceptanceOf(specPath: string | null): string[] {
  const text = readTextSoft(specPath);
  if (!text) return [];
  const sec = specSection(text, "验收线");
  const lines = (sec.length ? sec : specSection(text, "验收")).filter((l) => l.trim());
  return lines.slice(0, WIRE_LIMITS.items).map((l) => clip(l, WIRE_LIMITS.line));
}

/** 上一轮（早于本轮）最后一条带逐项结论的 review 事件：它的 findings，和装不下时单子里指过去的报告路径；池子审查单（ledger-lend.ts）共用 */
export function prevReview(events: readonly LedgerEvent[], round: number): { findings: ReviewFinding[]; report: string | null } {
  const prev = events.findLast((e) => e.kind === "review" && typeof e.data.round === "number" && e.data.round < round && Array.isArray(e.data.findings));
  return { findings: wireFindings(prev?.data.findings), report: typeof prev?.data.path === "string" ? prev.data.path : null };
}

/** GitHub PR 链接或纯数字 → repo / pr；别的写法（分支名、空）当本机单 */
function prCoords(pr: string | null): { repo: string | null; pr: number | null } {
  const url = pr?.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  if (url) return { repo: url[1], pr: Number(url[2]) };
  return { repo: null, pr: pr && /^#?\d{1,9}$/.test(pr.trim()) ? Number(pr.trim().replace("#", "")) : null };
}

/** 报告路径要求：<reviews>/<T>-r<N>[-<节点>].md，与 review-pack 同一个目录 */
function reportPathFor(slot: Pick<ReviewSlot, "task" | "node">, dir = reviewsDir()): string {
  const tag = slot.node === "review" ? "" : `-${slot.node.replace(/[^\w.-]/g, "")}`;
  return join(dir, `${slot.task.id}-r${slot.task.round}${tag}.md`);
}

/** 审查单本身；构造完过一遍 parseOrderWire——发出去的单和收进来的单用同一把尺子，坏了就不发（返回 null 并说明） */
export function reviewOrderOf(db: Database, slot: ReviewSlot, dir = reviewsDir()): { ok: true; order: OrderWire } | { ok: false; error: string } {
  const { task } = slot;
  const events = listEvents(db, { project: task.project, target: task.id });
  const wf = getWorkflow(db, task.id);
  const report = reportPathFor(slot, dir);
  const specPath = specPathFor(task, getMeta(db, task.project).docsDir);
  const prev = prevReview(events, task.round);
  const bounce = reviewAfterBounce(events);
  const order: OrderWire = {
    v: 1, orderId: slot.orderId, taskId: task.id, specRev: task.specRev, dagVersion: null, node: slot.node, step: "review",
    round: task.round, head: slot.head, ...prCoords(task.pr),
    inputs: [`规格：${specPath ? clip(specPath, WIRE_LIMITS.path) : `ledger show ${task.id}`}（specRev ${task.specRev}）`, `只审 head ${slot.head}${task.branch ? `（分支 ${clip(task.branch, 200)}）` : ""}`,
      // 自动卡的审查员建在自己的审查 worktree 里，调度器派审前把它固定在这个 head（scheduler-review-worktree.ts）
      ...(slot.auto ? ["审查目录：你当前会话的工作目录（调度器已固定在这个 head；只读，不改、不提交、不推送）"] : []),
      ...(bounce ? [bounceReviewLine(bounce)] : []), ...convergeOrderLines(task.round, events, slot.head), standardAnswers("review")],
    outputs: ["结论：submit_verdict（VerdictWire：verdict、p0/p1/p2 计数与逐项 findings 一致）", `报告：${report}（非空；旧版逐项标记可从报告读取）`],
    acceptance: acceptanceOf(specPath),
    writeBack: `submit_verdict({v:1, orderId:"${slot.orderId}", head:"${slot.head}", …, reportPath:"${report}"})；只记结论，不推阶段`,
    findings: prev.findings,
    fallback: wf?.fallback ? clip(wf.fallback, WIRE_LIMITS.fallback) : null,
  };
  const checked = parseOrderWire(fitFindings(order, prev.report));
  return checked.ok ? { ok: true, order: checked.value } : { ok: false, error: `审查单构造出错（${checked.error}）` };
}

export type TakeReviewResult = { ok: true; orders: OrderWire[]; errors: string[] } | { ok: false; error: string; message: string };

/** take_review：调用方现在该审的单（可能没有，也可能几张）；某张构造不出来不连累别的，原因放 errors */
export function takeReview(db: Database, identity: CallerIdentity, dir = reviewsDir()): TakeReviewResult {
  const who = reviewCallerOf(identity);
  if ("error" in who) return { ok: false, ...who };
  const orders: OrderWire[] = [], errors: string[] = [];
  for (const slot of reviewSlotsFor(db, who.caller)) {
    const r = reviewOrderOf(db, slot, dir);
    if (r.ok) orders.push(r.order);
    else errors.push(`${slot.task.id}：${r.error}`);
  }
  return { ok: true, orders, errors };
}
