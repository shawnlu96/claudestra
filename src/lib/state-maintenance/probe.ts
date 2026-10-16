/**
 * 真实停写探针:launchd 状态、进程树、两根的打开文件(含目录 / cwd、SQLite WAL/SHM、已删除仍打开的句柄)交叉核验。
 * 未知进程持有根内句柄、工具缺失、权限不足、扫描失败、身份无法确认一律算「没停」;单次为空不够,要连续两次都干净。
 * 防恒空探针:ps 里必须看得到执行器自己,lsof 里必须看得到执行器常开的控制文件(canary)——看不到说明扫描本身不可信。
 * 执行器自身只允许登记过的控制文件(都在根外);在根里有任何句柄(含 cwd)同样拒绝。tests/state-maintenance-probe.test.ts。
 */

import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";

export interface RunResult { code: number | null; stdout: string; stderr: string; spawnError?: string }
export type Run = (cmd: string[], timeoutMs?: number) => Promise<RunResult>;

export interface ProbeDeps {
  run: Run;
  selfPid: number;
  uid: number;
  /** 要求已从 launchd 卸载的服务 label */
  labels: readonly string[];
  /** 执行器常开的控制文件;lsof 里必须看到它 */
  canaryPath: string;
  /** 恢复清单里记下的会话及其后代 pid:任一还活着即拒绝 */
  recordedPids: () => number[];
  sleep: (ms: number) => Promise<void>;
}

/** 这些命令行算 Claudestra 的写者(守护进程、会话、channel-server、手工 manager、部署 / 更新) */
const WRITER_PATTERNS: [RegExp, string][] = [
  [/src\/(bridge|launcher|cron|scheduler[\w-]*|manager|channel-server|setup|relay)\.ts\b/, "claudestra 进程"],
  [/(^|\/)claude(\s|$)/, "Claude 会话"],
  [/(^|\/)(pi|codex)(\s|$)|codex-acp|claude-agent-acp/, "Pi / Codex 会话"],
  [/\btmux\b.*claude-orchestrator/, "Claudestra tmux"],
  [/\bclaudestra\b/i, "claudestra 相关进程"],
];

interface Proc { pid: number; ppid: number; command: string }

function parsePs(out: string): Proc[] {
  return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
}

const failed = (what: string, r: RunResult): string | null => {
  if (r.spawnError) return `${what} 无法运行(${r.spawnError}),探针失败`;
  if (/permission denied|operation not permitted/i.test(r.stderr)) return `${what} 权限不足,探针失败`;
  return r.code === 0 ? null : `${what} 退出码 ${r.code ?? "超时"},探针失败`;
};

async function launchdProblems(d: ProbeDeps): Promise<string[]> {
  const out: string[] = [];
  for (const label of d.labels) {
    const r = await d.run(["launchctl", "print", `gui/${d.uid}/${label}`], 15_000);
    if (r.spawnError) return [`launchctl 无法运行(${r.spawnError}),探针失败`];
    if (r.code === 113) continue; // 113 = launchd 里找不到这个服务,即已卸载
    out.push(r.code === 0 ? `${label} 仍在 launchd 里` : `launchctl print ${label} 退出码 ${r.code ?? "超时"},探针失败`);
  }
  return out;
}

async function processProblems(d: ProbeDeps): Promise<{ problems: string[]; procs: Proc[] }> {
  const r = await d.run(["ps", "-axo", "pid=,ppid=,command="], 15_000);
  const bad = failed("ps", r);
  if (bad) return { problems: [bad], procs: [] };
  const procs = parsePs(r.stdout);
  if (!procs.some((p) => p.pid === d.selfPid)) return { problems: ["进程扫描里看不到执行器自己,扫描不可信"], procs };
  const problems: string[] = [];
  const recorded = new Set(d.recordedPids());
  for (const p of procs) {
    if (p.pid === d.selfPid || p.ppid === d.selfPid) continue; // 执行器自己与它此刻拉起的探测命令
    if (recorded.has(p.pid)) problems.push(`已记录的会话进程 pid ${p.pid} 仍在`);
    const hit = WRITER_PATTERNS.find(([re]) => re.test(p.command));
    if (hit) problems.push(`仍有写者:${hit[1]} pid ${p.pid}`);
  }
  return { problems, procs };
}

/** 根的各种写法:原样 + realpath(旧根是别名时 realpath 指向新根) */
function rootForms(roots: string[]): { form: string; logical: string }[] {
  const out: { form: string; logical: string }[] = [];
  for (const [i, r] of roots.entries()) {
    const logical = i === 0 ? "legacy-state" : "floka-state";
    out.push({ form: r, logical });
    try {
      out.push({ form: realpathSync(r), logical });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return out;
}

const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

async function openFileProblems(d: ProbeDeps, roots: string[], procs: Proc[]): Promise<string[]> {
  const r = await d.run(["lsof", "-n", "-P", "-F", "pfn"], 60_000);
  const bad = failed("lsof", r);
  if (bad) return [bad];
  const forms = rootForms(roots);
  const known = new Map(procs.map((p) => [p.pid, p.command]));
  const problems = new Set<string>();
  let pid = 0;
  let sawCanary = false;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (!line.startsWith("n")) continue;
    const name = line.slice(1).replace(/ \(deleted\)$/, "");
    if (pid === d.selfPid && name === d.canaryPath) sawCanary = true;
    const hit = forms.find((f) => inside(name, f.form));
    if (!hit) continue;
    const who = pid === d.selfPid ? "执行器自己" : known.has(pid) ? `pid ${pid}` : `未知进程 pid ${pid}`;
    problems.add(`${who} 打开着 ${hit.logical}/${relative(hit.form, name) || "."}`);
  }
  if (!sawCanary) problems.add("打开文件扫描里看不到执行器的控制文件句柄,扫描不可信");
  return [...problems];
}

/** 扫一次:返回问题清单,空 = 这一次没看到写者 */
export async function scanOnce(d: ProbeDeps, roots: string[]): Promise<string[]> {
  try {
    const launchd = await launchdProblems(d);
    const { problems, procs } = await processProblems(d);
    const files = procs.length ? await openFileProblems(d, roots, procs) : [];
    return [...launchd, ...problems, ...files];
  } catch (e) {
    return [`探针异常:${(e as Error).message}`];
  }
}

/** 停写确认:连续两次(间隔 gapMs)都干净才算停写 */
export async function confirmStopped(d: ProbeDeps, roots: string[], gapMs = 1_000): Promise<string[]> {
  const first = await scanOnce(d, roots);
  if (first.length) return first;
  await d.sleep(gapMs);
  return scanOnce(d, roots);
}

/** 给 STATE1 迁移用的写者探针:每个破坏性步骤前完整重扫一次(两个根一起扫,问哪个根都一样) */
export function writerProbe(d: ProbeDeps, roots: string[]): { activeWriters: (root: string) => Promise<string[]> } {
  return { activeWriters: async () => scanOnce(d, roots) };
}
