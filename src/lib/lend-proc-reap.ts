/**
 * 出借单结单 / stopped 到期 / 周期兜底时回收工作目录下的残留进程（沙箱 bridge、channel-server 等由 worker 或测试拉起、没人收的）。
 * 归属只认进程 cwd（lsof 读的系统事实），argv 里出现路径不算；只碰本机同 uid、cwd 落在 LEND_ROOT/work/<单目录> 下的进程。
 * 宁漏勿杀：根 / work / 单目录任一层是软链就拒；journal 读不到、目录名对不上单、写入时间拿不准都跳过并记一行。
 * 日志只写命令名（basename），不写 argv（里面可能带凭据）。进程枚举与发信号都经 ProcPorts 注入，单测换假表。
 */
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { LEND_ROOT, orderDirName } from "./lend-clone.js";
import { getMeta, LIVE_STATES, setMeta, type LendState } from "./lend-journal.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export interface Proc { pid: number; uid: number; cwd: string; comm: string; ageSec: number | null }
type Sig = "SIGTERM" | "SIGKILL";
export interface ProcPorts {
  uid: number;
  /** 自己的 pid：永远不碰 */
  self: number;
  list(): Promise<Proc[]>;
  /** 发信号；进程已不在 = false */
  signal(pid: number, sig: Sig): boolean;
  sleep(ms: number): Promise<void>;
}
export interface ReapOptions {
  root?: string;
  ports: ProcPorts;
  log: (m: string) => void;
  /** 生产：发信号前核调度器租约，失租抛 SchedulerStopped（不吞） */
  active?: () => void;
  graceMs?: number;
}

const REAP_GRACE_MS = 4_000;
export const ORPHAN_IDLE_MS = 30 * 60_000;
export const ORPHAN_EVERY_MS = 10 * 60_000;
const ORPHAN_KEY = "procReap:lastAt";
/** 判「30 分钟没写入」最多看这么多个条目，超了算拿不准 */
const WALK_CAP = 50_000;
const SKIP_WALK = new Set(["node_modules", "objects"]);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/** LEND_ROOT/work 的真实路径；根或 work 是软链就抛，work 不存在 = null（没东西可收） */
function workRoot(root: string): string | null {
  const work = join(root, "work");
  for (const p of [root, work]) if (isLink(p)) throw new Error(`${p} 是软链，拒绝回收`);
  return existsSync(work) ? realpathSync(work) : null;
}

/** cwd 落在 work 的哪个一级目录下；不在 work 里 = null */
function dirOf(real: string, cwd: string): string | null {
  const rel = relative(real, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

function line(p: Proc, order: string, sig: Sig, result: string): string {
  const age = p.ageSec === null ? "?" : `${p.ageSec}s`;
  return `回收残留进程 pid=${p.pid} 命令=${basename(p.comm).slice(0, 40)} 单=${order} 存活=${age} 信号=${sig} 结果=${result}`;
}

/** TERM → 宽限 → 重新枚举、仍在原目录的才 KILL（防 pid 复用误杀）；返回回收个数 */
async function reap(real: string, owner: (dir: string) => string | null, o: ReapOptions): Promise<number> {
  const pick = (ps: Proc[]) => ps.flatMap((p) => {
    if (p.uid !== o.ports.uid || p.pid === o.ports.self || p.pid <= 1) return [];
    const dir = dirOf(real, p.cwd);
    const order = dir && owner(dir);
    return order ? [{ p, order }] : [];
  });
  const first = pick(await o.ports.list());
  if (!first.length) return 0;
  o.active?.();
  for (const { p, order } of first) o.log(line(p, order, "SIGTERM", o.ports.signal(p.pid, "SIGTERM") ? "已发" : "已不在"));
  await o.ports.sleep(o.graceMs ?? REAP_GRACE_MS);
  const ids = new Set(first.map((x) => x.p.pid));
  const left = pick(await o.ports.list()).filter((x) => ids.has(x.p.pid));
  if (left.length) o.active?.();
  for (const { p, order } of left) o.log(line(p, order, "SIGKILL", o.ports.signal(p.pid, "SIGKILL") ? "已发" : "已不在"));
  return first.length;
}

/** 结单删目录 / stopped 到期清理前：回收 cwd 在这张单工作目录（含子目录）下的进程。除失租外的失败只记日志，不挡结单 */
export async function reapOrder(orderId: string, o: ReapOptions): Promise<number> {
  try {
    const root = o.root ?? LEND_ROOT;
    const real = workRoot(root);
    const name = orderDirName(orderId);
    if (!real || !existsSync(join(root, "work", name))) return 0;
    if (isLink(join(root, "work", name))) throw new Error(`work/${name} 是软链，拒绝回收`);
    return await reap(real, (d) => (d === name ? orderId : null), o);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    o.log(`回收 ${orderId} 的残留进程失败（不挡结单）：${msg(e)}`);
    return 0;
  }
}

/** 目录里有没有 since 之后的写入：true / false；条目太多或读失败 = null（拿不准）。不跟软链，跳过 node_modules 与 .git/objects */
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
        if (e.isDirectory()) { if (!SKIP_WALK.has(e.name)) stack.push(p); continue; }
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

/** ps 的 etime（[[dd-]hh:]mm:ss）→ 秒；解析不了 = null */
export function parseEtime(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

/** lsof -Fpn：p<pid> 行开一个进程，n<path> 行是它的 cwd */
export function parseLsofCwd(out: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const l of out.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n") && pid > 0) cwds.set(pid, l.slice(1));
  }
  return cwds;
}

/** ps -axo pid=,uid=,etime=,comm=：comm 可能带空格，放最后 */
export function parsePs(out: string): Map<number, Omit<Proc, "pid" | "cwd">> {
  const procs = new Map<number, Omit<Proc, "pid" | "cwd">>();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(l);
    if (m) procs.set(Number(m[1]), { uid: Number(m[2]), ageSec: parseEtime(m[3]), comm: m[4].trim() });
  }
  return procs;
}

async function stdoutOf(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  await p.exited; // lsof 有进程读不到时退出码 1，输出照样可用
  return out;
}

export function systemProcPorts(): ProcPorts {
  const uid = process.getuid?.() ?? -1;
  const lsof = existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : "lsof";
  return {
    uid,
    self: process.pid,
    list: async () => {
      const cwds = parseLsofCwd(await stdoutOf([lsof, "-a", "-d", "cwd", "-u", String(uid), "-Fpn"]));
      const ps = parsePs(await stdoutOf(["ps", "-axo", "pid=,uid=,etime=,comm="]));
      return [...cwds].flatMap(([pid, cwd]) => { const p = ps.get(pid); return p ? [{ pid, cwd, ...p }] : []; });
    },
    signal: (pid, sig) => {
      try { process.kill(pid, sig); return true; } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw e;
      }
    },
    sleep: (ms) => Bun.sleep(ms),
  };
}
