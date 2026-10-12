/** per-agent restart 文件锁（kill / list / remove 也看它——窗口暂时不在可能是 restart 在重建）。 */
import * as nodeFs from "fs";
import { randomBytes } from "crypto";
import { statePath } from "../lib/paths.js";
import { pidAlive as realPidAlive } from "../lib/pending-ops.js";

/**
 * per-agent restart 跨进程互斥：launcher 的 boot / periodic restore、web、手动 restart 是各自独立的
 * `bun run manager.ts restart` 子进程，进程内 Map 锁挡不住；两个交错就会把启动命令打进别人刚建的窗口。
 *
 * 锁文件 = `pid\nts\ntoken\n`（老格式 `pid\nts` 照认）。三条不变量（tests/restart-lock-audit.test.ts）：
 *   - 只有持有者自己删活锁：释放时核对 inode + token，路径上已不是自己那把就不删；
 *   - 持有进程活着就一直算占用，没有按时长强接管——超时只出诊断；
 *   - 读不出完整内容的锁（空 / 写了一半 / 损坏）按占用处理并报人工恢复：O_EXCL 建文件到写完 pid 之间它就是空的。
 *
 * 「核对身份」和「删」之间不能换人，靠两层：
 *   1. 建锁、释放、回收死锁、撤回写坏的锁全部在同一把 `.guard` 互斥（O_EXCL）里做，守规矩的进程插不进来；
 *   2. 删除一律走 detach()：先把路径上的文件原子地 rename 到自己独有的名字，再在那个名字上核对——
 *      核对的和删的必然是同一个文件；不是预期的那把就 link 回原位，绝不删（不守规矩的替换也删不到）。
 * 没拿到创建身份（fstat 失败）的文件不认领、不删，留在原位报人工恢复。
 *
 * `.guard` 的持有者崩在里面也要能自动恢复，但「删掉死互斥再重建」正是上面那个换人难题（没有更外层的互斥了），
 * 所以互斥不靠删来接管，靠接链：
 *   - 互斥到位即完整：先在自己独有的名字上写满 `pid\nts\ntoken\n` 再 link 到位，路径上不会出现认不出持有者的空互斥；
 *   - 持有进程已死的互斥谁也不删，后来者在 `.guard.<它的 token>` 上 O_EXCL 建后继——一把死互斥只有一个后继名，
 *     抢到链尾的那个就是唯一持有者。持有进程活着的互斥永远算占用，没有按时长接管；
 *   - 只有链尾持有者清死链，离开时从链头清起、最后才删自己那环；接链的人建完后继再核对链头还是刚才那把，
 *     换了 = 前任已经开始清链，这个后继名作废，撤回重来（所以清到一半崩了，剩下的环也没人会接上去）。
 * 认不出持有者的互斥（外来的空 / 损坏文件）和叠得过深的死链照旧阻塞并报人工恢复。
 */
const RESTART_LOCK_DIR = statePath("locks");
/** 活锁超过这个时长只多报一句诊断（pid 复用时人能看出来），不接管 */
const RESTART_LOCK_LONG_MS = 3 * 60_000;
/** 互斥正常只存在毫秒级；超过这个时长还进不去，报人工恢复 */
const GUARD_LONG_MS = 60_000;
/** 死互斥最多接这么多层（每层 = 一次崩在互斥里且之后没人成功清过链）；再深就报人工恢复，不无限往下走 */
const GUARD_CHAIN_MAX = 4;
/** 互斥被占时的有界等待：获取等 ~100ms（等不到就算没抢到），释放等 ~1s（锁是自己的，值得多等） */
const GUARD_WAIT_MS = 4;
const GUARD_TRIES_LOCK = 25;
const GUARD_TRIES_UNLOCK = 250;

const NEW_FORMAT = /^(\d{1,10})\n(\d{13})\n([A-Za-z0-9]{16,64})\n$/;
const LEGACY_FORMAT = /^(\d{1,10})\n(\d{13})$/;

type FsOps = Pick<typeof nodeFs, "mkdirSync" | "openSync" | "writeSync" | "closeSync" | "fstatSync" | "readFileSync" | "unlinkSync" | "renameSync" | "linkSync">;

export interface RestartLockDeps {
  dir: string;
  pid: number;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  fs: FsOps;
  /** 诊断出口（生产 = stderr；manager 的 stdout 是给调用方解析的 JSON） */
  warn: (msg: string) => void;
  /** 等互斥时的同步小睡（缺省真睡；测试注入空函数） */
  sleep?: (ms: number) => void;
}

export type RestartLockState =
  | { state: "free"; path: string }
  /** 完整锁，持有进程活着 */
  | { state: "held"; path: string; pid: number; ageMs: number }
  /** 完整锁，持有进程已死：下一次获取会回收 */
  | { state: "dead"; path: string; pid: number; ageMs: number }
  /** 空 / 写了一半 / 损坏 / 读不了 / 互斥被占：按占用处理，detail 说明怎么人工恢复 */
  | { state: "blocked"; path: string; detail: string };

interface Seen { id: string; mtimeMs: number; raw: string; pid: number; ts: number; token: string | null }
type Observed = { kind: "absent" } | { kind: "unreadable"; why: string } | ({ kind: "incomplete" | "complete" } & Seen);
/** 建文件时拿到的身份：inode + 写进去的 token */
interface Made { id: string; token: string }
/** 互斥链上的一环：持有进程已死的完整互斥 */
type DeadLink = Seen & { path: string };
/** 顺着死互斥走到头：tail 是 at 上现在的东西（absent = 可以接在这儿） */
interface GuardWalk { dead: DeadLink[]; at: string; tail: Observed }
/** 本进程持有的互斥：自己那环的路径 + 身份，以及它接在哪些死互斥后面 */
interface Guard extends Made { path: string; dead: DeadLink[] }

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? String(e);
const manual = (path: string, what: string) => `${what}；确认没有 restart 在跑后手动删除 ${path} 即可恢复`;
const realSleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const isMade = (m: Made) => (o: Observed) => o.kind === "complete" && o.id === m.id && o.token === m.token;
const isSeen = (s: Seen) => (o: Observed) => o.kind === "complete" && o.id === s.id && o.raw === s.raw;

/** 一把锁的全部操作，依赖全注入（测试用临时目录、假 pid、假时钟、计数 fs）。生产实例在文件末尾。 */
export class RestartLock {
  /** 本实例拿到的锁：name → 建锁时的身份。释放只认这里有记录、且盘上还对得上的 */
  private owned = new Map<string, Made>();
  constructor(private deps: RestartLockDeps) {}

  private pathOf(name: string) { return `${this.deps.dir}/restart-${name}.lock`; }

  /** 读一把锁：同一个 fd 上取 inode 和内容，两者说的是同一个文件 */
  private observe(path: string): Observed {
    const { fs } = this.deps;
    let fd: number;
    try { fd = fs.openSync(path, "r"); } catch (e) {
      return code(e) === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", why: code(e) };
    }
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      const at = { id: `${st.dev}:${st.ino}`, mtimeMs: Number(st.mtimeMs) };
      const raw = fs.readFileSync(fd, "utf8");
      const m = NEW_FORMAT.exec(raw) ?? LEGACY_FORMAT.exec(raw);
      if (!m) return { kind: "incomplete", ...at, raw, pid: 0, ts: 0, token: null };
      return { kind: "complete", ...at, raw, pid: Number(m[1]), ts: Number(m[2]), token: m[3] ?? null };
    } catch (e) {
      return { kind: "unreadable", why: code(e) };
    } finally {
      try { fs.closeSync(fd); } catch { /* 只读 fd，关不掉没有可补救的 */ }
    }
  }

  private classify(path: string, o: Observed): RestartLockState {
    if (o.kind === "absent") return { state: "free", path };
    if (o.kind === "unreadable") return { state: "blocked", path, detail: manual(path, `restart 锁读不了（${o.why}）`) };
    if (o.kind === "incomplete") {
      const what = o.raw === "" ? "restart 锁是空的（持有者正在写，或建锁后崩了）" : `restart 锁内容不完整或已损坏（${o.raw.length} 字符）`;
      return { state: "blocked", path, detail: manual(path, what) };
    }
    const ageMs = this.deps.now() - o.ts;
    return { state: this.deps.pidAlive(o.pid) ? "held" : "dead", path, pid: o.pid, ageMs };
  }

  /** 受保护的删除：不按路径「核对完再删」，而是先把路径上的文件 rename 到自己独有的名字，在那个名字上核对。
   *  是预期的那把 → 删掉，"gone"；不是 → link 回原位（原位已有文件时 link 失败、不覆盖），"kept"。原位本来就空 = "absent"。 */
  private detach(name: string, path: string, expected: (o: Observed) => boolean, what: string): "gone" | "absent" | "kept" | "failed" {
    const { fs, warn } = this.deps;
    const aside = `${path}.rm-${this.deps.pid}-${randomBytes(6).toString("hex")}`;
    try { fs.renameSync(path, aside); } catch (e) {
      if (code(e) === "ENOENT") return "absent";
      return warn(`[restart-lock] ${name} ${what}失败（${code(e)}）：${path}`), "failed";
    }
    if (expected(this.observe(aside))) {
      try { fs.unlinkSync(aside); } catch (e) { warn(`[restart-lock] ${name} ${what}失败（${code(e)}），残留文件可直接删：${aside}`); }
      return "gone";
    }
    try { fs.linkSync(aside, path); } catch (e) {
      warn(`[restart-lock] ${name} ${what}时挪开的不是预期的文件，放不回原位（${code(e)}）；它现在在 ${aside}，确认没有 restart 在跑后删掉即可`);
      return "kept";
    }
    try { fs.unlinkSync(aside); } catch (e) { warn(`[restart-lock] ${name} 已放回 ${path}，多出的硬链接删不掉（${code(e)}），可直接删：${aside}`); }
    return "kept";
  }

  /** O_EXCL 建文件并写满 `pid\nts\ntoken\n`，fd 无论如何都关。写不进去就撤回自己建的那个 inode；
   *  连 inode 都没拿到（fstat 失败）就没法证明路径上还是自己那个，留在原位报人工恢复。
   *  写坏的文件里没有 token，只剩 inode 号可认，而 inode 号在文件删掉后会被新建的文件复用（ext4 / tmpfs 上立刻就会）。
   *  所以撤回在关 fd 之前做：fd 开着这个号就让不出去，再用 fd 确认自己那个文件还有名字（named）。 */
  private create(name: string, path: string, what: string): Made | "exists" | "failed" {
    const { fs, warn } = this.deps;
    let fd: number;
    try { fd = fs.openSync(path, "wx"); } catch (e) {
      if (code(e) === "EEXIST") return "exists";
      warn(`[restart-lock] ${name} 建${what}失败（${code(e)}）：${path}`);
      return "failed";
    }
    const token = randomBytes(16).toString("hex");
    const body = `${this.deps.pid}\n${this.deps.now()}\n${token}\n`;
    let id: string | null = null;
    let err: unknown = null;
    let full = false;
    try {
      try {
        const st = fs.fstatSync(fd, { bigint: true });
        id = `${st.dev}:${st.ino}`;
        const n = fs.writeSync(fd, body);
        if (n === Buffer.byteLength(body)) full = true; else err = new Error(`short write ${n}`);
      } catch (e) {
        err = e;
      }
      if (err && id) {
        warn(`[restart-lock] ${name} 写${what}失败（${code(err)}），撤回刚建的文件`);
        const own = id;
        this.detach(name, path, (o) => "id" in o && o.id === own && body.startsWith(o.raw) && this.named(fd), `撤回${what}`);
      }
    } finally {
      try { fs.closeSync(fd); } catch (e) { err ??= e; }
    }
    if (!err && id) return { id, token };
    if (!id) return warn(`[restart-lock] ${name} ${manual(path, `写${what}失败（${code(err)}）且没拿到文件身份，不敢删`)}`), "failed";
    if (full) { // 写满了、只是 close 报错：内容完整，凭 inode + token 撤回
      warn(`[restart-lock] ${name} 写${what}失败（${code(err)}），撤回刚建的文件`);
      this.detach(name, path, isMade({ id, token }), `撤回${what}`);
    }
    return "failed";
  }

  /** 这个 fd 的文件在盘上还有名字吗（被 unlink 掉的 nlink = 0）。查不了按没有算 */
  private named(fd: number): boolean {
    try { return this.deps.fs.fstatSync(fd, { bigint: true }).nlink > 0n; } catch { return false; }
  }

  /** 互斥专用的建文件：在自己独有的名字上写满再 link 到位（已有文件时 link 失败、不覆盖），到位即完整 */
  private publish(name: string, target: string): Made | "exists" | "failed" {
    const { fs, warn } = this.deps;
    const tmp = `${target}.new-${this.deps.pid}-${randomBytes(6).toString("hex")}`;
    const made = this.create(name, tmp, "互斥");
    if (made === "exists" || made === "failed") return "failed";
    let out: Made | "exists" | "failed" = made;
    try { fs.linkSync(tmp, target); } catch (e) {
      out = code(e) === "EEXIST" ? "exists" : (warn(`[restart-lock] ${name} 建互斥失败（${code(e)}）：${target}`), "failed");
    }
    try { fs.unlinkSync(tmp); } catch (e) { warn(`[restart-lock] ${name} 互斥的临时文件删不掉（${code(e)}），可直接删：${tmp}`); }
    return out;
  }

  /** 从 `.guard` 起顺着死互斥往下走（只读）。停在第一处不是「完整且持有进程已死」的地方 */
  private walkGuard(guard: string): GuardWalk {
    const dead: DeadLink[] = [];
    let at = guard;
    for (;;) {
      const tail = this.observe(at);
      if (tail.kind !== "complete" || tail.token === null || dead.length >= GUARD_CHAIN_MAX || this.deps.pidAlive(tail.pid)) return { dead, at, tail };
      dead.push({ ...tail, path: at });
      at = `${guard}.${tail.token}`;
    }
  }

  /** 进互斥：链尾空着就建自己那环；被占就有界地等，等不到返回 null（僵住太久的报人工恢复）。 */
  private enter(name: string, path: string, tries: number): Guard | null {
    const guard = `${path}.guard`;
    for (let i = 0; ; i++) {
      const w = this.walkGuard(guard);
      if (w.tail.kind === "absent") {
        const made = this.publish(name, w.at);
        if (made === "failed") return null;
        if (made !== "exists") {
          const head = w.dead[0];
          if (!head || isSeen(head)(this.observe(guard))) return { ...made, path: w.at, dead: w.dead };
          this.detach(name, w.at, isMade(made), "撤回互斥"); // 链头换了：前任已在清链，这个后继名作废
        }
      }
      if (i < tries) { (this.deps.sleep ?? realSleep)(GUARD_WAIT_MS); continue; }
      const o = w.tail;
      if ("mtimeMs" in o && this.deps.now() - o.mtimeMs > GUARD_LONG_MS) {
        const why = o.kind === "incomplete" ? "内容不完整，认不出持有者" : this.deps.pidAlive(o.pid) ? `pid ${o.pid} 还在，不接管` : `死互斥已叠 ${w.dead.length} 层`;
        this.deps.warn(`[restart-lock] ${name} ${manual(w.at, `互斥残留（${why}）`)}`);
      }
      return null;
    }
  }

  /** 出互斥：先从链头起清掉接过来的死互斥（链头没清掉就不动后面的——链还得连着），最后删自己那环 */
  private leave(name: string, guard: Guard): void {
    for (const d of guard.dead) {
      const out = this.detach(name, d.path, isSeen(d), "清理死互斥");
      if (out !== "gone" && out !== "absent") break;
    }
    if (this.detach(name, guard.path, isMade(guard), "释放互斥") !== "kept") return;
    this.deps.warn(`[restart-lock] ${name} 的互斥已不是本进程建的那个，不去删别人的：${guard.path}`);
  }

  /** 在互斥里：建锁；原位是死进程的完整锁就回收一次再建，不自旋 */
  private acquire(name: string, path: string): boolean {
    const { warn } = this.deps;
    for (let attempt = 0; attempt < 2; attempt++) {
      const made = this.create(name, path, "锁");
      if (made === "failed") return false;
      if (made !== "exists") return this.owned.set(name, made), true;
      const seen = this.observe(path);
      const st = this.classify(path, seen);
      if (st.state === "free") continue; // 刚被人工清掉：再建一次
      if (st.state === "blocked") return warn(`[restart-lock] ${name} ${st.detail}`), false;
      if (st.state === "held") {
        if (st.ageMs > RESTART_LOCK_LONG_MS) warn(`[restart-lock] ${name} 的锁已被 pid ${st.pid} 持有 ${Math.round(st.ageMs / 60_000)} 分钟（进程还在，不接管）：${path}`);
        return false;
      }
      if (attempt > 0 || seen.kind !== "complete") return false;
      // 死锁：挪开的必须还是刚才看到的那个 inode、那份内容
      const out = this.detach(name, path, isSeen(seen), "回收死锁");
      if (out !== "gone" && out !== "absent") return false;
    }
    return false;
  }

  /** 非阻塞获取：拿到 true。被活进程占着、锁不完整、互斥被占、回收没成都是 false */
  tryLock(name: string): boolean {
    const { fs, warn } = this.deps;
    const path = this.pathOf(name);
    try { fs.mkdirSync(this.deps.dir, { recursive: true }); } catch (e) { return warn(`[restart-lock] 锁目录建不了（${code(e)}）：${this.deps.dir}`), false; }
    const guard = this.enter(name, path, GUARD_TRIES_LOCK);
    if (!guard) return false;
    try { return this.acquire(name, path); } finally { this.leave(name, guard); }
  }

  /** 释放本实例拿到的锁。路径上已经不是自己那把（被人工删过、别人重建了）就不动它 */
  unlock(name: string): void {
    const { warn } = this.deps;
    const mine = this.owned.get(name);
    if (!mine) return; // 不是本实例拿的锁：没有身份可核，不删
    const path = this.pathOf(name);
    const guard = this.enter(name, path, GUARD_TRIES_UNLOCK);
    if (!guard) return warn(`[restart-lock] ${name} 进不了互斥，锁没释放（本进程退出后它会被当死锁回收）：${path}`);
    try {
      this.owned.delete(name);
      const cur = this.observe(path);
      if (cur.kind === "absent") return;
      if (!isMade(mine)(cur) || this.detach(name, path, isMade(mine), "释放") === "kept") {
        warn(`[restart-lock] ${name} 的锁已不是本进程建的那把，不去删别人的：${path}`);
      }
    } finally {
      this.leave(name, guard);
    }
  }

  /** 只读诊断：这把锁现在是什么状态（不回收、不改盘）。互斥进不去时去抢会被拒，所以没有活持有者时也报 blocked；
   *  只剩死互斥（链尾空着）不算——下一次获取会接过去 */
  inspect(name: string): RestartLockState {
    const path = this.pathOf(name);
    const st = this.classify(path, this.observe(path));
    if (st.state === "held" || st.state === "blocked") return st;
    const w = this.walkGuard(`${path}.guard`);
    if (w.tail.kind === "absent") return st;
    return { state: "blocked", path, detail: manual(w.at, "restart 锁的互斥被占着（有进程正在获取 / 释放，或认不出持有者）") };
  }

  /** 与 tryLock 同一判据：此刻去抢会被拒（活持有者 / 不完整的锁 / 互斥进不去）= 在跑；没锁或死进程的完整锁 = 没在跑 */
  inProgress(name: string): boolean {
    const s = this.inspect(name).state;
    return s === "held" || s === "blocked";
  }
}

const production = new RestartLock({
  dir: RESTART_LOCK_DIR, pid: process.pid, now: Date.now, pidAlive: realPidAlive, fs: nodeFs,
  warn: (msg) => console.error(msg),
});

export function tryLockRestart(tmuxName: string): boolean {
  return production.tryLock(tmuxName);
}

/** 该 agent 是否正有 restart 在跑（cmdList 的 dead 判定要避开这段窗口期）。判据与 tryLockRestart 一致。 */
export function isRestartInProgress(tmuxName: string): boolean {
  return production.inProgress(tmuxName);
}

/** 只释放本进程用 tryLockRestart 拿到的那把 */
export function unlockRestart(tmuxName: string): void {
  production.unlock(tmuxName);
}
