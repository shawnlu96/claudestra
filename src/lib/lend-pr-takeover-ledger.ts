/**
 * 借入方 A 接管一张出借开工单的交付（i28-PUB1）：出借方 B 已把提交推到订单分支、却一直停在 publishing（开不出 PR / 交付发不回来）时，
 * 调度服务（lend-pr-takeover.ts）核过条件后调 `ledger lend-takeover`，这里在一个事务里把交付记到卡上，口径同 ledger-lend-result.ts writeLendDeliver：
 * 卡的分支 = 出借分支、PR = 分支上开着的 PR、head = 远端分支 head，deliver 事件后以 `peer:<名>`（这一步绑的执行者）推 build → review。
 * 出借单记成 done、eventSeq = 这条 deliver（不记 cancelled）：remoteHeadFamily 认它定作者家族（审查照旧跨模型），池同步把写节点意图结成 done，
 * 这一步照旧对旧 peer-ledger 门藏着。没有 resultSha / 回执，B 之后交来的结论按 check 拒（这一单已撤销），续租 / beat 回 done，B 收尾停单。
 * 写租约不动：修复单带着 PR 号，B 那边不调 gh，照常派回原出借方。tests/lend-pr-takeover.test.ts。
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { cardMoved, getLendOrder, type LendOrder } from "./ledger-lend.js";
import { LedgerError } from "./ledger-store.js";
import { stepsOf } from "./ledger-steps.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { deliver, moveStage, setTask } from "./ledger-write.js";
import type { RemoteHead } from "./order-deliver.js";

export interface TakeoverInput { orderId: string; head: string; pr: number }
export interface TakeoverDeps {
  /** 远端（GitHub；lab 是本地 bare 仓库）上这个分支此刻的 head，CLI 自己查，不信调用方 */
  remoteHead(repo: string, branch: string): Promise<RemoteHead>;
}
export interface TakeoverResult { orderId: string; taskId: string; head: string; pr: string; eventSeq: number; duplicate: boolean }

/** 出借单 reason 的开头：认出「这一单是 A 接管结掉的」（幂等重放、协作视图） */
const TAKEOVER_REASON = "借入方接管交付";
const SHA40 = /^[0-9a-f]{40}$/;

const prUrl = (o: Pick<LendOrder, "repo">, pr: number): string => `https://github.com/${o.repo}/pull/${pr}`;

/** 事务内外同一套核对：单仍归出借方在做（claimed、租约没过）、是开工单、卡还停在这一单的 build、这一步仍绑着它的 worker */
function check(db: Database, o: LendOrder | null, input: TakeoverInput, now: number): LendOrder {
  if (!o) throw new LedgerError("not_found", `没有出借单 ${input.orderId}`);
  if (o.step !== "write" || !o.branch || !o.base || o.pr !== null) throw new LedgerError("invalid", "只接管开工单（修复单本来就有 PR，不代开）");
  if (o.status !== "claimed" || !o.worker) throw new LedgerError("conflict", `出借单已不在出借方手里（${o.status}），不接管`);
  if ((o.leaseUntil ?? 0) < now) throw new LedgerError("conflict", "出借单租约已过期，按过期交 PM，不接管");
  if (!SHA40.test(input.head) || input.head === o.head) throw new LedgerError("invalid", "接管的 head 不是新的完整 SHA");
  if (!Number.isInteger(input.pr) || input.pr < 1) throw new LedgerError("invalid", "PR 号不合格");
  const task = mustTask(db, o.taskId);
  if (cardMoved(task, o)) throw new LedgerError("conflict", `卡已不在这一单的开工阶段 / 轮次（现在 ${task.stage}），不接管`);
  const own = stepsOf(db, task).find((s) => !s.derived && s.step === o.step && s.round === o.round && s.executorKind === "peer" && s.executor === `${o.worker}@${o.peer}`);
  if (!own || own.state !== "assigned") throw new LedgerError("conflict", "这一步已不再绑定这一单（换了人或已交付过）");
  return o;
}

/** 已由本机接管结掉的同一单、同一 head：原样回结果，不写第二遍 */
function replayed(db: Database, o: LendOrder | null, input: TakeoverInput): TakeoverResult | null {
  if (!o || o.status !== "done" || !o.reason?.startsWith(TAKEOVER_REASON) || o.eventSeq === null) return null;
  if (mustTask(db, o.taskId).headSHA !== input.head) throw new LedgerError("conflict", `出借单 ${o.orderId} 已按另一个 head 接管过`);
  return { orderId: o.orderId, taskId: o.taskId, head: input.head, pr: prUrl(o, input.pr), eventSeq: o.eventSeq, duplicate: true };
}

export async function takeoverLend(db: Database, ctx: WriteCtx, input: TakeoverInput, deps: TakeoverDeps): Promise<TakeoverResult> {
  const first = getLendOrder(db, input.orderId);
  const dup = replayed(db, first, input);
  if (dup) return dup;
  const clock = () => ctx.now ?? Date.now();
  const o = check(db, first, input, clock());
  const rev = mustTask(db, o.taskId).rev;
  const remote = await deps.remoteHead(o.repo, o.branch as string);
  if (!remote.ok) throw new LedgerError("conflict", `查不到远端分支 ${o.branch} 的 head（${remote.error}），下轮再接管`);
  if (remote.head !== input.head) throw new LedgerError("conflict", `远端 ${o.branch} 的 head 是 ${remote.head.slice(0, 12)}，不是 ${input.head.slice(0, 12)}：分支还在动，不接管`);
  return tx(db, () => {
    const now = clock();
    const again = getLendOrder(db, input.orderId);
    const late = replayed(db, again, input);
    if (late) return late;
    const cur = check(db, again, input, now);
    const task = mustTask(db, cur.taskId);
    if (task.rev !== rev) throw new LedgerError("conflict", "核对远端期间卡被改过，下轮重新核对再接管");
    const pr = prUrl(cur, input.pr);
    const why = `${TAKEOVER_REASON}：出借方 ${cur.peer} 已推送 ${cur.branch}，交付通道一直停在 publishing`;
    if (task.branch !== cur.branch) setTask(db, { actor: ctx.actor, now }, { id: task.id, rev, patch: { branch: cur.branch } });
    const text = `出借方交付通道失败，借入方按已推送分支接管（${cur.peer}，单号 ${cur.orderId}）；摘要见 PR / 提交记录`;
    const r = deliver(db, { actor: ctx.actor, now, dedupKey: `lend-takeover-deliver:${cur.orderId}:${input.head}` },
      { taskId: task.id, headSHA: input.head, evidence: pr, pr, text });
    // 推阶段按这一步绑的跨实例执行者（同 writeLendDeliver）：调度身份自己不是这张卡的执行者
    moveStage(db, { actor: `peer:${cur.peer}`, now, dedupKey: `lend-takeover-stage:${cur.orderId}:${input.head}` }, { taskId: task.id, from: task.stage, to: "review" });
    const eventSeq = r.event.seq;
    db.prepare("UPDATE lend_orders SET status = 'done', reason = ?, eventSeq = ?, updatedAt = ? WHERE orderId = ? AND status = 'claimed'").run(why, eventSeq, now, cur.orderId);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `lend-takeover:${cur.orderId}` }, { project: cur.project, target: cur.taskId, kind: "note",
      text: `出借：${why}，按 ${pr} 记交付（head ${input.head.slice(0, 12)}），之后出借方交来的结论不入账`,
      data: { lend: { orderId: cur.orderId, peer: cur.peer, op: "takeover", branch: cur.branch, head: input.head, pr } } }, true); // 主事件：去重键落库，同一单接管不了第二次
    return { orderId: cur.orderId, taskId: cur.taskId, head: input.head, pr, eventSeq, duplicate: false };
  });
}
