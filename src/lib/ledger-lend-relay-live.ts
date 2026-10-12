/**
 * dispatch-recovery-LRELAY2：relay 段领取前的有效性判定。relayLive 是纯函数（订单、任务、写租约三行进，有效 / 失效 + 原因出）；
 * staleRelays 在调用方的事务里逐单读这三行、列出失效单上 pending 的段（只读）；记 dropped（零发送）在 ledger-lend-relay.ts。
 * 写 / 修单的段只看单还 claimed；本机作者说明（note）还要卡在进行中、出借关系仍是这一单。tests/ledger-lend-relay-live.test.ts。
 */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { explicitLocal, pinnedPeer } from "./scheduler-local-pin.js";

export interface LiveOrder { orderId: string; peer: string; status: string; branch: string | null }
export type LiveTask = Pick<LedgerTask, "stage" | "assigneeKind" | "assignee" | "extra">;
export interface LiveLease { peer: string; fp: string; branch: string; state: string }
export type RelayLiveness = { live: true } | { live: false; reason: string };

/** 卡走到这些阶段，借出去的这一单就没有意义了 */
const OVER_STAGES = ["cancelled", "verified", "done"];
const GONE = "单已不在对方手里（交付 / 撤销 / 过期 / 被替换）";

/** kind = 段的种类；note 是本机作者说明，其他是转给出借 worker 的写 / 修单补充 */
export function relayLive(kind: string, order: LiveOrder | null, task: LiveTask | null, lease: LiveLease | null): RelayLiveness {
  const dead = (reason: string): RelayLiveness => ({ live: false, reason });
  if (!order) return dead(`${GONE}：查无此单`);
  if (kind !== "note") return order.status === "claimed" ? { live: true } : dead(GONE);
  if (order.status !== "pooled" && order.status !== "claimed") return dead(GONE);
  if (!task) return dead("卡已不在台账里");
  if (OVER_STAGES.includes(task.stage)) return dead(`卡已 ${task.stage}`);
  if (lease?.state === "held") {
    if (lease.peer !== order.peer) return dead(`写租约已换到 ${lease.peer}`);
    if (order.branch && lease.branch !== order.branch) return dead(`写租约已换代（${lease.branch}，这一单是 ${order.branch}）`);
    if (task.assigneeKind === "peer_agent" && !task.assignee?.startsWith(`${lease.fp}/`)) return dead("卡上的指派已换到别的实例");
  }
  if (explicitLocal(task.extra)) return dead("卡已钉在本机");
  const pin = pinnedPeer(task.extra?.placement);
  if (pin && pin !== order.peer) return dead(`卡已钉到 ${pin}`);
  return { live: true };
}

const hasTable = (db: Database, name: string): boolean => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

export interface StaleRelay { orderId: string; kind: string; reason: string }

/** 只读：pending 段按（单，kind）判一次，返回失效的那些；记 dropped 由调用方在同一事务里做（ledger-lend-relay.ts dropStale） */
export function staleRelays(db: Database): StaleRelay[] {
  const leases = hasTable(db, "lend_write_leases");
  const pending = db.query("SELECT DISTINCT orderId, taskId, kind FROM lend_relays WHERE state = 'pending'").all() as { orderId: string; taskId: string; kind: string }[];
  const orderQ = db.query("SELECT orderId, peer, status, branch FROM lend_orders WHERE orderId = ?");
  const leaseQ = leases ? db.query("SELECT peer, fp, branch, state FROM lend_write_leases WHERE taskId = ?") : null;
  const out: StaleRelay[] = [];
  for (const r of pending) {
    const order = orderQ.get(r.orderId) as LiveOrder | null;
    const verdict = relayLive(r.kind, order, r.kind === "note" ? getTask(db, r.taskId) : null, (leaseQ?.get(r.taskId) as LiveLease | null) ?? null);
    if (!verdict.live) out.push({ orderId: r.orderId, kind: r.kind, reason: verdict.reason });
  }
  return out;
}
