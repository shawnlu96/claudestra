/**
 * Exact B terminal workers enter retirement through the manager workflow leaf. LIFE1 must own the execution and preservation.
 * Until its B order/session/gen port exists, failures retain settle and the daily scan only reports metadata; it moves no history.
 */
import { codexSubOf } from "./codex-subthread.js";
import { archiveCodexThreads } from "./unmanaged-archive.js";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getOrder, LEND_JOURNAL_PATH, type LendRow } from "./lend-journal.js";
import type { RegistryAgent } from "./registry.js";
import type { SweepOpts } from "./unmanaged-archive.js";
import { archivePlainPath } from "./lend-worker-registry-archive-files.js";
import { isWorkerArchiveTerminal, workerArchiveIdentity, workerArchiveProblem } from "./lend-worker-registry-archive.js";

type Opts = Omit<SweepOpts, "now" | "idleDays">;

/** The existing settle hook passes the real row and leased plainManager; only a real retirement receipt can clear settle. */
export async function archiveEndedWorker(row: Pick<LendRow, "orderId" | "family" | "agent" | "sessionId"> & Partial<LendRow>, log: (m: string) => void,
  opts: Opts = { keep: new Set() }, manager?: (...args: string[]) => Promise<Record<string, unknown>>): Promise<void> {
  if (!isWorkerArchiveTerminal(row.state ?? "") || (!row.agent && !row.sessionId)) return;
  const identity = workerArchiveIdentity(row);
  if (!identity) throw new Error(`${row.orderId} 归档身份不完整（保留收尾计划，可恢复）`);
  if (!manager) throw new Error(`${row.orderId} blocked-capability：缺少 LIFE1 精确退休入口（保留收尾计划，可恢复）`);
  const r = await manager("archive-workflows", "--lend-worker", "settle", JSON.stringify(identity));
  if (r.ok !== true || r.archived !== true) {
    throw new Error(`${row.orderId} registry 归档未完成（保留收尾计划，可恢复）：${String(r.code ?? r.error ?? r.reason ?? "无有效回执")}`);
  }
  // This canonical session copier is reached only after the unique retirement port has issued a success receipt.
  if (row.family === "codex") {
    const mains = new Set([identity.sessionId]);
    const want = (p: Record<string, any>) => [p.id, p.session_id, codexSubOf(p).parentId].some((id) => typeof id === "string" && mains.has(id));
    await archiveCodexThreads(opts, { want, reason: "lend-worker-ended" });
  }
  log(`${row.orderId} 精确 worker ${row.agent} 已经由唯一退休入口归档`);
}

/** Read only, no migrations. Exact terminal metadata still does not prove exit, authentication, card protection or preservation. */
function endedWorkerCount(path: string, agents: RegistryAgent[]): number {
  if (!existsSync(path)) return 0;
  archivePlainPath(path);
  const db = new Database(path, { readonly: true });
  try {
    let count = 0;
    const rows = db.query("SELECT orderId FROM lend_orders WHERE state IN ('acked','cancelled','released')").all() as { orderId: string }[];
    for (const { orderId } of rows) {
      const row = getOrder(db, orderId), id = row && workerArchiveIdentity(row);
      const agent = id && agents.find((a) => a.name === id.agent);
      if (id && agent && !workerArchiveProblem(id, row, agent)) count++;
    }
    return count;
  } finally { db.close(); }
}

/** Historical scanning stays metadata only: an exact owner-bound list plus the missing LIFE1 port are required to retire. */
export async function sweepEndedLendThreads(agents: RegistryAgent[], opts: Partial<Opts> & { journalPath?: string } = {}): Promise<number> {
  try {
    const count = endedWorkerCount(opts.journalPath ?? LEND_JOURNAL_PATH, agents);
    if (count) console.log(`出借 worker 会话：${count} 个终态候选；blocked-capability，保留会话历史与登记`);
    return 0;
  } catch (e) {
    console.log(`⚠️ 出借 worker 会话只读扫描失败，保留全部原件: ${(e as Error).message}`);
    return 0;
  }
}
