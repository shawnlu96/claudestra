/**
 * 本机部署入口(deploy-full / card-merge 等)整机共享的一把互斥锁:同一时刻只一份进入合并取源 / 部署 / 重载关键区。
 * - 创建:完整 JSON 记录先写进排他临时文件,再 link 到锁路径(目标已存在就失败),锁从诞生起就带完整身份,没有「先查再建」窗口。
 * - 所有权:每次持有一个随机 token;释放 / 更新记录前核 token,旧句柄的释放删不掉新持有者的锁。
 * - 死活只看进程身份(pid + uid + ps lstart 代次),不看年龄 / mtime:活持有者永不被偷;pid 复用(代次不符)算死;
 *   EPERM / ps 读不到 / uid 不符 = 未知,按占用处理直到超时。接管者之间用 file-lock 的接管锁互斥,确认已死后重读仍是它才删。
 * - 部署进程树:wrapper 把部署命令起在独立进程组(组长是执行闸),组号随子进程身份落盘;组里还有任何进程(含孙进程)= 仍持有。
 *   身份落盘前执行闸不放行,身份查不到 / 不是组长都 fail-closed。
 * - 受控重入:只有拿着持有者 token、持有者与执行闸确是自己祖先、且自己就在外层监管的进程组里才放行(card-merge 嵌套调 deploy-full);
 *   光有 env 不够,出了组(detached / setsid)的嵌套调用明确拒绝。
 * 持锁不是授权:这里不提供任何远程 / HTTP 入口,只在本机串行。
 */
import { linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { parseState, writeTextAtomicSync } from "./state-file.js";
import { ancestorPids } from "./takeover.js";
import { STATE_DIR } from "./paths.js";

/** 外层 wrapper 传给子进程的持有者 token;嵌套的 wrapper 核对它 + 祖先关系后才重入 */
export const DEPLOY_LOCK_TOKEN_ENV = "CLAUDESTRA_PM_DEPLOY_LOCK_TOKEN";
/** 整机一把:不按项目 / label 分锁 */
export const deployLockPath = (): string => join(STATE_DIR, "pm-deploy.lock");

const LABEL_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const POLL_MS = 250;

interface ProcIdentity {
  pid: number;
  /** `ps -o lstart=`(C locale、空白归一):同一 pid 的不同进程代次;null = 记录时读不到 */
  startId: string | null;
  /** 有值时 = 该进程是此进程组组长(pgid === pid):组里任何进程活着都算活 */
  pgid?: number;
}

export interface DeployLockRecord {
  v: 1;
  token: string;
  label: string;
  uid: number;
  holder: ProcIdentity;
  /** wrapper 起的部署子进程:wrapper 被 SIGKILL 时它可能还在跑,也算持有 */
  child?: ProcIdentity;
  acquiredAt: string;
}

type Liveness = "live" | "dead" | "unknown";

/** 进程探针(测试可注入);真实实现走 kill(pid,0) 与 ps */
export interface ProcProbe {
  signal0(pid: number): "alive" | "dead" | "unknown";
  startOf(pid: number): string | null;
  ppidOf(pid: number): number | null;
  pgidOf(pid: number): number | null;
  /** kill(-pgid, 0):组里还有进程 alive;ESRCH dead;其它 unknown */
  groupSignal0(pgid: number): "alive" | "dead" | "unknown";
  uid(): number;
}

function ps(field: string, pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", `${field}=`, "-p", String(pid)], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C", LC_TIME: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = r.exitCode === 0 ? r.stdout.toString().replace(/\s+/g, " ").trim() : "";
  return out || null;
}

function signal0(target: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(target, 0);
    return "alive";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; // EPERM 等:存在与否证明不了
  }
}

function psInt(field: string, pid: number): number | null {
  const v = ps(field, pid);
  return v && /^\d+$/.test(v) ? +v : null;
}

export const realProbe: ProcProbe = {
  signal0,
  startOf: (pid) => ps("lstart", pid),
  ppidOf: (pid) => psInt("ppid", pid),
  pgidOf: (pid) => psInt("pgid", pid),
  groupSignal0: (pgid) => signal0(-pgid),
  uid: () => process.getuid?.() ?? -1,
};

/**
 * 进程组组长的组:组长 pid 还在 → 按代次判(代次不符 = pid 已被复用,而组号还被占用时内核不会复用该 pid,说明原组已空);
 * 组长已不在 → 看组里还有没有进程(组号在用时 pid 不会被复用,所以这个组只能是原来那组)。
 */
function procState(p: ProcIdentity, probe: ProcProbe): Liveness {
  const s = probe.signal0(p.pid);
  if (s === "dead" && p.pgid !== undefined) return groupState(probe.groupSignal0(p.pgid));
  if (s !== "alive") return s;
  if (!p.startId) return "unknown";
  const now = probe.startOf(p.pid);
  if (now === null) return "unknown";
  return now === p.startId ? "live" : "dead"; // 代次不符 = pid 已被复用,原持有者已死
}

function groupState(s: "alive" | "dead" | "unknown"): Liveness {
  return s === "alive" ? "live" : s;
}

/** 持有者(及其部署子进程)死活:任何一个活着 = live;都证明已死才 dead;其余 unknown */
export function holderLiveness(rec: DeployLockRecord, probe: ProcProbe = realProbe): Liveness {
  if (rec.uid !== probe.uid()) return "unknown";
  const states = [rec.holder, ...(rec.child ? [rec.child] : [])].map((p) => procState(p, probe));
  if (states.includes("live")) return "live";
  return states.every((s) => s === "dead") ? "dead" : "unknown";
}

function validIdentity(p: unknown): p is ProcIdentity {
  const o = p as ProcIdentity;
  return !!o && Number.isSafeInteger(o.pid) && o.pid > 1 && (o.pgid === undefined || o.pgid === o.pid) && (o.startId === null || (typeof o.startId === "string" && o.startId.length > 0));
}

function validRecord(d: unknown): boolean {
  const r = d as DeployLockRecord;
  return !!r && r.v === 1 && typeof r.token === "string" && r.token.length >= 16 && LABEL_RE.test(r.label)
    && Number.isSafeInteger(r.uid) && validIdentity(r.holder) && (r.child === undefined || validIdentity(r.child))
    && typeof r.acquiredAt === "string";
}

type LockRead = { status: "missing" } | { status: "corrupt"; error: string } | { status: "ok"; record: DeployLockRecord };

export function readDeployLock(path: string): LockRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", error: `读取失败: ${(e as Error).message}` };
  }
  const r = parseState(raw, validRecord);
  return r.status === "ok" ? { status: "ok", record: r.data as DeployLockRecord } : r;
}

/** 完整记录先写排他临时文件再 link:目标已存在 → false;其它文件系统错误照抛 */
function tryCreate(path: string, rec: DeployLockRecord): boolean {
  const tmp = `${path}.${process.pid}.${rec.token.slice(0, 8)}.new`;
  let err: NodeJS.ErrnoException | undefined;
  try {
    writeFileSync(tmp, JSON.stringify(rec), { flag: "wx", mode: 0o600 });
    linkSync(tmp, path);
  } catch (e) {
    err = e as NodeJS.ErrnoException;
  } finally {
    rmSync(tmp, { force: true });
  }
  if (!err) return true;
  if (err.code === "EEXIST" && err.syscall === "link") return false; // 锁已被别人持有
  throw err;
}

/**
 * 已证明死亡的持有者:拿接管锁后重读、重判,仍是同一 token 且仍已死才删(只有持有者本人和接管者会删锁)。
 * 返回 true = 锁已删 / 已换人,马上重读;false = 这轮没接管成,按占用走超时检查。
 */
async function reapDead(path: string, seen: DeployLockRecord, probe: ProcProbe): Promise<boolean> {
  const guard = await acquireLock(`${path}.reap`, 1_000);
  if (!guard) return false; // 别的接管者正在处理:按占用走超时检查,下一轮重读
  try {
    const cur = readDeployLock(path);
    if (cur.status !== "ok" || cur.record.token !== seen.token) return true;
    if (holderLiveness(cur.record, probe) !== "dead" || !guard.held()) return false;
    unlinkSync(path);
    return true;
  } finally {
    guard.release();
  }
}

export interface DeployLockHandle {
  readonly record: DeployLockRecord;
  /** 核 token 再删:旧句柄 / 已失租的句柄不会删掉新持有者的锁 */
  release(): "released" | "not-owner" | "gone";
  /**
   * 把部署子进程身份写进记录(token 核对后原子替换)。代次查不到、group 时不是组长、写不进去都抛错,调用方 fail-closed
   * (wrapper 在这之前不放行执行闸,子进程一步部署都没做)。
   */
  recordChild(pid: number, opts?: { group?: boolean }): void;
}

function makeHandle(path: string, record: DeployLockRecord, probe: ProcProbe): DeployLockHandle {
  let current = record;
  const mine = () => {
    const r = readDeployLock(path);
    return r.status === "ok" && r.record.token === record.token;
  };
  return {
    get record() { return current; },
    release() {
      const r = readDeployLock(path);
      if (r.status === "missing") return "gone";
      if (r.status !== "ok" || r.record.token !== record.token) return "not-owner";
      unlinkSync(path);
      return "released";
    },
    recordChild(pid, opts = {}) {
      const startId = probe.startOf(pid);
      if (!startId) throw new Error(`读不到部署子进程 ${pid} 的启动代次(ps lstart),身份不可核`);
      const child: ProcIdentity = { pid, startId };
      if (opts.group) {
        const pgid = probe.pgidOf(pid);
        if (pgid !== pid) throw new Error(`部署子进程 ${pid} 不是自己进程组的组长(pgid=${pgid ?? "读不到"})`);
        child.pgid = pid;
      }
      const next: DeployLockRecord = { ...current, child };
      writeTextAtomicSync(path, JSON.stringify(next), { mode: 0o600, noFollow: true, commitIf: mine });
      current = next;
    },
  };
}

type AcquireResult =
  | { kind: "acquired"; handle: DeployLockHandle }
  | { kind: "timeout"; holder: DeployLockRecord | null; state: Liveness | "corrupt" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

interface AcquireOpts {
  label: string;
  /** 有界等待;0 = 只试一次 */
  waitMs: number;
  path?: string;
  probe?: ProcProbe;
  pollMs?: number;
  /** 收到信号等:返回 true 立即放弃(不进入关键区) */
  aborted?: () => boolean;
  /** 第一次看到某个持有者在占用时回调一次(打印诊断) */
  onWait?: (holder: DeployLockRecord, state: Liveness) => void;
}

function selfRecord(label: string, probe: ProcProbe): DeployLockRecord | string {
  if (!LABEL_RE.test(label)) return `label 不合法(只许 [A-Za-z0-9._:-],≤64):${JSON.stringify(label)}`;
  const startId = probe.startOf(process.pid);
  if (!startId) return "读不到本进程的启动代次(ps lstart),无法建立可核身份";
  const uid = probe.uid();
  if (uid < 0) return "读不到本进程 uid";
  const token = randomBytes(16).toString("hex");
  return { v: 1, token, label, uid, holder: { pid: process.pid, startId }, acquiredAt: new Date().toISOString() };
}

/** 拿整机部署锁。永不抛:取锁 / 身份错误返回 error,调用方据此 fail-closed(零部署) */
export async function acquireDeployLock(opts: AcquireOpts): Promise<AcquireResult> {
  const path = opts.path ?? deployLockPath();
  const probe = opts.probe ?? realProbe;
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  let announced = "";
  let last: { holder: DeployLockRecord | null; state: Liveness | "corrupt" } = { holder: null, state: "unknown" };
  try {
    const rec = selfRecord(opts.label, probe);
    if (typeof rec === "string") return { kind: "error", message: rec };
    mkdirSync(dirname(path), { recursive: true });
    for (;;) {
      if (opts.aborted?.()) return { kind: "aborted" };
      if (tryCreate(path, rec)) return { kind: "acquired", handle: makeHandle(path, rec, probe) };
      const cur = readDeployLock(path);
      if (cur.status === "missing") continue; // 持有者刚释放:马上重抢
      if (cur.status === "corrupt") {
        // link 建锁不会留下半截记录:内容不对只能是外部改动,不删、不猜,有界等待后按超时报
        last = { holder: null, state: "corrupt" };
      } else {
        const state = holderLiveness(cur.record, probe);
        if (state === "dead" && (await reapDead(path, cur.record, probe))) continue;
        last = { holder: cur.record, state };
        if (announced !== cur.record.token) opts.onWait?.(cur.record, state);
        announced = cur.record.token;
      }
      if (Date.now() >= deadline) return { kind: "timeout", ...last };
      await Bun.sleep(Math.min(opts.pollMs ?? POLL_MS, Math.max(1, deadline - Date.now())));
    }
  } catch (e) {
    return { kind: "error", message: `部署锁出错(${path}):${(e as Error).message}` };
  }
}

export type Reentry =
  | { kind: "none" }
  | { kind: "nested"; record: DeployLockRecord }
  | { kind: "rejected"; reason: string };

/**
 * 受控重入:env 里的 token 正是当前持有者的,且持有者活着、确是本进程的祖先(ppid 链)→ 再核本进程确在外层监管的进程组里:
 * 记录里有执行闸(组长)身份且仍活着、闸是本进程祖先、本进程 pgid === 闸的组号。都核上 → nested,调用方不再取锁、在这个组里执行
 * (外层整组转发信号、等整组退完才释放)。持有者是祖先但组核不上(detached / setsid 出组、ps 读不到)→ rejected,调用方 fail-closed:
 * 出了组的进程外层既转发不到信号、也不会等它,放行就会在外层释放后与下一份重叠。
 * token / 持有者 / 祖先关系核不上(包括 ps 读不到)→ none,调用方走正常取锁(冒用者照样互斥,有界等到超时,零部署)。
 */
export function reentrantHolder(envToken: string | undefined, opts: { path?: string; probe?: ProcProbe } = {}): Reentry {
  const none = { kind: "none" } as const;
  if (!envToken) return none;
  const probe = opts.probe ?? realProbe;
  const cur = readDeployLock(opts.path ?? deployLockPath());
  if (cur.status !== "ok" || cur.record.token !== envToken) return none;
  const rec = cur.record;
  if (procState(rec.holder, probe) !== "live" || rec.uid !== probe.uid()) return none;
  const ancestors = ancestorPids(process.pid, (p) => probe.ppidOf(p));
  if (!ancestors.has(rec.holder.pid)) return none;
  const gate = rec.child;
  const reject = (why: string): Reentry => ({ kind: "rejected", reason: `嵌套部署不在外层监管的进程组里:${why}` });
  if (gate?.pgid === undefined) return reject("锁记录没有外层执行闸的进程组");
  if (procState(gate, probe) !== "live") return reject(`外层执行闸 ${gate.pid} 已不在`);
  if (!ancestors.has(gate.pid)) return reject(`外层执行闸 ${gate.pid} 不是本进程祖先`);
  const mine = probe.pgidOf(process.pid);
  if (mine !== gate.pgid) return reject(`本进程组=${mine ?? "读不到"},外层监管组=${gate.pgid}(detached / setsid 起的嵌套调用)`);
  return { kind: "nested", record: rec };
}

/** 诊断行:持有者 label / pid / 代次 / 获取时间 / 死活判断 */
export function describeHolder(rec: DeployLockRecord | null, state: Liveness | "corrupt"): string {
  if (!rec) return state === "corrupt" ? "锁记录内容异常(不自动删除:确认没有部署在跑后手动删锁文件)" : "持有者未知";
  const child = rec.child
    ? ` child=${rec.child.pid}(${rec.child.startId ?? "代次未知"}${rec.child.pgid !== undefined ? ` 进程组=${rec.child.pgid}` : ""})`
    : "";
  return `label=${rec.label} pid=${rec.holder.pid} 代次=${rec.holder.startId ?? "未知"}${child} 获取于=${rec.acquiredAt} 判定=${state}`;
}
