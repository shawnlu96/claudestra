/** One predicate for lease-end writers and the scheduler repair path; an ended lease alone never proves a peer stopped. */
import type { Database } from "bun:sqlite";
import { lendAuthorLease, lendAuthorBinding, lendAuthorBasis, lendAuthorOrders } from "./lend-author-retire-state.js";
export { lendAuthorBasis, lendAuthorOrders } from "./lend-author-retire-state.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import type { SchedulerSession } from "./scheduler-sessions.js";

export interface LendAuthorFence { taskId: string; rev: number; specRev: number; head: string | null; sessionId: string }
export interface LendAuthorSample extends LendAuthorFence { basis: string; heads: { repo: string; branch: string; head: string | null }[] }
export const lendAuthorFence = (t: LedgerTask, s: SchedulerSession): LendAuthorFence =>
  ({ taskId: t.id, rev: t.rev, specRev: t.specRev, head: t.headSHA, sessionId: s.sessionId });

type Proof = { ok: true; task: LedgerTask; binding: SchedulerSession; peer: string } | { ok: false; reason: string };
export function proveLendAuthorRetire(db: Database, f: LendAuthorSample, observe = false): Proof {
  const no = (reason: string): Proof => ({ ok: false, reason });
  const task = getTask(db, f.taskId), s = lendAuthorBinding(db, f.taskId);
  if (!task || task.rev !== f.rev || task.specRev !== f.specRev || task.headSHA !== f.head) return no("task rev/specRev/head 漂移");
  if (f.basis !== lendAuthorBasis(db, f.taskId)) return no("lease/order 栅栏漂移");
  if (!s || s.role !== "author" || s.transport !== "peer" || s.state === "retired" || s.sessionId !== f.sessionId) return no("peer 作者绑定不符或已退役");
  const orders = lendAuthorOrders(db, task.id), lease = lendAuthorLease(db, task.id);
  const matched = orders.filter(o => o.worker && `${o.worker}@${o.peer}` === s.agent);
  if (!matched.length) return no("作者与写单 worker@peer 不对应");
  if (!lease || lease.state !== "ended") return no(`写租约不是 ended（${lease?.state ?? "missing"}）`);
  if (!matched.some(o => o.peer === lease.peer && o.repo === lease.repo && o.branch === lease.branch)) return no("作者写单与 ended 租约不对应");
  const live = orders.find(o => ["pooled", "claimed", "unknown"].includes(o.status));
  if (live) return no(`仍有 ${live.status} 写单 ${live.orderId}`);
  if (!observe) {
    for (const o of orders.filter(o => o.status === "cancelled" && o.leaseGen > 0)) {
      const sample = f.heads.find(h => h.repo === o.repo && h.branch === o.branch);
      if (!task.headSHA || !sample?.head) return no(`blocked：读不到已 claimed 取消单 ${o.orderId} 的远端 head`);
      if (sample.head !== task.headSHA) return no(`blocked：取消单 ${o.orderId} 远端 head 与台账不一致`);
    }
  }
  return { ok: true, task, binding: s, peer: lease.peer };
}
