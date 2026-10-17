/**
 * 发给 peer 上出借 worker 的消息先在本机看台账（peer-PEERGONE1）：worker 的单都已结束时对方早把它回收、移出 token scope，
 * 发出去只会拿回一个 403，不如本机直接说清楚。判定 lendTargetRefusal 是纯函数；查库 lendOrdersOfWorker 只读打开台账。
 * 没有记录 / 查库失败一律照常发（http-peer.ts 只把原因写进日志）。tests/peer-lend-target.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEDGER_PATH } from "./ledger-store.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";

/** 出借 worker 的名字，带不带 agent- 前缀都认（lend-drive.ts 发的是 agent-lend-<10 hex>） */
const LEND_TARGET_RE = /^(?:agent-)?lend-[0-9a-z]+$/;

export interface LendOrderState { status: string; updatedAt: number }

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "时间未知";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 目标是出借 worker、台账里有它的单、且没有一条还活着（pooled / claimed / unknown）→ 给调用方的一句话；否则 null（照常发）。
 * orders 是这个 worker 的全部订单，顺序不限，取 updatedAt 最新的一条报状态
 */
export function lendTargetRefusal(target: string, orders: readonly LendOrderState[]): string | null {
  if (!LEND_TARGET_RE.test(target) || !orders.length) return null;
  if (orders.some((o) => (LEND_LIVE as readonly string[]).includes(o.status))) return null;
  const last = orders.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const name = target.startsWith("agent-") ? target : `agent-${target}`;
  return `出借 worker ${name} 的单已结束（${last.status} ${fmtTime(last.updatedAt)}），对方已回收；要补充的内容写进规格，下一张单会带上`;
}

/** 台账里 worker 是这个名字（带 / 不带 agent- 前缀）的全部订单；不是出借 worker 名不查库。台账不在 / 没有 lend_orders 表返回空，其余读错抛出 */
export function lendOrdersOfWorker(target: string, path = LEDGER_PATH): LendOrderState[] {
  if (!LEND_TARGET_RE.test(target) || !existsSync(path)) return [];
  const bare = target.replace(/^agent-/, "");
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return [];
    return db.query("SELECT status, updatedAt FROM lend_orders WHERE worker IN (?, ?)").all(bare, `agent-${bare}`) as LendOrderState[];
  } finally {
    db.close();
  }
}
