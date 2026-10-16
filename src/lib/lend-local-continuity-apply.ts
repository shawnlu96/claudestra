/**
 * i28-STALELEASE1 · staleLeaseHandover's transaction (`ledger scheduler-fix-relay --op stale-lease-handover`, scheduler identity only):
 * the stale write lease ends and the card's own local author keeps the fix. CAS on the task rev, the switch read again (on), every
 * condition of lend-local-continuity.ts re-read here, the session and lease generation the tick assessed must still be the ones.
 * Writes: endWriteLease (reason 「本机原作者接手：<agent>」), the card's `peer:<lease holder>` pin dropped (only that one, only from
 * extra.placement), the task rev moved (a plan made on the leased snapshot is refused), one dedup event. Never touched: task.agent,
 * the assignee, the author session row, the lender's side. A replay with the same evidence returns the recorded event.
 * tests/lend-local-continuity-apply.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { endWriteLease } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { continuityCheck, STALE_LEASE_KEY, STALE_LEASE_OP, staleLeaseMode } from "./lend-local-continuity.js";

export interface StaleLeaseInput { taskId: string; rev: number; sessionId: string; leaseAt: number }

/** One handover per card and lease generation. */
export const staleLeaseKey = (taskId: string, leaseAt: number): string => `scheduler:stale-lease-handover:${taskId}:${leaseAt}`;

export function applyStaleLeaseHandover(db: Database, ctx: WriteCtx, input: StaleLeaseInput): { duplicate: boolean; seq: number; peer: string; agent: string } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "结束旧写租约、交本机原作者只由调度服务记账");
  if (!Number.isInteger(input.rev) || !Number.isFinite(input.leaseAt)) throw new LedgerError("invalid", "--rev / --lease-at 要是数字");
  return tx(db, () => {
    const task = mustTask(db, input.taskId), key = staleLeaseKey(task.id, input.leaseAt);
    const prior = getEventByDedup(db, key);
    if (prior) {
      if (prior.target !== task.id || prior.data.sessionId !== input.sessionId) throw new LedgerError("dedup_mismatch", "这次交接已按另一组证据记过");
      return { duplicate: true, seq: prior.seq, peer: String(prior.data.peer), agent: String(prior.data.agent) };
    }
    if (task.rev !== input.rev) throw new LedgerError("conflict", "卡在评估之后变了，下一轮重算");
    if (staleLeaseMode(db, task.project) !== "on") throw new LedgerError("conflict", `${STALE_LEASE_KEY} 已不是 on，不结束租约`);
    const c = continuityCheck(db, task);
    if (!c.ok) throw new LedgerError("conflict", `本机原作者连续不再成立：${c.why}`);
    const ev = c.evidence;
    if (ev.sessionId !== input.sessionId || ev.leaseAt !== input.leaseAt) throw new LedgerError("conflict", "作者会话或写租约代次已变，下一轮重算");
    const now = ctx.now ?? Date.now();
    if (!endWriteLease(db, task.id, `本机原作者接手：${ev.agent}`, now)) throw new LedgerError("conflict", "写租约已不是 held");
    const moved = db.prepare("UPDATE tasks SET extra = ?, rev = rev + 1, updatedAt = ? WHERE id = ? AND rev = ?")
      .run(JSON.stringify(withoutPin(task, ev.peer)), now, task.id, task.rev).changes;
    if (moved !== 1) throw new LedgerError("conflict", "卡在事务里变了，下一轮重算");
    const e = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `本机原作者接手：结束 ${ev.peer} 的写租约（${ev.leaseBranch}，卡已在 ${ev.branch}），修复派回原会话 ${ev.agent}` +
        `${ev.unpin ? `；解除钉位 peer:${ev.peer}` : ""}`,
      data: { op: STALE_LEASE_OP, mechanism: STALE_LEASE_KEY, ...ev } }, true);
    return { duplicate: false, seq: e.seq, peer: ev.peer, agent: ev.agent };
  });
}

/** extra without the lease holder's pin; any other key (another pin included) stays as it is. */
function withoutPin(task: LedgerTask, peer: string): Record<string, unknown> {
  return task.extra.placement === `peer:${peer}` ? Object.fromEntries(Object.entries(task.extra).filter(([k]) => k !== "placement")) : task.extra;
}

/** The CLI half (lend-fix-reassign-tick.ts fixRelayCommand): flags in, the transaction's answer out. */
export function staleLeaseCommand(c: { db: Database; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask; p: { pos: string[] } }) {
  const task = c.task(c.p.pos[1]);
  return applyStaleLeaseHandover(c.db, c.ctx(), { taskId: task.id, rev: Number(c.need("rev")), sessionId: c.need("session"), leaseAt: Number(c.need("lease-at")) });
}
