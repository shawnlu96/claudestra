/**
 * dispatch-recovery-MODELXP2 · 池单拒审豁免的唯一谓词：两道闸（pool-review-proof.ts 池审查回执、scheduler-review-swap.ts exemptVerdict
 * 即各合并入口的同家族判定）各一行调用它，不各写一份。放行要全部满足：
 * - 池单 epoch（ledger-pool-refusal.ts 写，scheduler 身份）在卡当前 head / specRev / 轮次窗口内，且与本单的窗口一致；
 * - epoch 的 toFamily = 本单家族，去处 peer = 本单 peer；
 * - 本单在 epoch 之后挂出，且是按这个 epoch 挂的：挂它的调度意图写明 epoch 号，单的原文带同一句豁免；
 * - 豁免文本与本地路径同一格式 `跨模型审查豁免:原审查模型策略拒审(批准 <approvalId>)`，批准有效未撤销（approvalLapse 同一口径）。
 * tests/ledger-pool-refusal-gate.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getTask, listEvents } from "./ledger-store.js";
import { approvalLapse } from "./scheduler-review-swap.js";

const EPOCH_OP = "pool_refusal_epoch";
/** = EXEMPTION_TEXT（scheduler-model-outcome.ts）；那边经 scheduler-review-swap.ts 引回本模块，这里不 import 它免成环（同 review-swap 的 EXEMPT_MARK） */
const EXEMPTION_TEXT = "跨模型审查豁免:原审查模型策略拒审";
type Window = Pick<LedgerTask, "headSHA" | "specRev" | "round">;

/** 豁免文本：与本地 MODELX epoch 同一格式 */
export const poolExemptionText = (approvalId: string): string => `${EXEMPTION_TEXT}(批准 ${approvalId})`;
/** 规划器挂换家族审查单时写进意图理由的绑定标记 */
export const poolEpochTag = (seq: number): string => `池单拒审 epoch #${seq}`;

/** 本窗口（head / specRev / 轮次都与卡当前一致）最新的池单审查拒审 epoch；不一致 = 不认 */
export function windowPoolEpoch(events: readonly LedgerEvent[], task: Window): LedgerEvent | null {
  const e = events.findLast((x) => x.actor === "scheduler" && x.kind === "scheduler" && x.data.op === EPOCH_OP && x.data.step === "review");
  return e && e.data.head === task.headSHA && e.data.specRev === task.specRev && e.data.round === task.round ? e : null;
}

/**
 * 规划器那一侧（纯函数，只看事件；批准与单号绑定由合并闸的 poolExemptVerdict 核）：本窗口池单 epoch 的去处 peer 交的、家族 = toFamily、
 * 晚于 epoch、head / 轮次与 epoch 一致的结论，算这一轮的豁免审查（同 exemptFacts 对本地会话）
 */
export function poolExemptFacts(events: readonly LedgerEvent[], task: Window, f: VerdictFacts & { reviewer: string; reviewerFamily: string }): boolean {
  const e = windowPoolEpoch(events, task), to = e?.data.to as { machine?: string; family?: string } | null | undefined;
  return !!e && !!to?.machine && to.family === f.reviewerFamily && e.data.toFamily === f.reviewerFamily && f.reviewer === `peer:${to.machine}` &&
    f.eventSeq > e.seq && f.head === e.data.head && f.round === e.data.round && !!f.reviewerSessionId?.startsWith(`lend:${to.machine}:`);
}

/** B：按本窗口 epoch 挂向它去处（peer + 家族）的审查单，验收行带的豁免文本；不是这样一张单 = null */
export function poolExemptionLine(db: Database, task: LedgerTask, peer: string, family: AuthorFamily): string | null {
  const e = windowPoolEpoch(listEvents(db, { project: task.project, target: task.id }), task);
  const to = e?.data.to as { machine?: string; family?: string } | null | undefined;
  return e && to?.machine === peer && to.family === family && e.data.toFamily === family && typeof e.data.exemption === "string" ? e.data.exemption : null;
}

type GateTask = Pick<LedgerTask, "id" | "headSHA" | "specRev" | "round">;
interface VerdictFacts { eventSeq: number; head: string | null; round: number; reviewerSessionId: string | null }
interface Order { orderId: string; taskId: string; peer: string; family: string; step: string; head: string; specRev: number; round: number; text: string }

/** 为什么这条结论不能按池单拒审豁免放行；null = 全部满足 */
export function poolExemptLapse(db: Database, at: GateTask, f: VerdictFacts): string | null {
  const row = getTask(db, at.id);
  if (!row) return "没有任务";
  const task = { ...row, headSHA: at.headSHA, specRev: at.specRev, round: at.round }; // 闸给的窗口（沿用审查时 head 是审查的那个 head）
  const events = listEvents(db, { project: task.project, target: task.id });
  const ev = events.find((e) => e.seq === f.eventSeq), orderId = (ev?.data.lend as { orderId?: unknown } | undefined)?.orderId;
  if (!ev || ev.kind !== "review" || typeof orderId !== "string") return "结论不是出借池入账的";
  const o = db.query("SELECT orderId, taskId, peer, family, step, head, specRev, round, text FROM lend_orders WHERE orderId = ?").get(orderId) as Order | null;
  if (!o || o.taskId !== task.id || o.step !== "review") return "没有本卡的池审查单";
  const e = windowPoolEpoch(events, task);
  if (!e) return "当前 head / specRev / 轮次窗口没有池单拒审 epoch";
  if (o.head !== e.data.head || o.specRev !== e.data.specRev || o.round !== e.data.round) return "单与 epoch 不在同一窗口";
  const to = e.data.to as { machine?: string; family?: string } | null;
  if (e.data.toFamily !== o.family || to?.family !== o.family || to?.machine !== o.peer) return "epoch 的去处家族 / peer 与本单不符";
  if (e.data.orderId === o.orderId) return "本单就是被拒的那张";
  // 结论本身（同 exemptFacts 对本地会话的核法）：晚于 epoch、head / 轮次与 epoch 一致、会话就是绑这个单号的那个
  if (ev.seq <= e.seq || f.head !== e.data.head || f.round !== e.data.round || f.reviewerSessionId !== `lend:${o.peer}:${o.orderId}`) return "结论不是 epoch 之后这张单的";
  const offer = events.find((x) => x.kind === "scheduler" && x.data.op === "pool_offer" && x.data.orderId === o.orderId);
  const intent = offer ? db.query("SELECT reason, causalSeq FROM scheduler_intents WHERE id = ?").get(String(offer.data.id)) as { reason: string; causalSeq: number } | null : null;
  if (!offer || offer.seq <= e.seq || !intent || intent.causalSeq < e.seq || !intent.reason.includes(poolEpochTag(e.seq))) return "单不是在 epoch 之后按它挂出的";
  const approvalId = e.data.approvalId;
  if (typeof approvalId !== "string" || !approvalId || e.data.exemption !== poolExemptionText(approvalId)) return "epoch 没有合格的豁免文本";
  if (!o.text.includes(poolExemptionText(approvalId))) return "单的原文没带豁免文本";
  // approvalLapse 原样：内容核对是派审时（卡在 review）的条件，过了审查到合并阶段只剩批准 id / 撤销 / 挂起要核（同本地 exemptVerdict）
  const lapse = approvalLapse(db, task, approvalId);
  return lapse === "内容未确认允许" && task.stage !== "review" ? null : lapse;
}

/** 两道闸调用的谓词 */
export const poolExemptVerdict = (db: Database, task: GateTask, facts: VerdictFacts): boolean => poolExemptLapse(db, task, facts) === null;
