/**
 * 「今天 · 团队与额度」机器行的纯计算（XMACH1，tests/web-now-machines-model.test.ts）：伙伴机器在线数、借出在跑 / 借入在跑的单数与其中停住的。
 * 停住不另写判断：借出按 lend-model.orderPhase 的 stuck（收回后还 live 超过 STUCK_MS），借入按远端行现有的状态含义（unknown = 待 PM）与 leaseUntil 过期。
 * 今天页没有点过「收回」，停止起点由观察补：live、但这个 peer 已不在授权列表里（已收回）的单，从今天页头一次看到它已收回的时刻算起
 * （observeStopping）。不拿 updatedAt 倒推：续租也刷它，收回前那次更新会把刚收回的单提前报成停住。观察时刻不早于真实收回，只会晚报、不会早报。
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

/**
 * 记下今天页看到的停止起点（orderId → 头一次看到「live 且授权已不在」的时刻 at）。已记的保留原起点；
 * 不再 live、或授权又回来了的单清掉。没变化时原样返回 seen（调用方拿引用比较，不多渲染一次）。
 */
export function observeStopping(seen: ReadonlyMap<string, number>, lend: Pick<LendInput, "data" | "orders">, at: number): ReadonlyMap<string, number> {
  if (!lend.data) return seen;
  const granted = new Set(lend.data.grants.map((g) => g.peer));
  const next = new Map<string, number>();
  for (const o of lend.orders) if (isLive(o) && !granted.has(o.peer)) next.set(o.orderId, seen.get(o.orderId) ?? at);
  return next.size === seen.size && [...next].every(([k, v]) => seen.get(k) === v) ? seen : next;
}

/** 停止起点：useLendState 自己记下的（本页点过收回才有）优先，其余用今天页观察到的（observeStopping） */
export function lendStopping(lend: LendInput, seen: ReadonlyMap<string, number> = new Map()): Map<string, number> {
  const next = new Map(lend.stopping);
  for (const [id, at] of seen) if (!next.has(id)) next.set(id, at);
  return next;
}

export function lentLine(lend: LendInput, seen?: ReadonlyMap<string, number>): LentLine | null {
  if (!lend.data) return null;
  const orders = lend.orders.filter(isLive);
  if (!orders.length) return null;
  const stopping = lendStopping(lend, seen);
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
export function machinesView(peers: PeerOnline | null, lend: LendInput, borrow: BorrowInput, seen?: ReadonlyMap<string, number>): MachinesView | null {
  if (!peers || !peers.total) return null;
  if (lend.data === null && borrow.hidden) return null;
  return { peers, lent: lentLine(lend, seen), borrowed: borrowedLine(borrow) };
}
