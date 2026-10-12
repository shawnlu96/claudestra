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
 * 死进程的完整锁可以回收，回收在 `.reclaim` 互斥里复核「还是刚才看到的那把」再删，不会读旧删新。
 */
const RESTART_LOCK_DIR = statePath("locks");
/** 活锁超过这个时长只多报一句诊断（pid 复用时人能看出来），不接管 */
const RESTART_LOCK_LONG_MS = 3 * 60_000;
/** 回收互斥正常只存在微秒级；超过这个时长还在 = 回收者崩了，报人工恢复 */
const RECLAIM_MUTEX_LONG_MS = 60_000;

const NEW_FORMAT = /^(\d{1,10})\n(\d{13})\n([A-Za-z0-9]{16,64})\n$/;
const LEGACY_FORMAT = /^(\d{1,10})\n(\d{13})$/;

type FsOps = Pick<typeof nodeFs, "mkdirSync" | "openSync" | "writeSync" | "closeSync" | "fstatSync" | "readFileSync" | "unlinkSync">;

export interface RestartLockDeps {
  dir: string;
  pid: number;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  fs: FsOps;
  /** 诊断出口（生产 = stderr；manager 的 stdout 是给调用方解析的 JSON） */
  warn: (msg: string) => void;
}

export type RestartLockState =
  | { state: "free"; path: string }
  /** 完整锁，持有进程活着 */
  | { state: "held"; path: string; pid: number; ageMs: number }
  /** 完整锁，持有进程已死：下一次获取会回收 */
  | { state: "dead"; path: string; pid: number; ageMs: number }
  /** 空 / 写了一半 / 损坏 / 读不了：按占用处理，detail 说明怎么人工恢复 */
  | { state: "blocked"; path: string; detail: string };

interface Seen { id: string; mtimeMs: number; raw: string; pid: number; ts: number; token: string | null }
type Observed = { kind: "absent" } | { kind: "unreadable"; why: string } | ({ kind: "incomplete" | "complete" } & Seen);

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? String(e);
const manual = (path: string, what: string) => `${what}；确认没有 restart 在跑后手动删除 ${path} 即可恢复`;

/** 一把锁的全部操作，依赖全注入（测试用临时目录、假 pid、假时钟、计数 fs）。生产实例在文件末尾。 */
export class RestartLock {
  /** 本实例拿到的锁：name → 建锁时的 inode 身份 + token。释放只认这里有记录、且盘上还对得上的 */
  private owned = new Map<string, { id: string; token: string }>();
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
      fs.closeSync(fd);
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

  /** O_EXCL 建锁并写满内容。写不进去就删掉自己刚建的空文件（不留一把没人能认领的锁），fd 无论如何都关 */
  private create(name: string, path: string): "ok" | "exists" | "failed" {
    const { fs, warn } = this.deps;
    let fd: number;
    try { fd = fs.openSync(path, "wx"); } catch (e) {
      if (code(e) === "EEXIST") return "exists";
      warn(`[restart-lock] ${name} 建锁失败（${code(e)}）：${path}`);
      return "failed";
    }
    const token = randomBytes(16).toString("hex");
    const body = `${this.deps.pid}\n${this.deps.now()}\n${token}\n`;
    let id: string | null = null;
    let err: unknown = null;
    try {
      const st = fs.fstatSync(fd, { bigint: true });
      id = `${st.dev}:${st.ino}`;
      const n = fs.writeSync(fd, body);
      if (n !== Buffer.byteLength(body)) err = new Error(`short write ${n}`);
    } catch (e) {
      err = e;
    } finally {
      try { fs.closeSync(fd); } catch (e) { err ??= e; }
    }
    if (!err && id) return this.owned.set(name, { id, token }), "ok";
    warn(`[restart-lock] ${name} 写锁失败（${code(err)}），撤回刚建的锁文件`);
    // 只撤自己建的那个 inode（别人不删不完整的锁，它还在原位）；fstat 就失败、没拿到 inode 时什么都还没写，只认空文件
    const left = this.observe(path);
    const mine = (left.kind === "incomplete" || left.kind === "complete") && (id ? left.id === id : left.raw === "");
    if (mine) try { fs.unlinkSync(path); } catch (e) { warn(`[restart-lock] ${name} ${manual(path, `撤回失败（${code(e)}）`)}`); }
    return "failed";
  }

  /** 回收一把死进程的完整锁。所有回收者过同一个 O_EXCL 互斥，在里面复核「路径上还是刚才看到的那把、持有者仍是死的」再删。
   *  true = 原位已空可以重抢；false = 没回收（让给别的回收者 / 锁已换人 / 互斥残留） */
  private reclaim(name: string, path: string, seen: Seen): boolean {
    const { fs, warn } = this.deps;
    const mutex = `${path}.reclaim`;
    let fd: number;
    try { fd = fs.openSync(mutex, "wx"); } catch (e) {
      const held = this.observe(mutex);
      if (code(e) !== "EEXIST") warn(`[restart-lock] ${name} 回收互斥建不了（${code(e)}）：${mutex}`);
      else if ("mtimeMs" in held && this.deps.now() - held.mtimeMs > RECLAIM_MUTEX_LONG_MS) warn(`[restart-lock] ${name} ${manual(mutex, "回收互斥残留（回收者崩了）")}`);
      return false; // 另一个回收者正在处理：这一次不抢
    }
    try {
      const again = this.observe(path);
      if (again.kind === "absent") return true;
      if (again.kind !== "complete" || again.id !== seen.id || again.raw !== seen.raw || this.deps.pidAlive(again.pid)) return false;
      fs.unlinkSync(path);
      return true;
    } catch (e) {
      warn(`[restart-lock] ${name} 回收死锁失败（${code(e)}）：${path}`);
      return false;
    } finally {
      try { fs.closeSync(fd); } catch { /* 关不掉也要继续删互斥，否则回收永久被挡 */ }
      try { fs.unlinkSync(mutex); } catch (e) { warn(`[restart-lock] ${name} ${manual(mutex, `回收互斥删不掉（${code(e)}）`)}`); }
    }
  }

  /** 非阻塞获取：拿到 true。被活进程占着、锁不完整、回收没成都是 false；死锁只回收一次，不自旋 */
  tryLock(name: string): boolean {
    const { fs, warn } = this.deps;
    const path = this.pathOf(name);
    try { fs.mkdirSync(this.deps.dir, { recursive: true }); } catch (e) { return warn(`[restart-lock] 锁目录建不了（${code(e)}）：${this.deps.dir}`), false; }
    for (let attempt = 0; attempt < 2; attempt++) {
      const made = this.create(name, path);
      if (made !== "exists") return made === "ok";
      const seen = this.observe(path);
      const st = this.classify(path, seen);
      if (st.state === "free") continue; // 刚被释放：再抢一次
      if (st.state === "blocked") return warn(`[restart-lock] ${name} ${st.detail}`), false;
      if (st.state === "held") {
        if (st.ageMs > RESTART_LOCK_LONG_MS) warn(`[restart-lock] ${name} 的锁已被 pid ${st.pid} 持有 ${Math.round(st.ageMs / 60_000)} 分钟（进程还在，不接管）：${path}`);
        return false;
      }
      if (attempt > 0 || seen.kind !== "complete" || !this.reclaim(name, path, seen)) return false;
    }
    return false;
  }

  /** 释放本实例拿到的锁。路径上已经不是自己那把（被人工删过、别人重建了）就不动它 */
  unlock(name: string): void {
    const { fs, warn } = this.deps;
    const mine = this.owned.get(name);
    if (!mine) return; // 不是本实例拿的锁：没有身份可核，不删
    this.owned.delete(name);
    const path = this.pathOf(name);
    const cur = this.observe(path);
    if (cur.kind === "absent") return;
    if (cur.kind !== "complete" || cur.id !== mine.id || cur.token !== mine.token) {
      return warn(`[restart-lock] ${name} 的锁已不是本进程建的那把，不去删别人的：${path}`);
    }
    // 核对之后到 unlink 之间路径不会换人：活持有者的锁只有持有者自己删
    try { fs.unlinkSync(path); } catch (e) { if (code(e) !== "ENOENT") warn(`[restart-lock] ${name} 释放失败（${code(e)}）：${path}`); }
  }

  /** 只读诊断：这把锁现在是什么状态（不回收、不改盘） */
  inspect(name: string): RestartLockState { return this.classify(this.pathOf(name), this.observe(this.pathOf(name))); }

  /** 与 tryLock 同一判据：此刻去抢会被拒（活持有者 / 不完整的锁）= 在跑；没锁或死进程的完整锁 = 没在跑 */
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
