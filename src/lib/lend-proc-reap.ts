/**
 * 出借单结单 / stopped 到期 / 周期兜底时回收工作目录下的残留进程（沙箱 bridge、channel-server 等由 worker 或测试拉起、没人收的）。
 * 归属只认进程 cwd（lsof 读的系统事实），argv 里出现路径不算；只碰本机同 uid、cwd 落在 LEND_ROOT/work/<单目录> 下的进程。
 * 宁漏勿杀：work / 单目录的路径里任何一层（含根的祖先）是软链就拒；journal 读不到、目录名对不上单、写入时间拿不准都跳过并记一行。
 * 日志只写命令名（basename），不写 argv（里面可能带凭据）。进程枚举与发信号都经 ProcPorts 注入，单测换假表。
 */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEND_ROOT, orderDirName } from "./lend-clone.js";
import { getMeta, LIVE_STATES, setMeta, type LendState } from "./lend-journal.js";
import { dirOf, errMsg as msg, isLink, noLinks, termThenKill, type ProcPorts } from "./proc-reap-core.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export { parseEtime, parseLsofCwd, parsePs, systemProcPorts, type Proc, type ProcPorts } from "./proc-reap-core.js";
export interface ReapOptions {
  root?: string;
  ports: ProcPorts;
  log: (m: string) => void;
  /** 生产：发信号前核调度器租约，失租抛 SchedulerStopped（不吞） */
  active?: () => void;
  graceMs?: number;
}

export const ORPHAN_IDLE_MS = 30 * 60_000;
export const ORPHAN_EVERY_MS = 10 * 60_000;
const ORPHAN_KEY = "procReap:lastAt";
/** 判「30 分钟没写入」最多看这么多个条目（带 node_modules 的副本约 4.5 万），超了算拿不准 */
const WALK_CAP = 200_000;

/** LEND_ROOT/work 的绝对路径（每层都核过不是软链）；work 不存在 = null（没东西可收） */
function workRoot(root: string): string | null {
  const work = resolve(root, "work");
  return existsSync(work) ? noLinks(work) : null;
}

/** 发信号走共用流程（proc-reap-core.ts）：cwd 落在 work 的哪个目录、那个目录归哪张单 */
function reap(real: string, owner: (dir: string) => string | null, o: ReapOptions): Promise<number> {
  return termThenKill((ps) => ps.flatMap((p) => {
    const dir = dirOf(real, p.cwd);
    const order = dir && owner(dir);
    return order ? [{ p, owner: `单=${order}` }] : [];
  }), o);
}

/** 结单删目录 / stopped 到期清理前：回收 cwd 在这张单工作目录（含子目录）下的进程。除失租外的失败只记日志，不挡结单 */
export async function reapOrder(orderId: string, o: ReapOptions): Promise<number> {
  try {
    const root = o.root ?? LEND_ROOT;
    const real = workRoot(root);
    const name = orderDirName(orderId);
    if (!real || !existsSync(join(real, name))) return 0;
    noLinks(join(real, name));
    return await reap(real, (d) => (d === name ? orderId : null), o);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    o.log(`回收 ${orderId} 的残留进程失败（不挡结单）：${msg(e)}`);
    return 0;
  }
}

/** 目录里有没有 since 之后的写入：true / false；条目太多或读失败 = null（拿不准）。不跟软链，不跳任何子树（跳过的子树里写已有文件不改父目录 mtime） */
function recentWrite(dir: string, since: number): boolean | null {
  try {
    const stack = [dir];
    let seen = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      if (lstatSync(cur).mtimeMs >= since) return true;
      for (const e of readdirSync(cur, { withFileTypes: true })) {
        if (++seen > WALK_CAP) return null;
        const p = join(cur, e.name);
        if (e.isDirectory()) { stack.push(p); continue; }
        if (lstatSync(p).mtimeMs >= since) return true;
      }
    }
    return false;
  } catch { return null; } // 读的同时目录被删 / 没权限：当拿不准，宁漏勿杀，调用方会记一行
}

type Owner = { orderId: string; state: LendState };

/** 判定这个目录能不能当孤儿收；不能 = 返回原因（只有确实拿不准的才值得记），活单 / 新近写入 = "" */
function orphanCheck(root: string, real: string, dir: string, owners: Map<string, Owner>, now: number): string {
  if (isLink(join(root, "work", dir))) return "是软链";
  const row = owners.get(dir);
  if (!row) return "目录名对不上任何出借单";
  if (LIVE_STATES.includes(row.state)) return "";
  const fresh = recentWrite(join(real, dir), now - ORPHAN_IDLE_MS);
  return fresh === null ? "拿不准最近有没有写入" : fresh ? "" : "ok";
}

/** 周期兜底（自带节流，ORPHAN_EVERY_MS 一次）：cwd 在不属于活单、30 分钟没写入的工作目录下的进程 → 回收 */
export async function reapOrphans(db: Database, o: ReapOptions & { now: number }): Promise<number> {
  let owners: Map<string, Owner>;
  try {
    if (o.now - Number(getMeta(db, ORPHAN_KEY) ?? 0) < ORPHAN_EVERY_MS) return 0;
    setMeta(db, ORPHAN_KEY, String(o.now));
    const rows = db.query("SELECT orderId, state FROM lend_orders").all() as Owner[];
    owners = new Map(rows.map((r) => [orderDirName(r.orderId), r]));
  } catch (e) {
    o.log(`残留进程兜底本轮跳过：journal 读不到（${msg(e)}）`);
    return 0;
  }
  try {
    const root = o.root ?? LEND_ROOT;
    const real = workRoot(root);
    if (!real) return 0;
    const dirs = new Set((await o.ports.list()).filter((p) => p.uid === o.ports.uid).map((p) => dirOf(real, p.cwd)).filter((d) => d !== null));
    const orphans = new Map<string, string>();
    for (const dir of dirs) {
      const why = orphanCheck(root, real, dir, owners, o.now);
      if (why === "ok") orphans.set(dir, owners.get(dir)!.orderId);
      else if (why) o.log(`残留进程兜底跳过 work/${dir}：${why}`);
    }
    return orphans.size ? await reap(real, (d) => orphans.get(d) ?? null, o) : 0;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    o.log(`残留进程兜底失败：${msg(e)}`);
    return 0;
  }
}
