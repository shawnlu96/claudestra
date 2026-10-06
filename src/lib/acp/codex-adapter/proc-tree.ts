/**
 * app-server 的后代追踪与分层清理（I12）。登记一旦写下就保留到退出，清理集合取历次登记的并集，不按最新的父子关系重建：
 * - T1（保证清理）：app-server 的根进程组（role=root）；根组里进程的直接子进程——MCP server 和在跑的命令各自成组（CX-0 Q0-6）——
 *   连同它们自己的进程组（control / exec）；以及带控制标记的进程，逃出进程组也算（control）。
 * - T2（能发现、默认只报告）：其余后代和只靠 TREE 标记发现的进程（app），可能是模型有意留下的常驻进程；出借 worker（clean）才清。
 * - 限制：两次扫描之间创建、随后 app-server 崩溃的命令子进程认不出角色，只能按 app 报告；清空了环境又在扫描间隙双 fork 的发现不了；
 *   macOS 读不到 Apple 平台二进制（sleep、zsh、perl…）的环境，这类进程逃逸前没登记上就发现不了（第三方程序如 bun / node / codex 能读到）。
 * kill 前核对 lstart，防 pid / pgid 复用。环境只在内存里匹配两个随机标记，日志只记 pid、ppid、pgid、可执行文件名、角色和来源。
 * tests/codex-adapter-proc.test.ts。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  exe: string;
}
type Role = "root" | "control" | "exec" | "app";
type Source = "tree" | "env";
export interface Survivor {
  pid: number;
  ppid: number;
  pgid: number;
  exe: string;
  role: Role;
  source: Source;
}
type Mark = "tree" | "control";
type Signal = "SIGTERM" | "SIGKILL";

export interface ProcTreeDeps {
  /** app-server 的 pid（detached 起的，= 根进程组号） */
  rootPid: number;
  /** 两个环境标记的完整 `名=值` */
  treeMark: string;
  controlMark: string;
  /** 出借 worker：T2 也清 */
  clean: boolean;
  log(msg: string): void;
  ps?: () => Promise<ProcInfo[]>;
  /** pids = null 时扫全部（同一用户）进程 */
  envMarks?: (pids: number[] | null, marks: [string, string]) => Promise<Map<number, Set<Mark>>>;
  kill?: (target: number, sig: Signal) => void;
  self?: { pid: number; pgid: number };
}

interface Tracked extends ProcInfo {
  role: Role;
  source: Source;
}

const T1 = new Set<Role>(["root", "control", "exec"]);
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

/** `ps -A -o pid=,ppid=,pgid=,lstart=,comm=` 的一行；comm 只留 basename（日志里不出现完整路径） */
export function parsePs(out: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of out.split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) rows.push({ pid: +m[1]!, ppid: +m[2]!, pgid: +m[3]!, lstart: m[4]!.replace(/\s+/g, " "), exe: basename(m[5]!.trim()) });
  }
  return rows;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

const realPs = async () => parsePs(await run(["ps", "-A", "-o", "pid=,ppid=,pgid=,lstart=,comm="]));

/** macOS：`ps -E` 把环境接在命令后面；Linux：读 /proc/<pid>/environ。读到的内容只在这里匹配，不落盘、不进日志 */
async function realEnvMarks(pids: number[] | null, marks: [string, string]): Promise<Map<number, Set<Mark>>> {
  const hits = new Map<number, Set<Mark>>();
  const note = (pid: number, text: string) => {
    const found = new Set<Mark>();
    if (text.includes(marks[0])) found.add("tree");
    if (text.includes(marks[1])) found.add("control");
    if (found.size) hits.set(pid, found);
  };
  if (process.platform === "linux") {
    const list = pids ?? readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number);
    for (const pid of list) {
      try {
        note(pid, `\0${readFileSync(`/proc/${pid}/environ`, "latin1")}\0`);
      } catch {
        /* 进程已退出或不是本用户的：读不到就是没命中，这一轮扫描照常 */
      }
    }
    return hits;
  }
  if (pids && !pids.length) return hits;
  const out = await run(["ps", "-E", "-o", "pid=,command=", ...(pids ? ["-p", pids.join(",")] : ["-A"])]);
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) note(+m[1]!, m[2]!);
  }
  return hits;
}

function realKill(target: number, sig: Signal): void {
  try {
    process.kill(target, sig);
  } catch {
    /* ESRCH：进程 / 进程组已经没了，正是我们要的结果；EPERM 的不是我们起的，本来就不该杀 */
  }
}

export class ProcTree {
  private readonly tracked = new Map<number, Tracked>();
  /** 受管进程组（根组 + 根组直接子进程各自的组） */
  private readonly groups = new Set<number>();
  private last = new Map<number, ProcInfo>();
  private chain: Promise<void> = Promise.resolve();
  private readonly ps: () => Promise<ProcInfo[]>;
  private readonly envMarks: NonNullable<ProcTreeDeps["envMarks"]>;
  private readonly killer: (target: number, sig: Signal) => void;
  private readonly self: { pid: number; pgid: number };

  constructor(private readonly d: ProcTreeDeps) {
    this.ps = d.ps ?? realPs;
    this.envMarks = d.envMarks ?? realEnvMarks;
    this.killer = d.kill ?? realKill;
    this.self = d.self ?? { pid: process.pid, pgid: -1 };
    this.groups.add(d.rootPid);
  }

  /** 串行扫描；full = 连环境标记一起扫全部进程（收尾时） */
  scan(full = false): Promise<void> {
    this.chain = this.chain.then(() => this.scanOnce(full)).catch((e) => this.d.log(`进程树扫描出错（这一轮登记不变）：${e instanceof Error ? e.message : e}`));
    return this.chain;
  }

  /** 每 interval 扫一次；返回停止函数 */
  watch(intervalMs = 2_000): () => void {
    const timer = setInterval(() => void this.scan(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async scanOnce(full: boolean): Promise<void> {
    const procs = await this.ps();
    this.last = new Map(procs.map((p) => [p.pid, p]));
    const fresh: number[] = [];
    const add = (p: ProcInfo, role: Role, source: Source) => {
      this.tracked.set(p.pid, { ...p, role, source });
      if (source === "tree") fresh.push(p.pid);
    };
    for (const p of procs) if (p.pgid === this.d.rootPid && !this.tracked.has(p.pid)) add(p, "root", "tree");
    for (let grew = true; grew; ) {
      grew = false;
      for (const p of procs) {
        const parent = this.tracked.get(p.ppid);
        if (this.tracked.has(p.pid) || !parent || !this.sameProc(parent)) continue;
        grew = true;
        if (parent.role === "root" && p.pgid === p.pid) {
          this.groups.add(p.pgid);
          add(p, "exec", "tree");
        } else add(p, this.groups.has(p.pgid) ? (parent.role === "control" ? "control" : "exec") : "app", "tree");
      }
    }
    const marks = await this.envMarks(full ? null : fresh, [this.d.treeMark, this.d.controlMark]);
    for (const [pid, m] of marks) {
      const p = this.last.get(pid);
      const known = this.tracked.get(pid);
      if (!p || pid === this.self.pid) continue;
      if (m.has("control") && (!known || known.role !== "control")) {
        this.tracked.set(pid, { ...p, role: "control", source: known?.source ?? "env" });
        if (p.pgid === p.pid) this.groups.add(p.pgid); // 逃逸后自成一组的控制进程：它起的子进程跟着一起清
      } else if (!known) this.tracked.set(pid, { ...p, role: "app", source: "env" });
    }
  }

  /** 登记的进程还是同一个（pid 没被复用） */
  private sameProc(t: Tracked): boolean {
    return this.last.get(t.pid)?.lstart === t.lstart;
  }

  private killable(t: Tracked): boolean {
    return (T1.has(t.role) || this.d.clean) && t.pid !== this.self.pid && this.sameProc(t);
  }

  /** 清理集合里还有活着的（按最近一次扫描） */
  alive(): boolean {
    return [...this.tracked.values()].some((t) => this.killable(t));
  }

  /** 进程组按组号整组发（组里还有核对过身份的受管成员才发），其余按 pid 逐个发 */
  kill(sig: Signal): void {
    const live = [...this.tracked.values()].filter((t) => this.killable(t));
    for (const g of this.groups) if (g !== this.self.pgid && live.some((t) => t.pgid === g)) this.killer(-g, sig);
    for (const t of live) this.killer(t.pid, sig);
  }

  /** 收尾报告：全量扫一次后仍存活的相关进程（含保留下来的 T2） */
  async survivors(): Promise<Survivor[]> {
    await this.scan(true);
    return [...this.tracked.values()].filter((t) => this.sameProc(t)).map(({ pid, ppid, pgid, exe, role, source }) => ({ pid, ppid, pgid, exe, role, source }));
  }
}

/** 报告的一项：只有 pid、ppid、pgid、可执行文件名、角色和来源 */
export const survivorText = (s: Survivor) => `pid=${s.pid} ppid=${s.ppid} pgid=${s.pgid} exe=${s.exe} role=${s.role} source=${s.source}`;
