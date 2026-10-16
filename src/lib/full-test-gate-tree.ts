/**
 * 采样见过的后代按 PID + 启动时刻追踪，并记住它的 pgid / sid；脱组、过继不使成员按时间过期。
 * 父节点在首次采样前退出且脱离所有已知组/会话时，只能认作 unclaimed；宽限释放是已接受的负载闸近似。
 * 不读取其他进程的环境。读不出进程表时保留名额，详见 docs/architecture/full-test-gate.md。
 */
import { dlopen, FFIType, ptr as ffiPtr } from "bun:ffi";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** ver / opv：macOS 的 PID 版本号（p_idversion）和原始父进程的 PID 版本号（p_orig_ppidversion）；Linux 为 null */
export type Proc = { pid: number; ppid: number; pgid: number; start: string; uid: number | null; uniq: string | null; puniq: string | null;
  ver: number | null; opv: number | null; sid?: number | null };
type Member = { pid: number; start: string | null; uniq: string | null; ver: number | null };
/** 登记的树：根（bun test，pgid = 它的 PID）+ 上次扫到的活成员；quietAt：认得出的成员都没了、只剩 unclaimed 的那一刻（full-test-gate.ts 的宽限） */
export type TreeRoot = { pgid: number; start: string | null; uniq: string | null; ver: number | null; uid: number | null; members: Member[];
  quietAt?: number; pgids?: number[]; sids?: number[] };
/** members：认得出的成员（含根）；unclaimed：认不出归属、但可能是这棵树的孤儿（见文件头） */
export type LiveTree = { members: Proc[]; unclaimed: Proc[] };
export type Scan = () => Proc[] | null;

// ── macOS：libproc / getsid，全程不起子进程（过载时 ps 会超时） ──
type DarwinLib = {
  proc_listallpids: (buf: unknown, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buf: unknown, size: number) => number;
  getsid: (pid: number) => number;
};
let darwin: { lib: DarwinLib; ptr: (b: Parameters<typeof ffiPtr>[0]) => unknown } | null = null;
function darwinLib() {
  if (darwin) return darwin;
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
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
    // proc_bsdinfo：pbi_ppid@16、pbi_uid@20、pbi_pgid@100、启动时刻@120；proc_uniqidentifierinfo@136：p_uniqueid@152、p_puniqueid@160、
    // p_idversion@168、p_orig_ppidversion@172
    out.push({ pid, ppid: view.getUint32(16, true), pgid: view.getUint32(100, true), start: `darwin:${view.getBigUint64(120, true)}.${usec}`,
      uid: view.getUint32(20, true), uniq: String(view.getBigUint64(152, true)), puniq: String(view.getBigUint64(160, true)),
      ver: view.getInt32(168, true), opv: view.getInt32(172, true), sid: Math.max(0, lib.getsid(pid)) || null });
  }
  return out;
}

// ── Linux：/proc ──
function linuxProcesses(): Proc[] {
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const out: Proc[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    let uid: number;
    try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); uid = statSync(`/proc/${name}`).uid; } catch { continue; } // 刚退出
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    if (f[0] === "Z") continue; // 已退出、尚未被父进程收尸的进程不再执行测试
    if (!f[19] || !/^\d+$/.test(f[19])) continue;
    out.push({ pid: Number(name), ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), start: `linux:${boot}:${f[19]}`, uid, uniq: null, puniq: null, ver: null, opv: null });
  }
  return out;
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

/** PID 版本号是 int32 计数，回绕时按差值比：a 不早于 b */
const notBefore = (a: number, b: number) => ((a - b) | 0) >= 0;

/** 这棵树此刻活着的成员（含根）和认不出归属的孤儿。procs 是同一时刻的进程表 */
export function liveTree(root: TreeRoot, procs: Proc[]): LiveTree {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const known: Member[] = [{ pid: root.pgid, start: root.start, uniq: root.uniq, ver: root.ver }, ...root.members];
  const same = (p: Proc, m: Member) => p.pid === m.pid && (m.start === null || p.start === m.start);
  // 组号还被占着就不会分给新进程；组长 PID 现在是别的进程（启动时刻不同）= 原来的组已经没了
  const leader = byPid.get(root.pgid);
  const groupGone = leader !== undefined && root.start !== null && leader.start !== root.start;
  const members = new Map<number, Proc>();
  for (const p of procs) if (known.some((m) => same(p, m)) || (!groupGone && p.pgid === root.pgid)) members.set(p.pid, p);
  const uniqs = new Set(known.map((m) => m.uniq).filter((u): u is string => u !== null));
  const vers = new Set(known.map((m) => m.ver).filter((v): v is number => v !== null));
  // 已被过继（现父进程的唯一 ID 不是它的原始父进程唯一 ID）、原始父进程不早于根出生（exec 会换版本号，根登记的是 exec 前的，偏宽）、
  // 同一用户：这棵树的孤儿只可能长这样（macOS，有版本号才判得出）
  const orphanSinceRoot = (p: Proc) => {
    if (root.uid !== null && p.uid !== root.uid) return false;
    if (root.ver !== null && p.ver !== null && p.opv !== null) return notBefore(p.opv, root.ver) &&
      !(p.puniq !== null && byPid.get(p.ppid)?.uniq === p.puniq);
    // Linux 没有原始父进程版本；只把根启动后、已过继给 init 的同用户进程算为不可归属候选。
    return p.ppid === 1 && p.start.startsWith("linux:") && root.start?.startsWith("linux:") === true &&
      Number(p.start.split(":").at(-1)) >= Number(root.start.split(":").at(-1));
  };
  const pgids = new Set(root.pgids ?? [root.pgid]);
  const sids = new Set(root.sids ?? []);
  if (groupGone) { pgids.delete(root.pgid); sids.delete(root.pgid); }
  for (;;) {
    for (const p of members.values()) {
      pgids.add(p.pgid);
      if (p.sid) sids.add(p.sid);
      if (p.uniq) uniqs.add(p.uniq);
      if (p.ver !== null) vers.add(p.ver);
    }
    const before = members.size;
    for (const p of procs) {
      if (members.has(p.pid)) continue;
      if (pgids.has(p.pgid) || (p.sid != null && sids.has(p.sid)) || (p.opv !== null && vers.has(p.opv)) || (p.puniq !== null && p.puniq !== "1" && uniqs.has(p.puniq)) ||
        (p.ppid > 1 && members.has(p.ppid))) members.set(p.pid, p);
    }
    if (members.size !== before) continue;
    break;
  }
  const unclaimed = procs.filter((p) => !members.has(p.pid) && orphanSinceRoot(p));
  return { members: [...members.values()], unclaimed };
}

/** 保存本次见到的成员与归属键，供持有者退出后的申请者继续追踪。 */
export function rememberTree(tree: TreeRoot, live: LiveTree): TreeRoot {
  return { ...tree,
    pgids: [...new Set([...(tree.pgids ?? [tree.pgid]), ...live.members.map((p) => p.pgid)])],
    sids: [...new Set([...(tree.sids ?? []), ...live.members.flatMap((p) => p.sid ? [p.sid] : [])])],
    members: live.members.filter((p) => p.pid !== tree.pgid).map((p) => ({ pid: p.pid, start: p.start, uniq: p.uniq, ver: p.ver })),
    quietAt: live.members.length ? undefined : live.unclaimed.length ? tree.quietAt ?? Date.now() : undefined,
  };
}
