/**
 * 出借 worker 的自停兜底：租约截止由 scheduler 服务的 lend 循环执行（lend-drive.ts heartbeat），但服务本身挂了、被停了就没人执行。
 * 所以出借 worker 的 ACP 宿主（src/acp-host.ts，只在干净环境模式下）每 30 秒只读地看一眼 journal：这个 worker 的单已结束、
 * 或者过了租约截止再宽限一分钟还没续上，宿主就自己收尾退出（带走适配器和 codex）。journal 读不了也按该停处理（fail-closed），
 * 但要连续 UNREADABLE_LIMIT 次：调度服务每轮开关 journal，零等待的只读查询会偶发 SQLITE_BUSY（lab 实测约 2%），一次就停曾打断正在审查的 worker
 * （i28-R5a，ledger/reviews/i28-R5a-rootcause.md）。tests/lend-watchdog.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEASED_STATES, LEND_JOURNAL_PATH, type LendState } from "./lend-journal.js";

/** 正常情况下服务在截止时刻就停了 worker；宽限只给服务收尾留时间，不是延长租约 */
export const WATCHDOG_GRACE_MS = 60_000;
export const WATCHDOG_EVERY_MS = 30_000;
/** 读不了 journal 连续这么多次（每次隔 WATCHDOG_EVERY_MS）才按该停处理 */
export const UNREADABLE_LIMIT = 2;
/** 只读连接等写方放锁的上限（调度服务关 journal 时 checkpoint 要独占）；设了之后 lab 实测 0 失败 */
const READ_BUSY_MS = 2_000;

type Check = { why: string; unreadable: boolean } | null;

function check(agent: string, path: string, now: number): Check {
  if (!existsSync(path)) return { why: "出借 journal 不在", unreadable: false };
  let row: { state: LendState; leaseUntil: number | null } | null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${READ_BUSY_MS}`);
      row = db.query("SELECT state, leaseUntil FROM lend_orders WHERE agent = ? ORDER BY createdAt DESC LIMIT 1").get(agent) as typeof row;
    } finally { db.close(); }
  } catch (e) {
    return { why: `读不了出借 journal：${(e as Error).message}`, unreadable: true };
  }
  if (!row) return { why: "journal 里没有这个 worker 的单", unreadable: false };
  if (!LEASED_STATES.includes(row.state)) return { why: `这张单已结束（${row.state}）`, unreadable: false };
  if (row.leaseUntil !== null && now > row.leaseUntil + WATCHDOG_GRACE_MS) return { why: "心跳过期：租约截止后一直没续上", unreadable: false };
  return null;
}

/** 单次检查：该不该停；null = 接着跑（读不了也返回原因，要不要停由 lendWatchdog 数次数） */
export function lendStopReason(agent: string, path = LEND_JOURNAL_PATH, now = Date.now()): string | null {
  return check(agent, path, now)?.why ?? null;
}

/** 宿主每 WATCHDOG_EVERY_MS 调一次：定性的该停立即停；读不了要连续 UNREADABLE_LIMIT 次，中间读到一次就清零 */
export function lendWatchdog(agent: string, log: (m: string) => void, path = LEND_JOURNAL_PATH): (now?: number) => string | null {
  let unreadable = 0;
  return (now = Date.now()) => {
    const r = check(agent, path, now);
    if (!r || !r.unreadable) return (unreadable = 0), r?.why ?? null;
    if (++unreadable >= UNREADABLE_LIMIT) return r.why;
    log(`出借 journal 这次没读到（${r.why}），${WATCHDOG_EVERY_MS / 1000} 秒后再看，连续 ${UNREADABLE_LIMIT} 次读不到才自停`);
    return null;
  };
}
