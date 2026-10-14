/**
 * 全量测试闸的进程树观察（docs/architecture/full-test-gate.md）：一次全量 bun test 的整棵进程树还在不在。
 * 进程组不够——测试可以 detached / setsid 出别的组，原 bun test 退出后它们被过继给 init / launchd。所以把本机进程表扫一遍，
 * 从根（bun test）出发按下面几条认成员，直到不再增加：
 * - 根本身、上次登记过的成员（PID + 启动时刻都对得上）、根进程组里的进程；
 * - macOS：「原始父进程」的唯一 ID（proc_pidinfo 的 p_puniqueid）是已知成员的——它在过继后不变，唯一 ID 本次开机内不复用，
 *   所以父进程已退出、自己被过继给 launchd 的后代照样认得出；
 * - Linux：父 PID 是活着的成员；
 * - 环境变量里带着本次许可标记（CLAUDESTRA_FULL_TEST_PERMIT=<许可 ID>）。macOS 读不到系统自带程序（/bin/*）的环境，Linux 都能读。
 * 监管进程在测试运行期间定时扫、把活着的成员落盘，监管进程被 SIGKILL 后别的申请者凭这份记录接着认。
 * 认不出的残余：Linux 上清空了环境、脱组、且父进程在两次扫描之间就退出的后代；macOS 上中间一环在两次扫描之间生灭、
 * 末端又读不到环境的后代。读不出进程表 = unknown（保留名额），从不当成已退出。tests/full-test-gate.test.ts。
 */
import { dlopen, FFIType, ptr as ffiPtr } from "bun:ffi";
import { readdirSync, readFileSync } from "node:fs";
import { FULL_TEST_PERMIT_ENV } from "./full-test-gate-args.js";

export type Proc = { pid: number; ppid: number; pgid: number; start: string; uniq: string | null; puniq: string | null };
type Member = { pid: number; start: string | null; uniq: string | null };
/** 登记的树：根（bun test，pgid = 它的 PID）+ 上次扫到的活成员 */
export type TreeRoot = { pgid: number; start: string | null; uniq: string | null; members: Member[] };
export type Scan = () => Proc[] | null;
type ReadEnv = (pid: number) => string[] | null;

// ── macOS：libproc / sysctl，全程不起子进程（过载时 ps 会超时） ──
type DarwinLib = {
  proc_listallpids: (buf: unknown, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buf: unknown, size: number) => number;
  sysctl: (mib: unknown, n: number, out: unknown, size: unknown, newp: unknown, newlen: number) => number;
};
let darwin: { lib: DarwinLib; ptr: (b: Parameters<typeof ffiPtr>[0]) => unknown } | null = null;
function darwinLib() {
  if (darwin) return darwin;
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
  });
  darwin = { lib: symbols as unknown as DarwinLib, ptr: (b) => ffiPtr(b) };
  return darwin;
}

const PROC_PIDT_BSDINFOWITHUNIQID = 18;
const BSDINFO_UNIQ_SIZE = 192; // struct proc_bsdinfo(136) + struct proc_uniqidentifierinfo(56)

function darwinProcesses(): Proc[] {
  const { lib, ptr } = darwinLib();
  const count = lib.proc_listallpids(null, 0);
  if (count <= 0) throw new Error("proc_listallpids failed");
  const pids = new Int32Array(count + 256);
  const n = lib.proc_listallpids(ptr(pids), pids.byteLength);
  if (n <= 0) throw new Error("proc_listallpids failed");
  const buf = new Uint8Array(BSDINFO_UNIQ_SIZE);
  const view = new DataView(buf.buffer);
  const out: Proc[] = [];
  for (const pid of pids.subarray(0, n)) {
    if (pid <= 0) continue;
    // 拿不到（刚退出、别的用户的受保护进程）就跳过：我们的后代和我们同一个用户
    if (lib.proc_pidinfo(pid, PROC_PIDT_BSDINFOWITHUNIQID, 0n, ptr(buf), buf.byteLength) !== BSDINFO_UNIQ_SIZE) continue;
    if (view.getUint32(12, true) !== pid) continue;
    const usec = String(view.getBigUint64(128, true)).padStart(6, "0");
    out.push({ pid, ppid: view.getUint32(16, true), pgid: view.getUint32(100, true), start: `darwin:${view.getBigUint64(120, true)}.${usec}`,
      uniq: String(view.getBigUint64(152, true)), puniq: String(view.getBigUint64(160, true)) });
  }
  return out;
}

/** KERN_PROCARGS2：int32 argc、可执行文件路径、NUL 填充、argc 个参数、环境变量（到空串为止）。读不出返回 null */
function darwinProcArgs(pid: number): { argv: string[]; env: string[] } | null {
  const { lib, ptr } = darwinLib();
  const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2
  const size = new BigUint64Array([0n]);
  if (lib.sysctl(ptr(mib), 3, null, ptr(size), null, 0) !== 0 || size[0] === 0n) return null;
  const buf = new Uint8Array(Number(size[0]));
  if (lib.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0) !== 0) return null;
  const end = Number(size[0]);
  if (end < 4) return null;
  const argc = new DataView(buf.buffer).getInt32(0, true);
  let i = 4;
  while (i < end && buf[i] !== 0) i++;
  while (i < end && buf[i] === 0) i++;
  const decoder = new TextDecoder();
  const strings: string[] = [];
  while (i < end) {
    let j = i;
    while (j < end && buf[j] !== 0) j++;
    const s = decoder.decode(buf.subarray(i, j));
    if (strings.length >= argc && s === "") break;
    strings.push(s);
    i = j + 1;
  }
  if (strings.length < argc) return null;
  return { argv: strings.slice(0, argc), env: strings.slice(argc) };
}

// ── Linux：/proc ──
function linuxProcesses(): Proc[] {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); } catch { continue; } // 刚退出
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    if (!f[19] || !/^\d+$/.test(f[19])) continue;
    out.push({ pid: Number(name), ppid: Number(f[1]), pgid: Number(f[2]), start: `linux:${boot}:${f[19]}`, uniq: null, puniq: null });
  }
  return out;
}

function readEnvOf(pid: number): string[] | null {
  try {
    if (process.platform === "linux") return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    if (process.platform === "darwin") return darwinProcArgs(pid)?.env ?? null;
  } catch { /* 读不到（权限、刚退出）= 不知道，不当成员 */ }
  return null;
}

/** 本机进程表；读不出返回 null（调用方按 unknown 处理） */
export function scanProcesses(): Proc[] | null {
  try {
    if (process.platform === "darwin") return darwinProcesses();
    if (process.platform === "linux") return linuxProcesses();
  } catch (e) {
    console.error(`[full-test-gate] 读不出进程表：${String(e)}`);
  }
  return null;
}

/** 某个进程此刻的身份（spawn 后立即登记根用）；拿不到返回 null */
export function identify(pid: number, scan: Scan = scanProcesses): Proc | null {
  return scan()?.find((p) => p.pid === pid) ?? null;
}

/** 这棵树此刻活着的成员（含根）。procs 是同一时刻的进程表 */
export function liveTree(root: TreeRoot, permitId: string, procs: Proc[], readEnv: ReadEnv = readEnvOf): Proc[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const marker = `${FULL_TEST_PERMIT_ENV}=${permitId}`;
  const known = [{ pid: root.pgid, start: root.start, uniq: root.uniq }, ...root.members];
  const same = (p: Proc, m: Member) => p.pid === m.pid && (m.start === null || p.start === m.start);
  // 组号还被占着就不会分给新进程；组长 PID 现在是别的进程（启动时刻不同）= 原来的组已经没了
  const leader = byPid.get(root.pgid);
  const groupGone = leader !== undefined && root.start !== null && leader.start !== root.start;
  const members = new Map<number, Proc>();
  for (const p of procs) if (known.some((m) => same(p, m)) || (!groupGone && p.pgid === root.pgid)) members.set(p.pid, p);
  const uniqs = new Set(known.map((m) => m.uniq).filter((u): u is string => u !== null));
  let envChecked = false;
  for (;;) {
    for (const p of members.values()) if (p.uniq) uniqs.add(p.uniq);
    const before = members.size;
    for (const p of procs) {
      if (members.has(p.pid)) continue;
      if ((p.puniq !== null && uniqs.has(p.puniq)) || (p.ppid > 1 && members.has(p.ppid))) members.set(p.pid, p);
    }
    if (members.size !== before) continue;
    if (envChecked) break;
    envChecked = true;
    // 环境标记：macOS 只看根之后出生、已被过继给 launchd 的孤儿（唯一 ID 单调递增；父进程还在的走上面的血缘），
    // Linux 都看（/proc 读起来便宜，过继目标也可能是 subreaper 而不是 1）
    for (const p of procs) {
      if (members.has(p.pid)) continue;
      if (p.uniq !== null && (p.ppid !== 1 || (root.uniq !== null && BigInt(p.uniq) <= BigInt(root.uniq)))) continue;
      if (readEnv(p.pid)?.includes(marker)) members.set(p.pid, p);
    }
    if (members.size === before) break;
  }
  return [...members.values()];
}
