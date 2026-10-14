/**
 * bridge 卡住时抓进程现场（docs/architecture/bridge-watchdog.md「抓现场」）：kickstart 之后旧进程就没了，卡在哪里要在重启前留下来。
 * 只读进程信息、每条命令限时、总时长有上限；抓不成只记日志，从不抛、从不挡重启。每个卡住事件由 bridge-watchdog.ts 调一次。
 * 命令执行、落盘、时钟都经 DiagIo 注入，tests/bridge-watchdog-diag.test.ts。
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { CONFIG_PATH } from "./paths.js";
import { readJsonStateSync } from "./state-file.js";
import { LOG_DIR } from "./log-paths.js";

/** 抓现场 / 带外通知共用的三档；缺省、坏值 = on（BWD1 的 bridgeWatchdog 缺省 observe，解析不共用） */
export type SideMode = "on" | "observe" | "off";
const DIAG_CONFIG_KEY = "bridgeWatchdogDiag";

export function parseSideMode(raw: unknown): SideMode {
  return raw === "off" || raw === "observe" ? raw : "on";
}

/** 现读 config.json 的一个三档键（config-store 的 merge 白名单保留这两个键） */
export function readSideMode(key: string): SideMode {
  const r = readJsonStateSync(CONFIG_PATH);
  return parseSideMode(r.status === "ok" ? (r.data as Record<string, unknown> | null)?.[key] : undefined);
}

export const DIAG_LIMITS = {
  /** 全部命令的总时限：到点没起的命令不再起，在跑的命令被杀 */
  totalMs: 13_000,
  /** sample 采 3 秒，符号化还要几秒 */
  sampleMs: 10_000,
  cmdMs: 3_000,
  sampleSeconds: 3,
  keep: 5,
} as const;

const DIR_PREFIX = "bridge-stuck-";
/** 只认本机制自己起的目录名：清理按它过滤，别的文件和目录一概不碰 */
const DIR_RE = /^bridge-stuck-\d{8}T\d{6}Z$/;
const LSOF_TYPES = ["REG", "IPv4", "IPv6", "unix", "PIPE"] as const;

export type ExecResult = { ok: true; out: string } | { ok: false; error: string };

export interface DiagIo {
  mode(): SideMode;
  platform: string;
  /** 现场目录的父目录（生产 = 日志目录） */
  baseDir: string;
  /** 跑一条命令，最多 timeoutMs；超时 / 起不来 / 非 0 退出 = ok:false，不抛 */
  exec(cmd: string[], timeoutMs: number): Promise<ExecResult>;
  log(line: string): void;
  now(): number;
}

export function diagDirName(at: number): string {
  return DIR_PREFIX + new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** lsof 输出只留条目数和按类型的计数：路径、地址不进现场文件 */
export function summarizeLsof(out: string): string {
  const rows = out.split("\n").slice(1).filter((l) => l.trim());
  const counts: Record<string, number> = Object.fromEntries(LSOF_TYPES.map((k) => [k, 0]));
  let other = 0;
  for (const row of rows) {
    const type = row.trim().split(/\s+/)[4] ?? "";
    if (type in counts) counts[type]!++;
    else other++;
  }
  return [`total ${rows.length}`, ...LSOF_TYPES.map((k) => `${k} ${counts[k]}`), `other ${other}`].join("\n") + "\n";
}

const VM_STAT_KEEP = /page size|Pages (free|active|inactive|speculative|wired down|occupied by compressor)|Swapins|Swapouts/;

export function summarizeVmStat(out: string): string {
  return out.split("\n").filter((l) => VM_STAT_KEEP.test(l)).join("\n") + "\n";
}

/** uptime 只留负载那一段（前面是开机时长和登录用户数） */
export function loadOf(out: string): string {
  return (/load averages?:.*$/m.exec(out)?.[0].trim() ?? out.trim()) + "\n";
}

interface DiagItem {
  name: string;
  file: string;
  cmd: string[];
  timeoutMs: number;
  /** 命令输出 → 落盘内容；缺省原样。sample 自己写文件（-file），这里不落盘 */
  render?: (out: string) => string;
  selfWrites?: boolean;
}

/** 这次要抓的条目。lsof 加 -n -P：不反查主机名和端口名，卡住的机器上 DNS 反查会把时限耗完 */
function planItems(pid: number, dir: string, platform: string): { sample: DiagItem | null; rest: DiagItem[] } {
  const p = String(pid);
  const sample: DiagItem | null = platform === "darwin"
    ? { name: "sample", file: "sample.txt", timeoutMs: DIAG_LIMITS.sampleMs, selfWrites: true,
        cmd: ["/usr/bin/sample", p, String(DIAG_LIMITS.sampleSeconds), "-file", join(dir, "sample.txt")] }
    : null;
  const t = DIAG_LIMITS.cmdMs;
  const rest: DiagItem[] = [
    { name: "ps", file: "ps.txt", timeoutMs: t, cmd: ["ps", "-o", "pid,ppid,stat,%cpu,%mem,rss,etime,wchan", "-p", p] },
    { name: "lsof", file: "lsof-counts.txt", timeoutMs: t, cmd: ["lsof", "-n", "-P", "-p", p], render: summarizeLsof },
    { name: "swap", file: "swap.txt", timeoutMs: t, cmd: ["sysctl", "vm.swapusage"] },
    { name: "vm_stat", file: "vm_stat.txt", timeoutMs: t, cmd: ["vm_stat"], render: summarizeVmStat },
    { name: "uptime", file: "load.txt", timeoutMs: t, cmd: ["uptime"], render: loadOf },
  ];
  return { sample, rest };
}

/** 只留最近 keep 份现场：按目录名（UTC 时间，字典序即时间序）排，旧的整份删。符号链接和别的名字不碰 */
export function pruneDiagDirs(baseDir: string, keep: number = DIAG_LIMITS.keep): string[] {
  const own = readdirSync(baseDir).filter((n) => DIR_RE.test(n) && lstatSync(join(baseDir, n)).isDirectory()).sort();
  const gone = own.slice(0, Math.max(0, own.length - keep));
  for (const n of gone) rmSync(join(baseDir, n), { recursive: true, force: true });
  return gone;
}

async function runItem(item: DiagItem, dir: string, deadline: number, io: DiagIo): Promise<string> {
  const left = deadline - io.now();
  if (left <= 0) return `${item.name}: 跳过（总时限已到）`;
  const r = await io.exec(item.cmd, Math.min(item.timeoutMs, left));
  if (!r.ok) return `${item.name}: 失败（${r.error}）`;
  const path = join(dir, item.file);
  if (!item.selfWrites) writeFileSync(path, item.render ? item.render(r.out) : r.out, { mode: 0o600 });
  else if (existsSync(path)) chmodSync(path, 0o600); // sample 自己建的文件是 0644，收成和其余几份一样
  return `${item.name}: ok`;
}

/**
 * 抓一次现场，返回现场目录名；off / observe / 建不出目录 = null。从不抛。
 * sample 与其余几条并行（sample 自己要采 3 秒），其余几条按顺序跑；全部受同一个总时限约束。
 */
export async function captureBridgeDiag(pid: number, io: DiagIo): Promise<string | null> {
  const mode = io.mode();
  if (mode === "off") return null;
  const startedAt = io.now();
  const name = diagDirName(startedAt);
  const dir = join(io.baseDir, name);
  const { sample, rest } = planItems(pid, dir, io.platform);
  const items = sample ? [sample, ...rest] : rest;
  if (mode === "observe") {
    io.log(`🩺 现场[observe] 本会抓（pid ${pid}）→ ${name}/：${items.map((i) => i.name).join("、")}；未执行任何命令`);
    return null;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadline = startedAt + DIAG_LIMITS.totalMs;
    const chain = async () => {
      const lines: string[] = [];
      for (const item of rest) lines.push(await runItem(item, dir, deadline, io));
      return lines;
    };
    const [sampleLine, restLines] = await Promise.all([sample ? runItem(sample, dir, deadline, io) : "sample: 跳过（非 darwin）", chain()]);
    const summary = [sampleLine, ...restLines];
    writeFileSync(join(dir, "summary.txt"), [`pid ${pid}`, `at ${new Date(startedAt).toISOString()}`, ...summary].join("\n") + "\n", { mode: 0o600 });
    const gone = pruneDiagDirs(io.baseDir);
    io.log(`🩺 现场已抓 → ${name}/（${io.now() - startedAt}ms；${summary.join("；")}）${gone.length ? `；清掉旧现场 ${gone.length} 份` : ""}`);
    return name;
  } catch (e) {
    io.log(`🩺 抓现场失败（不影响重启）: ${(e as Error).message}`);
    return null;
  }
}

/** 真跑一条命令：到时限就 kill，不等它的输出收尾 */
export async function execWithTimeout(cmd: string[], timeoutMs: number): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); });
    const r = await Promise.race([done, timedOut]);
    if (r === "timeout") {
      p.kill("SIGKILL");
      done.catch(() => {}); // 被杀进程的管道读失败没有用处：结果已按超时返回
      return { ok: false, error: `超时 ${timeoutMs}ms` };
    }
    const [out, err, code] = r;
    return code === 0 ? { ok: true, out } : { ok: false, error: `exit ${code}${err.trim() ? `: ${err.trim().split("\n")[0]!.slice(0, 120)}` : ""}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export function realDiagIo(log: (line: string) => void): DiagIo {
  return { mode: () => readSideMode(DIAG_CONFIG_KEY), platform: process.platform, baseDir: LOG_DIR, exec: execWithTimeout, log, now: () => Date.now() };
}
