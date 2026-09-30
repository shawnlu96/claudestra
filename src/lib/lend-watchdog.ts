/**
 * 出借 worker 的自停兜底：租约截止由 scheduler 服务的 lend 循环执行（lend-drive.ts heartbeat），但服务本身挂了、被停了就没人执行。
 * 所以出借 worker 的 ACP 宿主（src/acp-host.ts，只在干净环境模式下）每 30 秒只读地看一眼 journal：这个 worker 的单已结束、
 * 或者过了租约截止再宽限一分钟还没续上，宿主就自己收尾退出（带走适配器和 codex）。journal 读不了也按该停处理（fail-closed）。
 * tests/lend-watchdog.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEASED_STATES, LEND_JOURNAL_PATH, type LendState } from "./lend-journal.js";

/** 正常情况下服务在截止时刻就停了 worker；宽限只给服务收尾留时间，不是延长租约 */
export const WATCHDOG_GRACE_MS = 60_000;
export const WATCHDOG_EVERY_MS = 30_000;

/** 该不该停；null = 接着跑 */
export function lendStopReason(agent: string, path = LEND_JOURNAL_PATH, now = Date.now()): string | null {
  if (!existsSync(path)) return "出借 journal 不在";
  let row: { state: LendState; leaseUntil: number | null } | null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      row = db.query("SELECT state, leaseUntil FROM lend_orders WHERE agent = ? ORDER BY createdAt DESC LIMIT 1").get(agent) as typeof row;
    } finally { db.close(); }
  } catch (e) {
    return `读不了出借 journal：${(e as Error).message}`;
  }
  if (!row) return "journal 里没有这个 worker 的单";
  if (!LEASED_STATES.includes(row.state)) return `这张单已结束（${row.state}）`;
  if (row.leaseUntil !== null && now > row.leaseUntil + WATCHDOG_GRACE_MS) return "心跳过期：租约截止后一直没续上";
  return null;
}
