/**
 * 出借 Codex worker 的会话（主线程 + 它开的子线程，含孙辈）结单就收进 archived/（网页「归档」可恢复）。不能等 Codex 子线程的 7 天规则：
 * 那条规则把 registry 里所有 agent 的会话都当「挂着」，停掉的出借 worker 一直留在 registry，它的子线程就永远收不走、堆在「未纳管」里。
 * 认人只认 journal 记下的 worker 会话 id（名字须是 workerName 的形状）；owner 自己 agent 的会话放进 keep，照旧走 7 天规则。
 * 两处调：lend-drive settleOrder 收尾做完（lend-deps 接线）、archive-sweeper 每日补漏。tests/lend-session-archive.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { codexSubOf } from "./codex-subthread.js";
import { LEND_JOURNAL_PATH, LIVE_STATES, type LendRow } from "./lend-journal.js";
import { isLendWorkerName } from "./lend-workers-view.js";
import type { RegistryAgent } from "./registry.js";
import { archiveCodexThreads, type SweepOpts } from "./unmanaged-archive.js";

const REASON = "lend-worker-ended";
type Opts = Omit<SweepOpts, "now" | "idleDays">;

/** mains（worker 主线程 id）本身、以及父线程或根线程在 mains 里的子线程 */
function archiveWorkerThreads(mains: ReadonlySet<string>, opts: Opts): Promise<{ archived: number; bytes: number }> {
  const want = (p: Record<string, any>) => [p.id, p.session_id, codexSubOf(p).parentId].some((id) => typeof id === "string" && mains.has(id));
  return mains.size ? archiveCodexThreads(opts, { want, reason: REASON }) : Promise.resolve({ archived: 0, bytes: 0 });
}

/** 结单收尾全做完之后调（worker 已确认退出）：只收 Codex worker 的。失败只记日志、绝不抛——结单已经落账，漏的由每日补漏接住 */
export async function archiveEndedWorker(row: Pick<LendRow, "orderId" | "family" | "agent" | "sessionId">, log: (m: string) => void,
  opts: Opts = { keep: new Set() }): Promise<void> {
  if (row.family !== "codex" || !row.sessionId || !row.agent || !isLendWorkerName(row.agent)) return;
  try {
    const r = await archiveWorkerThreads(new Set([row.sessionId]), opts);
    if (r.archived) log(`${row.orderId} 结单：${row.agent} 的 ${r.archived} 个 Codex 会话收进归档区(archived/)`);
  } catch (e) {
    log(`${row.orderId} 结单后归档 ${row.agent} 的会话失败（不影响结单，每日扫描补）：${(e as Error).message}`);
  }
}

/** journal 里已终态的 Codex 单的 worker 会话 id；只读打开（openLendJournal 会建目录、跑迁移），journal 不在 = 没借出过 */
function endedWorkerSessions(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const live = LIVE_STATES.map(() => "?").join(",");
    const rows = db.query(`SELECT agent, sessionId FROM lend_orders WHERE family = 'codex' AND sessionId IS NOT NULL AND state NOT IN (${live})`)
      .all(...LIVE_STATES) as { agent: string | null; sessionId: string }[];
    return new Set(rows.filter((r) => r.agent && isLendWorkerName(r.agent)).map((r) => r.sessionId));
  } finally {
    db.close();
  }
}

/**
 * 每日补漏：结单那一下没收成的（失败、升级前结的单）不等 7 天直接收。registry 里不是出借 worker 的、以及还 active 的 agent，
 * 会话全进 keep：owner 的子线程、万一被重新拉起的 worker 都不动。不跟 autoArchiveCodexSubs 开关：出借会话是一次性的外来活。返回归档条数，失败记日志返回 0。
 */
export async function sweepEndedLendThreads(agents: RegistryAgent[], opts: Partial<Opts> & { journalPath?: string } = {}): Promise<number> {
  try {
    const keep = new Set(agents.filter((a) => a.sessionId && (a.status === "active" || !isLendWorkerName(a.name))).map((a) => a.sessionId!));
    const r = await archiveWorkerThreads(endedWorkerSessions(opts.journalPath ?? LEND_JOURNAL_PATH), { ...opts, keep });
    if (r.archived) console.log(`🗄 出借 worker 会话：${r.archived} 个（${(r.bytes / 1048576).toFixed(1)}MB）借单已结束，收进归档区(archived/)`);
    return r.archived;
  } catch (e) {
    console.log(`⚠️ 出借 worker 会话归档扫描失败: ${(e as Error).message}`);
    return 0;
  }
}
