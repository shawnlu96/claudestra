/**
 * 残留进程回收的共用底座：出借工作目录（lend-proc-reap.ts）与本机卡 worktree（card-proc-reap.ts）两边共用。
 * 安全规则只此一份：只碰本机同 uid（不碰自己、不碰 pid ≤ 1）；归属只认 lsof 读到的 cwd，argv 里出现路径不算；
 * 路径任何一层是软链就拒；日志只写命令名的 basename，不写 argv（里面可能带凭据）。发信号固定 TERM → 宽限 → 只 KILL 仍在的。
 * 进程枚举与发信号都经 ProcPorts 注入，单测换假表。
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, sep } from "node:path";

export interface Proc { pid: number; ppid?: number; uid: number; cwd: string; comm: string; ageSec: number | null }
export type Sig = "SIGTERM" | "SIGKILL";
export interface ProcPorts {
  uid: number;
  /** 自己的 pid：永远不碰 */
  self: number;
  list(): Promise<Proc[]>;
  /** 发信号；进程已不在 = false */
  signal(pid: number, sig: Sig): boolean;
  sleep(ms: number): Promise<void>;
}
export interface SignalOptions {
  ports: ProcPorts;
  log: (m: string) => void;
  /** 生产：发信号前核调度器租约，失租抛 SchedulerStopped（不吞） */
  active?: () => void | Promise<void>;
  graceMs?: number;
}
/** 一个要收的进程 + 它归谁（写进日志的「单=x」/「卡=x」） */
export interface Pick { p: Proc; owner: string }

const REAP_GRACE_MS = 4_000;

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
export const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/** 路径的每一层都不是软链 = 真实路径就是它本身；否则抛 */
export function noLinks(p: string): string {
  if (realpathSync(p) !== p) throw new Error(`${p} 路径里有软链，拒绝回收`);
  return p;
}

/** cwd 落在 real 的哪个一级目录下；不在 real 里 = null */
export function dirOf(real: string, cwd: string): string | null {
  const rel = relative(real, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

/**
 * cwd（在 real 之下）从 real 往下现存的每一层都不是软链：cwd 在就查 cwd 本身，已删就查它仍在的最近祖先（已删目录照收）。
 * 安全 = null，否则 = 原因。每次挑信号目标都要重查（宽限期间路径可能被换成软链）。
 */
export function cwdLinkFree(real: string, cwd: string): string | null {
  let p = cwd;
  while (!lstatSync(p, { throwIfNoEntry: false })) {
    const up = dirname(p);
    if (up === p) return "路径一层都不在";
    p = up;
  }
  if (p !== real && dirOf(real, p) === null) return "worktrees 根已不在";
  try { noLinks(p); } catch { return "cwd 路径里有软链，拒绝回收"; }
  return null;
}

/** 本机同 uid、不是自己、不是 init：才轮得到看 cwd */
export const mayTouch = (p: Proc, ports: ProcPorts): boolean => p.uid === ports.uid && p.pid !== ports.self && p.pid > 1;

/** 一行日志：命令名只取 basename 前 40 字 */
export function procLine(p: Proc, owner: string, sig: Sig | "无（observe）", result: string): string {
  const age = p.ageSec === null ? "?" : `${p.ageSec}s`;
  return `回收残留进程 pid=${p.pid} 命令=${basename(p.comm).slice(0, 40)} ${owner} 存活=${age} 信号=${sig} 结果=${result}`;
}

/**
 * TERM → 宽限 → 重新枚举、同 pid 仍被 pick 选中才 KILL（pid 被别处的进程复用就不碰；同目录里的新进程本来就该收）；返回回收个数。
 * pick 只决定归属，uid / self / pid ≤ 1 在这里统一挡掉。
 */
export async function termThenKill(pick: (ps: Proc[]) => Pick[], o: SignalOptions): Promise<number> {
  const choose = (ps: Proc[]) => pick(ps.filter((p) => mayTouch(p, o.ports)));
  const first = choose(await o.ports.list());
  if (!first.length) return 0;
  await o.active?.();
  for (const { p, owner } of first) o.log(procLine(p, owner, "SIGTERM", o.ports.signal(p.pid, "SIGTERM") ? "已发" : "已不在"));
  await o.ports.sleep(o.graceMs ?? REAP_GRACE_MS);
  const ids = new Set(first.map((x) => x.p.pid));
  const left = choose(await o.ports.list()).filter((x) => ids.has(x.p.pid));
  if (left.length) await o.active?.();
  for (const { p, owner } of left) o.log(procLine(p, owner, "SIGKILL", o.ports.signal(p.pid, "SIGKILL") ? "已发" : "已不在"));
  return first.length;
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

/** ps -axo pid=,[ppid=,]uid=,etime=,comm=：comm 可能带空格，放最后；etime 必带冒号，据此分得清有没有 ppid 列 */
export function parsePs(out: string): Map<number, Omit<Proc, "pid" | "cwd">> {
  const procs = new Map<number, Omit<Proc, "pid" | "cwd">>();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(?:(\d+)\s+)?(\d+)\s+(\d[\d:-]*:\d+)\s+(.+)$/.exec(l);
    if (!m) continue;
    procs.set(Number(m[1]), { ...(m[2] === undefined ? {} : { ppid: Number(m[2]) }), uid: Number(m[3]), ageSec: parseEtime(m[4]), comm: m[5].trim() });
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
      const ps = parsePs(await stdoutOf(["ps", "-axo", "pid=,ppid=,uid=,etime=,comm="]));
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
