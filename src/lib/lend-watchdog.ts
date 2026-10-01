/**
 * 出借 worker 的自停兜底：租约截止由 scheduler 服务的 lend 循环执行（lend-drive.ts heartbeat），但服务本身挂了、被停了就没人执行。
 * 所以出借 worker 的 ACP 宿主（src/acp-host.ts，只在干净环境模式下）每 30 秒只读地看一眼 journal：这个 worker 的单已结束、
 * 或者过了租约截止再宽限一分钟还没续上，宿主就自己收尾退出（带走适配器和 codex）。journal 读不了也按该停处理（fail-closed），
 * 但要连续 UNREADABLE_LIMIT 次：调度服务每轮开关 journal，零等待的只读查询会偶发 SQLITE_BUSY（lab 实测约 2%），一次就停曾打断正在审查的 worker
 * （i28-R5a，ledger/reviews/i28-R5a-rootcause.md）。授权也在这里核（i28-W1）：lend.json 里这张单 peer 的授权没了、暂停、过期、指纹变了，
 * 这张单的仓库 / 角色 / 家族被拿掉，或文件不在 / 无效，都立即该停——调度服务停着时，收回授权要靠这一处在一个检查周期内停掉 worker。tests/lend-watchdog.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { LEASED_STATES, LEND_JOURNAL_PATH, type LendState } from "./lend-journal.js";
import { LEND_PATH, readLendSync } from "./lend-config.js";
import { grantProblem, scopeProblem, type OrderScope } from "./lend-grant-rules.js";

/** 正常情况下服务在截止时刻就停了 worker；宽限只给服务收尾留时间，不是延长租约 */
export const WATCHDOG_GRACE_MS = 60_000;
export const WATCHDOG_EVERY_MS = 30_000;
/** 读不了 journal 连续这么多次（每次隔 WATCHDOG_EVERY_MS）才按该停处理 */
export const UNREADABLE_LIMIT = 2;
/** 只读连接等写方放锁的上限（调度服务关 journal 时 checkpoint 要独占）；设了之后 lab 实测 0 失败 */
const READ_BUSY_MS = 2_000;

type Check = { why: string; unreadable: boolean } | null;

/** 只读 lend.json（不读 peers.json）：授权条目在、有效、指纹和领单时一致、这张单的仓库 / 角色 / 家族仍在授权里才接着跑 */
function grantGone(peer: string, fp: string | null, scope: OrderScope, lendPath: string, now: number): string | null {
  const read = readLendSync(lendPath);
  if (read.status !== "ok") return read.status === "missing" ? "lend.json 不在：没有出借授权" : `lend.json 无效：${read.error}`;
  const e = read.file.enabled ? read.file.lend.find((x) => x.peer === peer) : undefined;
  if (!e) return `对 ${peer} 的出借授权已收回`;
  const bad = grantProblem(e, now) ?? (fp && e.fp !== fp ? `${peer} 的实例指纹变了` : null) ?? scopeProblem(e, scope);
  return bad ? `出借授权失效：${bad}` : null;
}

function check(agent: string, path: string, now: number, lendPath: string): Check {
  if (!existsSync(path)) return { why: "出借 journal 不在", unreadable: false };
  let row: { state: LendState; leaseUntil: number | null; peer: string; fp: string | null; family: string; preview: string } | null;
  let p: Record<string, unknown> = {};
  try {
    const db = new Database(path, { readonly: true });
    try {
      db.exec(`PRAGMA busy_timeout = ${READ_BUSY_MS}`);
      row = db.query("SELECT state, leaseUntil, peer, fp, family, preview FROM lend_orders WHERE agent = ? ORDER BY createdAt DESC LIMIT 1").get(agent) as typeof row;
      if (row) p = JSON.parse(row.preview) as Record<string, unknown>; // 坏的摘要和读不了一样处理（fail-closed）
    } finally { db.close(); }
  } catch (e) {
    return { why: `读不了出借 journal：${(e as Error).message}`, unreadable: true };
  }
  if (!row) return { why: "journal 里没有这个 worker 的单", unreadable: false };
  if (!LEASED_STATES.includes(row.state)) return { why: `这张单已结束（${row.state}）`, unreadable: false };
  if (row.leaseUntil !== null && now > row.leaseUntil + WATCHDOG_GRACE_MS) return { why: "心跳过期：租约截止后一直没续上", unreadable: false };
  const gone = grantGone(row.peer, row.fp, { repo: String(p.repo ?? ""), step: String(p.step ?? ""), family: row.family }, lendPath, now);
  return gone ? { why: gone, unreadable: false } : null;
}

/** 单次检查：该不该停；null = 接着跑（读不了也返回原因，要不要停由 lendWatchdog 数次数） */
export function lendStopReason(agent: string, path = LEND_JOURNAL_PATH, now = Date.now(), lendPath = LEND_PATH): string | null {
  return check(agent, path, now, lendPath)?.why ?? null;
}

/** 宿主每 WATCHDOG_EVERY_MS 调一次：定性的该停立即停；读不了要连续 UNREADABLE_LIMIT 次，中间读到一次就清零 */
export function lendWatchdog(agent: string, log: (m: string) => void, path = LEND_JOURNAL_PATH, lendPath = LEND_PATH): (now?: number) => string | null {
  let unreadable = 0;
  return (now = Date.now()) => {
    const r = check(agent, path, now, lendPath);
    if (!r || !r.unreadable) return (unreadable = 0), r?.why ?? null;
    if (++unreadable >= UNREADABLE_LIMIT) return r.why;
    log(`出借 journal 这次没读到（${r.why}），${WATCHDOG_EVERY_MS / 1000} 秒后再看，连续 ${UNREADABLE_LIMIT} 次读不到才自停`);
    return null;
  };
}

/**
 * 出借 worker 的宿主每次起适配器（真正开始执行外来任务的那一下，含崩溃后重起）之前同步核一次：单还活着、授权仍在且覆盖这张单。
 * 核完到 spawn 之间没有 await——调度服务那道闸门之后 manager 子进程还要拿写锁、建频道才起宿主，收回落在那段里也只能在这里拦住。
 * 没过就不起，交给 onBlocked（宿主退出）。src/acp-host.ts 接线；tests/lend-watchdog.test.ts。
 */
export function lendGatedSpawn<A extends unknown[], R>(agent: string, spawn: (...a: A) => R, onBlocked: (why: string) => never,
  path = LEND_JOURNAL_PATH, lendPath = LEND_PATH, clock: () => number = Date.now): (...a: A) => R {
  return (...a) => {
    const why = lendStopReason(agent, path, clock(), lendPath);
    return why ? onBlocked(why) : spawn(...a);
  };
}
