/**
 * 采样见过的后代按 PID + 启动时刻追踪，并记住它的 pgid / sid；脱组、过继不使成员按时间过期。
 * pgid / sid 归属键绑定组长 / 会话首进程的启动时刻，号被复用或组 / 会话没了就剪掉；经键传递认进来的进程不得早于根启动。
 * 登记时记下开机标识，换了一次开机的记录整棵按 absent（重启后旧号都是系统进程）。
 * 父节点在首次采样前退出且脱离所有已知组/会话时，只能认作 unclaimed；宽限释放是已接受的负载闸近似。
 * 不读取其他进程的环境。读不出进程表时保留名额，详见 docs/architecture/full-test-gate.md。
 */
import { dlopen, FFIType, ptr as ffiPtr } from "bun:ffi";
import { readdirSync, readFileSync, statSync } from "node:fs";

/** ver / opv：macOS 的 PID 版本号（p_idversion）和原始父进程的 PID 版本号（p_orig_ppidversion）；Linux 为 null */
export type Proc = { pid: number; ppid: number; pgid: number; start: string; uid: number | null; uniq: string | null; puniq: string | null;
  ver: number | null; opv: number | null; sid?: number | null };
type Member = { pid: number; start: string | null; uniq: string | null; ver: number | null };
/** 归属键：pgid / sid 号 + 记下时组长（会话首进程，pid == 号）的启动时刻；当时组长已不在为 null */
export type Key = { id: number; leaderStart: string | null };
/**
 * 登记的树：根（bun test，pgid = 它的 PID）+ 上次扫到的活成员；quietAt：认得出的成员都没了、只剩 unclaimed 的那一刻（full-test-gate.ts 的宽限）。
 * boot：登记时的开机标识（旧记录没有）；pgids / sids：旧记录是纯数字数组，读时按 normalizeKeys 兼容
 */
export type TreeRoot = { pgid: number; start: string | null; uniq: string | null; ver: number | null; uid: number | null; members: Member[];
  quietAt?: number; boot?: string | null; pgids?: (number | Key)[]; sids?: (number | Key)[] };
/** members：认得出的成员（含根）；unclaimed：认不出归属、但可能是这棵树的孤儿（见文件头）；pgids / sids：本次剪过、补过的归属键 */
export type LiveTree = { members: Proc[]; unclaimed: Proc[]; pgids: Key[]; sids: Key[] };
export type Scan = () => Proc[] | null;

// ── macOS：libproc / getsid，全程不起子进程（过载时 ps 会超时） ──
type DarwinLib = {
  proc_listallpids: (buf: unknown, size: number) => number;
  proc_pidinfo: (pid: number, flavor: number, arg: bigint, buf: unknown, size: number) => number;
  getsid: (pid: number) => number;
  sysctlbyname: (name: unknown, oldp: unknown, oldlenp: unknown, newp: unknown, newlen: bigint) => number;
};
let darwin: { lib: DarwinLib; ptr: (b: Parameters<typeof ffiPtr>[0]) => unknown } | null = null;
function darwinLib() {
  if (darwin) return darwin;
  const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
    sysctlbyname: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
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

/** 本次开机：id 是开机标识（Linux boot_id；macOS kern.bootsessionuuid——kern.boottime 会随校时漂移，不拿它当标识）；
 *  at 是开机时刻，与进程启动时刻同一写法（macOS 才有，判没记开机标识的旧记录用） */
export type Boot = { id: string; at: string | null };
let bootCache: Boot | null = null;

function darwinSysctl(name: string, size: number): Uint8Array {
  const { lib, ptr } = darwinLib();
  const buf = new Uint8Array(size);
  const len = new BigUint64Array([BigInt(size)]);
  if (lib.sysctlbyname(ptr(Buffer.from(`${name}\0`)), ptr(buf), ptr(len), null, 0n) !== 0) throw new Error(`sysctlbyname ${name} failed`);
  return buf.subarray(0, Number(len[0]));
}

/** 本次开机的标识；读不出返回 null（调用方按 unknown 处理，不释放）。不起子进程 */
export function currentBoot(): Boot | null {
  if (bootCache) return bootCache;
  try {
    if (process.platform === "linux") {
      const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (id) bootCache = { id, at: null };
    } else if (process.platform === "darwin") {
      const raw = darwinSysctl("kern.bootsessionuuid", 64);
      const id = new TextDecoder().decode(raw.subarray(0, raw.indexOf(0) < 0 ? raw.length : raw.indexOf(0)));
      const tv = new DataView(darwinSysctl("kern.boottime", 16).buffer); // struct timeval：tv_sec@0(int64)、tv_usec@8(int32)
      if (/^[0-9a-f-]{36}$/i.test(id)) bootCache = { id, at: `darwin:${tv.getBigInt64(0, true)}.${String(tv.getInt32(8, true)).padStart(6, "0")}` };
    }
  } catch (e) {
    console.error(`[full-test-gate] 读不出开机标识：${String(e)}`);
  }
  return bootCache;
}

/** 启动时刻能比的部分：同一 era（macOS 墙钟 / Linux 同一 boot_id 的 tick）内可比；认不出的写法返回 null */
function startAt(s: string | null): { era: string; t: bigint } | null {
  const d = s === null ? null : /^darwin:(\d+)\.(\d+)$/.exec(s);
  if (d) return { era: "darwin", t: BigInt(d[1]!) * 1_000_000n + BigInt(d[2]!) };
  const l = s === null ? null : /^linux:([^:]+):(\d+)$/.exec(s);
  return l ? { era: `linux:${l[1]}`, t: BigInt(l[2]!) } : null;
}
/** a 确定早于 b；比不了（写法认不出、不同开机）不算早，沿用旧判定 */
function earlier(a: string | null, b: string | null): boolean {
  const x = startAt(a);
  const y = startAt(b);
  return x !== null && y !== null && x.era === y.era && x.t < y.t;
}

/**
 * 这棵树和本次开机的关系：记录的开机标识不同 → other（整棵 absent）；旧记录没开机标识时，根启动早于本次开机也是 other；
 * 读不出开机标识 → unknown（不释放），先于一切兼容分支判：没有开机字段、根启动时刻为 null 或认不出写法的记录也一样；
 * 开机标识读得出、根启动时刻认不出写法、比不了 → same（沿用旧判定）
 */
export function bootState(root: TreeRoot, boot: () => Boot | null = currentBoot): "same" | "other" | "unknown" {
  const b = boot();
  if (b === null) return "unknown";
  if (root.boot) return b.id === root.boot ? "same" : "other";
  const linux = root.start === null ? null : /^linux:([^:]+):\d+$/.exec(root.start);
  if (linux) return b.id === linux[1] ? "same" : "other";
  if (startAt(root.start)?.era === "darwin") return b.at === null ? "unknown" : earlier(root.start, b.at) ? "other" : "same";
  return "same";
}

/** 读记录里的归属键：旧格式的纯数字按组长启动时刻未知（根自己的组号取根启动时刻）；0 和 1 永不收；pgids 缺省 = 只有根的组 */
export function normalizeKeys(root: TreeRoot, raw: (number | Key)[] | undefined, kind: "pgid" | "sid"): Key[] {
  const list = raw ?? (kind === "pgid" ? [root.pgid] : []);
  const out = new Map<number, Key>();
  for (const k of list) {
    const key = typeof k === "number" ? { id: k, leaderStart: k === root.pgid ? root.start : null } : k;
    if (key.id > 1 && !out.has(key.id)) out.set(key.id, key);
  }
  return [...out.values()];
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

/** 这棵树此刻活着的成员（含根）、认不出归属的孤儿和剪过的归属键。procs 是同一时刻的进程表 */
export function liveTree(root: TreeRoot, procs: Proc[]): LiveTree {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const known: Member[] = [{ pid: root.pgid, start: root.start, uniq: root.uniq, ver: root.ver }, ...root.members];
  const same = (p: Proc, m: Member) => p.pid === m.pid && (m.start === null || p.start === m.start);
  const isKnown = (p: Proc) => known.some((m) => same(p, m));
  // 剪键：pid == 号的进程还在但启动时刻不同（号被复用；旧记录不知道组长时刻，就看它是不是认得的成员）→ 作废；
  // 没有进程的 pgid / sid 是这个号、也没有 pid == 号的进程 → 组 / 会话已经没了（号被占着时内核不会把它分给新进程）
  const prune = (keys: Key[], of: (p: Proc) => number | null | undefined) => {
    const out = new Map<number, Key>();
    for (const k of keys) {
      const leader = byPid.get(k.id);
      if (leader) {
        if (k.leaderStart !== null ? leader.start !== k.leaderStart : !isKnown(leader)) continue;
        out.set(k.id, { id: k.id, leaderStart: leader.start });
      } else if (procs.some((p) => of(p) === k.id)) out.set(k.id, k);
    }
    return out;
  };
  const pgids = prune(normalizeKeys(root, root.pgids, "pgid"), (p) => p.pgid);
  const sids = prune(normalizeKeys(root, root.sids, "sid"), (p) => p.sid);
  const members = new Map<number, Proc>();
  for (const p of procs) if (isKnown(p)) members.set(p.pid, p);
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
  // 与根不同用户的进程不贡献键；号 0 / 1 永不收
  const addKey = (keys: Map<number, Key>, id: number | null | undefined) => {
    if (id && id > 1 && !keys.has(id)) keys.set(id, { id, leaderStart: byPid.get(id)?.start ?? null });
  };
  for (;;) {
    for (const p of members.values()) {
      if (root.uid === null || p.uid === root.uid) { addKey(pgids, p.pgid); addKey(sids, p.sid); }
      if (p.uniq) uniqs.add(p.uniq);
      if (p.ver !== null) vers.add(p.ver);
    }
    const before = members.size;
    for (const p of procs) {
      if (members.has(p.pid)) continue;
      // 经键传递认进来的不得早于根启动：重启后 / PID 复用后占着旧号的系统进程比根老
      const byKey = pgids.has(p.pgid) || (p.sid != null && sids.has(p.sid)) || (p.opv !== null && vers.has(p.opv)) ||
        (p.puniq !== null && p.puniq !== "1" && uniqs.has(p.puniq));
      if ((byKey && !earlier(p.start, root.start)) || (p.ppid > 1 && members.has(p.ppid))) members.set(p.pid, p);
    }
    if (members.size !== before) continue;
    break;
  }
  const unclaimed = procs.filter((p) => !members.has(p.pid) && orphanSinceRoot(p));
  return { members: [...members.values()], unclaimed, pgids: [...pgids.values()], sids: [...sids.values()] };
}

/** 保存本次见到的成员与剪过的归属键（不再只增不减），供持有者退出后的申请者继续追踪。 */
export function rememberTree(tree: TreeRoot, live: LiveTree): TreeRoot {
  return { ...tree, pgids: live.pgids, sids: live.sids,
    members: live.members.filter((p) => p.pid !== tree.pgid).map((p) => ({ pid: p.pid, start: p.start, uniq: p.uniq, ver: p.ver })),
    quietAt: live.members.length ? undefined : live.unclaimed.length ? tree.quietAt ?? Date.now() : undefined,
  };
}
