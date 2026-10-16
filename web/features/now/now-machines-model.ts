/**
 * 「今天 · 团队与额度」机器行的纯计算（XMACH1，tests/web-now-machines-model.test.ts）：伙伴机器在线数、借出在跑 / 借入在跑的单数与其中停住的。
 * 停住不另写判断：借出按 lend-model.orderPhase 的 stuck（收回后还 live 超过 STUCK_MS），借入按远端行现有的状态含义（unknown = 待 PM）与 leaseUntil 过期。
 * 今天页没有点过「收回」，停止起点由数据补：live、但这个 peer 已不在授权列表里（已收回）的单，从它最后一次更新算起。
 * 不 import React。
 */
import type { BorrowView, RemoteRow } from "../borrow/borrow-api";
import { isLive, orderPhase, type LendData, type OrderView } from "../lend/lend-model";

export interface PeerOnline { online: number; total: number }
/** useLendState 那几样：data undefined = 还没拉到，null = 403 / 404 */
export interface LendInput { data: LendData | null | undefined; orders: readonly OrderView[]; stopping: ReadonlyMap<string, number>; now: number }
/** useBorrowView 那几样：hidden = 403 / 404；view null 且没 hidden = 还没拉到 */
export interface BorrowInput { view: BorrowView | null; hidden: boolean }

export interface LentLine { orders: OrderView[]; stopping: Map<string, number>; stuck: number; now: number }
export interface BorrowedLine { rows: RemoteRow[]; stuck: number }
export interface MachinesView { peers: PeerOnline; lent: LentLine | null; borrowed: BorrowedLine | null }

/** 停止起点：useLendState 自己记下的（本页点过收回才有）优先；其余 live、授权已不在的单按 updatedAt */
export function lendStopping(lend: LendInput): Map<string, number> {
  const next = new Map(lend.stopping);
  const granted = new Set((lend.data?.grants ?? []).map((g) => g.peer));
  for (const o of lend.orders) if (isLive(o) && !granted.has(o.peer) && !next.has(o.orderId)) next.set(o.orderId, o.updatedAt);
  return next;
}

export function lentLine(lend: LendInput): LentLine | null {
  if (!lend.data) return null;
  const orders = lend.orders.filter(isLive);
  if (!orders.length) return null;
  const stopping = lendStopping(lend);
  return { orders, stopping, now: lend.now, stuck: orders.filter((o) => orderPhase(o, stopping, lend.now) === "stuck").length };
}

/** 远端一单停住：待 PM（unknown），或租约已过 */
export const remoteStuck = (r: Pick<RemoteRow, "status" | "leaseUntil">, now: number): boolean =>
  r.status === "unknown" || (r.leaseUntil !== null && r.leaseUntil <= now);

export function borrowedLine(borrow: BorrowInput): BorrowedLine | null {
  const v = borrow.view;
  if (borrow.hidden || !v || !v.remote.length) return null;
  return { rows: v.remote, stuck: v.remote.filter((r) => remoteStuck(r, v.now)).length };
}

/** 借入里此刻真在别的机器上跑的单（claimed）：算进「N 个 agent 在干活」 */
export const remoteRunning = (v: Pick<BorrowView, "remote"> | null | undefined): number => (v?.remote ?? []).filter((r) => r.status === "claimed").length;

/**
 * 整段：没有伙伴机器 → null；借出、借入两头都 403 / 404（非 owner、老 bridge）→ null。
 * 某一类 0 单（或还没拉到）那一行是 null，不出。
 */
export function machinesView(peers: PeerOnline | null, lend: LendInput, borrow: BorrowInput): MachinesView | null {
  if (!peers || !peers.total) return null;
  if (lend.data === null && borrow.hidden) return null;
  return { peers, lent: lentLine(lend), borrowed: borrowedLine(borrow) };
}
