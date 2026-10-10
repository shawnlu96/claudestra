/**
 * MAINP2 r2 merge-auth：PM 手动 preflight 每次 GitHub 写（update-branch / merge API）前，用只读台账把要动的 head 绑到本轮真实 PASS：
 * 真实 PM / master / owner、卡在 merge、PR 对得上、台账 head 就是这个 head（动过的 head 只有正式沿用写进台账后才算数，observe / off
 * 与任意 flag / Git 证明都不授权），再走 reviewGate 现核全部当前合并门。tests/review-main-carry-manual-merge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mustTask } from "./ledger-checks.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { LedgerError } from "./ledger-store.js";
import { reviewGate } from "./review-main-carry-manual.js";

/**
 * `base` is the head the round's real PASS event was written for (`review.head`), before every carry — engine `review_carry` and
 * formal PM `review_main_carry` alike: the only oldHead a pre-API proof may use (r4 merge-proof: not the PM chain's start).
 */
export interface MergeAuth { taskId: string; head: string; base: string; reviewSeq: number; carries: number; sourceKind: string }

/** Read-only; any missing fact or failed gate is a refusal reason (never a pass). */
export function manualMergeAuth(db: Database | null, actor: string, req: { taskId: string; pr: string; head: string }, now: number):
  { ok: true; auth: MergeAuth } | { ok: false; reason: string } {
  if (!db) return { ok: false, reason: "台账读不了（LedgerReader 没有可读库），不授权合并" };
  try {
    if (actor === "scheduler") return { ok: false, reason: "调度引擎的合并只走 scheduler-merge-step" };
    const task = mustTask(db, req.taskId);
    if (!actorMayConfigure(db, actor, task.project)) return { ok: false, reason: `合并要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${actor}）` };
    if (task.stage !== "merge") return { ok: false, reason: `${task.id} 在 ${task.stage}，不在 merge` };
    if (task.pr !== req.pr) return { ok: false, reason: `${task.id} 的 PR 是 ${task.pr ?? "空"}，不是 ${req.pr}` };
    if (task.headSHA !== req.head) {
      return { ok: false, reason: `台账 head 是 ${task.headSHA?.slice(0, 12) ?? "空"}，不是 ${req.head.slice(0, 12)}：head 动过要先 \`ledger main-carry\`（mainCarry=on）写正式沿用；observe / off 不授权合并` };
    }
    const gate = reviewGate(db, task, now);
    return { ok: true, auth: { taskId: task.id, head: req.head, base: gate.review.head, reviewSeq: gate.review.eventSeq, carries: gate.carries.length, sourceKind: gate.sourceKind } };
  } catch (e) {
    if (e instanceof LedgerError) return { ok: false, reason: `台账合并门：${e.message}` };
    return { ok: false, reason: `台账合并门读取失败：${(e as Error).message.slice(0, 200)}` };
  }
}
