/**
 * 残留进程回收的生产护栏（RTO2-1）：包在 systemProcPorts 外，卡 worktree（card-proc-reap.ts）与出借工作目录（lend-deps.ts）的生产接线共用。
 * - 带控制终端的进程（人在终端里开的 shell / 程序）与 com.claudestra.* 常驻 daemon（launchctl 列出的 pid）在枚举时就剔掉，谁也选不到；
 *   ps / launchctl 读不出、某个 pid 的补充事实缺失或命令名对不上（pid 刚被复用）= 不给（宁漏勿杀）。Claude Code 的 Bash 工具子进程没有控制终端，照常可收。
 * - 每个信号与每条 observe 推送都落一行动作台账（state 下 JSON，留最近 ACTION_CAP 条）：pid、命令名、cwd、存活、累计 CPU、信号、结果。
 *   命令只记 basename（argv 里可能带凭据）。测试注入的假 ports 不经过这里，单测见 tests/worktree-orphan-guard.test.ts。
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { statePath } from "./paths.js";
import type { Proc, ProcPorts, Sig } from "./proc-reap-core.js";
import { writeJsonAtomicSync } from "./state-file.js";

export interface ProcFacts { tty: string | null; cpuSec: number | null; comm: string }
export interface GuardSources {
  /** pid → 控制终端 / 累计 CPU / 命令；读不出 = null */
  facts(): Promise<Map<number, ProcFacts> | null>;
  /** 常驻 daemon 的 pid；读不出 = null */
  daemons(): Promise<Set<number> | null>;
}
export interface ActionRow {
  at: number; pid: number; comm: string; cwd: string; ageSec: number | null; cpuSec: number | null;
  signal: Sig | "无（observe）"; result: string; owner?: string;
}
export type ActionSink = (rows: ActionRow[]) => void;
/** card-proc-reap 的 observe 台账形状（只用到 add 里的 pid / card / why） */
export interface Observed { has(key: string): boolean; add(rows: { pid: number; card: string; why: string }[]): void }

const ACTION_CAP = 500;
const DAEMON_LABEL = /^com\.claudestra\./;

/** ps 的 time（macOS mm:ss.cc，Linux [dd-]hh:mm:ss）→ 秒；解析不了 = null */
export function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(\d+(?::\d+)*(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const sec = m[2].split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  return Math.round(Number(m[1] ?? 0) * 86_400 + sec);
}

/** ps -axo pid=,tty=,time=,comm=：tty 为 ?? / ? / - 即没有控制终端 */
export function parseFacts(out: string): Map<number, ProcFacts> {
  const facts = new Map<number, ProcFacts>();
  for (const l of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(l);
    if (m) facts.set(Number(m[1]), { tty: /^(\?+|-)$/.test(m[2]) ? null : m[2], cpuSec: parseCpuTime(m[3]), comm: m[4].trim() });
  }
  return facts;
}

/** launchctl list（PID<TAB>Status<TAB>Label）里 com.claudestra.* 在跑的 pid */
export function parseDaemons(out: string): Set<number> {
  const pids = new Set<number>();
  for (const l of out.split("\n")) {
    const [pid, , label] = l.split("\t");
    if (/^\d+$/.test(pid ?? "") && DAEMON_LABEL.test(label?.trim() ?? "")) pids.add(Number(pid));
  }
  return pids;
}

async function run(argv: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out : null;
  } catch { return null; } // 命令不在（非 macOS 没有 launchctl）：调用方按读不出处理，整轮不给进程
}

export function systemGuardSources(): GuardSources {
  return {
    facts: async () => { const out = await run(["ps", "-axo", "pid=,tty=,time=,comm="]); return out === null ? null : parseFacts(out); },
    daemons: async () => { const out = await run(["launchctl", "list"]); return out === null ? null : parseDaemons(out); },
  };
}

/** 动作台账：state 下 JSON 数组，追加后只留最近 ACTION_CAP 条；读坏了当空（只丢旧记录，不影响回收） */
export function fileActionSink(path = statePath("worktree-orphan-actions.json")): ActionSink {
  const read = (): ActionRow[] => {
    try { const v = JSON.parse(readFileSync(path, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  return (rows) => { if (rows.length) writeJsonAtomicSync(path, [...read(), ...rows].slice(-ACTION_CAP)); };
}

type Snap = Proc & { cpuSec: number | null };

/**
 * 给 base 包上护栏与动作台账。返回的 ports 用于发信号的整条流程；observed() 包一层 observe 台账，推送记一行时顺带落动作台账。
 * 台账写失败只记日志，不挡信号（信号已经发出，补不回来）。
 */
export function guardReap(base: ProcPorts, src: GuardSources, sink: ActionSink, log: (m: string) => void, now: () => number = Date.now) {
  const snap = new Map<number, Snap>();
  let termed = new Set<number>();
  const write = (rows: ActionRow[]) => { try { sink(rows); } catch (e) { log(`残留进程动作台账没写上：${e instanceof Error ? e.message : String(e)}`); } };
  const row = (pid: number, signal: ActionRow["signal"], result: string, owner?: string): ActionRow => {
    const p = snap.get(pid);
    return { at: now(), pid, comm: basename(p?.comm ?? "?").slice(0, 40), cwd: p?.cwd ?? "?", ageSec: p?.ageSec ?? null,
      cpuSec: p?.cpuSec ?? null, signal, result, ...(owner ? { owner } : {}) };
  };
  const ports: ProcPorts = {
    uid: base.uid, self: base.self, sleep: (ms) => base.sleep(ms),
    list: async () => {
      const [ps, facts, daemons] = await Promise.all([base.list(), src.facts(), src.daemons()]);
      const gone = [...termed].filter((pid) => !ps.some((p) => p.pid === pid));
      termed = new Set();
      write(gone.map((pid) => row(pid, "SIGTERM", "TERM 后已退出")));
      if (!facts || !daemons) {
        log(`残留进程护栏读不出${!facts ? "进程终端 / CPU（ps）" : "常驻 daemon（launchctl）"}，这轮一个进程都不给`);
        return [];
      }
      snap.clear();
      return ps.flatMap((p) => {
        const f = facts.get(p.pid);
        if (!f || f.comm !== p.comm || f.tty || daemons.has(p.pid)) return [];
        snap.set(p.pid, { ...p, cpuSec: f.cpuSec });
        return [p];
      });
    },
    signal: (pid, sig) => {
      const sent = base.signal(pid, sig);
      if (sent && sig === "SIGTERM") termed.add(pid);
      write([row(pid, sig, sent ? "已发" : "已不在")]);
      return sent;
    },
  };
  const observed = (l: Observed): Observed => ({ has: (k) => l.has(k), add: (rows) => {
    l.add(rows);
    write(rows.map((r) => row(r.pid, "无（observe）", `只记录，已推 PM（${r.why}）`, `卡=${r.card}`)));
  } });
  return { ports, observed };
}
