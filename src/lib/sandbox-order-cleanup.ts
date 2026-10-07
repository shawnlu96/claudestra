/**
 * 订单沙箱的资源回收：只停属主记录（lib/sandbox-order-owner.ts）里登记、且身份核得上的进程。
 * 动手前要齐四样正面证据：记录可读、订单在终态且没有待交结果、代次没变、worker 确定不在（worker-liveness 四态里的 no_window；
 * running / unknown 不动，no_host 窗口还在、归 lend 循环收）。再核没有别的记录声称同一资源、全部进程身份读得清，最后先保全证据。
 * 任何一步不满足都是零信号零删除；停进程只发给 pid+启动时刻+命令哈希+cwd 都对得上的进程，每次发信号前重核。
 * 不扫目录、不按名字找进程；只删已退出 tmux server 留下的私有 socket，和创建端显式登记、真实路径与 dev/ino 都对得上的自有目录——
 * 后者要等记录里每个进程都确认退出才删，有一个没停掉就整批保留。属主记录与证据在属主目录，永不删。tests/sandbox-order-cleanup.test.ts
 */
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import type { LockHandle } from "./file-lock.js";
import type { LendState } from "./lend-journal.js";
import { statePath } from "./paths.js";
import { pathsOverlap } from "./sandbox.js";
import {
  addSandboxOwned, archiveOwnerEvidence, beginSandboxCleanup, dirIdentity, identityVerdict, listSandboxOwners, lockSandboxCleanupKey, lockSandboxOwner, markSandboxCleanup, ownerReviewDue,
  probeProcess, readSandboxOwner, registerSandboxOwner, socketProblem,
  type OwnedDir, type OwnedResource, type OwnerListing, type ProcessProbe, type RegisterInput, type SandboxOwnerKey, type SandboxOwnerRecord,
} from "./sandbox-order-owner.js";
import type { WorkerLiveness } from "./worker-liveness.js";

/** 订单终态：不会再跑、也不会再交结果（result_pending 等回执，不算） */
const TERMINAL: readonly LendState[] = ["acked", "stopped", "cancelled", "released", "declined"];
/** bridge 先停（不再拉起新进程），再停登记的子进程，最后停 tmux server（连带 pane） */
const STOP_ORDER = ["bridge", "child", "tmux"] as const;

export interface OrderFacts { state: LendState; generation: number; resultPending: boolean }

export interface CleanupDeps {
  /** 订单此刻的事实；null / 抛错 = 不知道 */
  orderFacts(orderId: string): Promise<OrderFacts | null>;
  workerLiveness(worker: string): Promise<WorkerLiveness>;
  /** producer 的订单生命周期锁：回调全程排除换代/恢复，失租时 held() 必须为 false。缺失拒绝清理。 */
  withOrderCleanupLease?: (key: SandboxOwnerKey, run: (held: () => boolean) => Promise<CleanupReport>) => Promise<CleanupReport>;
  probe?: (pid: number) => Promise<ProcessProbe>;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** SIGTERM 之后等多久再 SIGKILL；SIGKILL 之后等多久认停不掉 */
  graceMs?: number;
  killWaitMs?: number;
  now?: () => number;
}

type ResourceOutcome = "retained" | "stopped" | "already_exited" | "removed" | "already_removed" | "kept" | "stop_failed";
/** 进程带 pid，目录带 path */
interface ResourceReport { kind: OwnedResource["kind"] | "dir"; pid?: number; path?: string; outcome: ResourceOutcome; detail?: string }

/**
 * done = 每个登记进程都确认已退出，socket 和登记临时目录也清了；根与日志始终保留；
 * refused = 证据不足，零动作；partial = 动过手但有没停掉 / 没清掉 / 没记上的，下次再调重试。
 */
interface CleanupReport { status: "done" | "refused" | "partial"; reason?: string; resources: ResourceReport[]; signals: number; archive?: string }

const refused = (reason: string): CleanupReport => ({ status: "refused", reason, resources: [], signals: 0 });

/** 订单、代次、worker 三样证据；返回拒绝理由，null = 可以往下走 */
async function evidenceProblem(record: SandboxOwnerRecord, deps: CleanupDeps): Promise<string | null> {
  let facts: OrderFacts | null;
  try { facts = await deps.orderFacts(record.key.orderId); } catch (e) { return `订单状态读不了：${(e as Error).message}`; }
  if (!facts) return "订单状态未知";
  if (!TERMINAL.includes(facts.state)) return `订单还在 ${facts.state}，不是终态`;
  if (facts.resultPending !== false) return "订单还有待交 / 待回执的结果";
  if (facts.generation !== record.key.generation) return `订单已换代（记录第 ${record.key.generation} 代，现在第 ${facts.generation} 代）`;
  let live: WorkerLiveness;
  try { live = await deps.workerLiveness(record.key.worker); } catch (e) { return `worker 活性读不了：${(e as Error).message}`; }
  return live === "no_window" ? null : `worker ${record.key.worker} 活性是 ${live}，不是确定不在`;
}

type Planned = { r: OwnedResource; verdict: "same" | "gone" };

/** 目录此刻还是不是登记的那个：不在 = gone；软链 / 换了目录 / 读不了 = 说不清 */
function dirVerdict(d: OwnedDir): "same" | "gone" | string {
  try {
    const now = dirIdentity(d.path);
    if (!now) return "gone";
    return now.path === d.path && now.dev === d.dev && now.ino === d.ino ? "same" : `目录 ${d.path} 已不是登记的那个`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 全部进程与目录的身份先读一遍：有一个说不清就整单拒绝 */
async function planResources(record: SandboxOwnerRecord, probe: (pid: number) => Promise<ProcessProbe>): Promise<Planned[] | string> {
  const out: Planned[] = [];
  for (const d of record.dirs) {
    const v = dirVerdict(d);
    if (v !== "same" && v !== "gone") return v;
  }
  for (const r of record.resources) {
    const v = identityVerdict(r, await probe(r.pid));
    if (v === "reused") return `${r.kind} pid ${r.pid} 已复用，整单拒绝`;
    if (v === "unknown") return `${r.kind} pid ${r.pid} 身份说不清`;
    if (r.kind === "tmux" && v === "same") {
      const bad = socketProblem(r.socket!, record.root);
      if (bad) return bad;
    }
    out.push({ r, verdict: v });
  }
  return out;
}

/** 发信号前重核身份；对不上就不发。返回 true = 发出去了 */
async function signalIfSame(r: OwnedResource, sig: NodeJS.Signals, deps: ActionDeps): Promise<boolean> {
  const verdict = identityVerdict(r, await deps.probe(r.pid));
  if (verdict === "gone") return false;
  if (verdict !== "same") throw new Error(`pid ${r.pid} 身份已变：${verdict}`);
  await deps.authorize();
  deps.signal(r.pid, sig);
  return true;
}

async function waitExit(r: OwnedResource, probe: (pid: number) => Promise<ProcessProbe>, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; ; await Bun.sleep(50)) {
    const v = identityVerdict(r, await probe(r.pid));
    if (v === "gone") return true;
    if (v === "reused" || v === "unknown") return false;
    if (Date.now() >= deadline) return false;
  }
}

/** 单个进程：TERM → 等 → KILL → 等；只有探测确认退出才算 stopped */
async function stopOne(r: OwnedResource, deps: ActionDeps): Promise<{ rep: ResourceReport; signals: number }> {
  let signals = 0;
  try {
    for (const [sig, wait] of [["SIGTERM", deps.graceMs], ["SIGKILL", deps.killWaitMs]] as const) {
      if (await signalIfSame(r, sig, deps)) signals++;
      if (await waitExit(r, deps.probe, wait)) return { rep: { kind: r.kind, pid: r.pid, outcome: "stopped" }, signals };
    }
    return { rep: { kind: r.kind, pid: r.pid, outcome: "stop_failed", detail: "SIGKILL 之后仍在" }, signals };
  } catch (e) {
    return { rep: { kind: r.kind, pid: r.pid, outcome: "stop_failed", detail: (e as Error).message }, signals };
  }
}

/** 有没有 server 还在这个 socket 上听：ECONNREFUSED = 没人（残留文件），连得上 = 有，其他错误 = 不知道 */
function socketListening(path: string): Promise<boolean | null> {
  return new Promise((done) => {
    const c = createConnection(path);
    const t = setTimeout(() => (c.destroy(), done(null)), 2_000);
    c.once("connect", () => (clearTimeout(t), c.destroy(), done(true)));
    c.once("error", (e: NodeJS.ErrnoException) => (clearTimeout(t), done(["ECONNREFUSED", "ENOENT"].includes(e.code ?? "") ? false : null)));
  });
}

/** tmux server 退出后留下的私有 socket：是根下的 socket 文件、且确定没人在听才删（同路径上可能已有别的 server） */
async function removeSocket(r: OwnedResource, root: string, authorize: () => Promise<void>): Promise<string | null> {
  if (!lstatSync(r.socket!, { throwIfNoEntry: false })) return null;
  const bad = socketProblem(r.socket!, root);
  if (bad) return `socket 没删：${bad}`;
  const listening = await socketListening(r.socket!);
  if (listening !== false) return `socket 没删：${listening ? "还有 server 在听" : "探不清有没有 server 在听"}`;
  await authorize();
  try { unlinkSync(r.socket!); return null; } catch (e) { return `socket 没删：${(e as Error).message}`; }
}

type ActionDeps = Required<Pick<CleanupDeps, "probe" | "signal" | "graceMs" | "killWaitMs">> & { authorize(): Promise<void> };

/** 只检查明确登记的路径；任何打开文件/cwd 都保守视为占用，工具失败不能当空。 */
async function directoryProblem(d: OwnedDir, allowed: number[] = []): Promise<string | null> {
  try {
    const verdict = dirVerdict(d);
    if (verdict === "gone") return null;
    if (verdict !== "same") return verdict;
    const p = Bun.spawn(["lsof", "-nP", "+D", d.path, "-F", "p"], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    const pids = out.split("\n").filter((line) => /^p[0-9]+$/.test(line)).map((line) => Number(line.slice(1)));
    if (pids.some((pid) => !allowed.includes(pid))) return `目录 ${d.path} 仍有活进程占用`;
    return (code === 0 || code === 1) && !err.trim() ? null : `目录 ${d.path} 占用读不清：${err.trim() || code}`;
  } catch (e) { return `目录 ${d.path} 占用读不清：${(e as Error).message}`; }
}

async function stopAll(record: SandboxOwnerRecord, plan: Planned[], deps: ActionDeps) {
  const resources: ResourceReport[] = [];
  let signals = 0;
  for (const kind of STOP_ORDER) {
    for (const { r, verdict } of plan.filter((p) => p.r.kind === kind)) {
      let rep: ResourceReport = { kind, pid: r.pid, outcome: "already_exited" };
      if (verdict === "same") {
        const s = await stopOne(r, deps);
        rep = s.rep;
        signals += s.signals;
      }
      if (kind === "tmux" && rep.outcome !== "stop_failed") {
        try {
          await deps.authorize();
          const left = await removeSocket(r, record.root, deps.authorize);
          if (left) rep = { ...rep, outcome: "stop_failed", detail: left };
        } catch (e) { rep = { ...rep, outcome: "stop_failed", detail: (e as Error).message }; }
      }
      resources.push(rep);
    }
  }
  const stopped = resources.every((r) => r.outcome !== "stop_failed");
  for (const d of record.dirs) {
    if (pathsOverlap(d.path, record.root)) { resources.push({ kind: "dir", path: d.path, outcome: "retained" }); continue; }
    const bad = stopped ? await directoryProblem(d) : "有进程没停掉，目录先留着";
    try { await deps.authorize(); } catch (e) {
      resources.push({ kind: "dir", path: d.path, outcome: "kept", detail: (e as Error).message }); continue;
    }
    resources.push(bad ? { kind: "dir", path: d.path, outcome: "kept", detail: bad } : removeDir(d));
  }
  return { resources, signals };
}

/** 删之前再核一次身份；rmSync 不跟随目录里的软链 */
function removeDir(d: OwnedDir): ResourceReport {
  const v = dirVerdict(d);
  if (v === "gone") return { kind: "dir", path: d.path, outcome: "already_removed" };
  if (v !== "same") return { kind: "dir", path: d.path, outcome: "stop_failed", detail: v };
  try {
    rmSync(d.path, { recursive: true });
    return { kind: "dir", path: d.path, outcome: "removed" };
  } catch (e) {
    return { kind: "dir", path: d.path, outcome: "stop_failed", detail: `删除失败：${(e as Error).message}` };
  }
}

/** 已完成记录只回放历史退出证据；不再把 PID/目录重新认领，仍核保留目录的真实身份。 */
function completedReport(record: SandboxOwnerRecord): CleanupReport {
  const resources: ResourceReport[] = record.resources.map((r) => ({ kind: r.kind, pid: r.pid, outcome: "already_exited" }));
  for (const d of record.dirs) {
    const v = dirVerdict(d);
    if (v !== "gone" && (v !== "same" || !pathsOverlap(d.path, record.root))) return refused(`完成记录目录不再可信：${d.path}`);
    resources.push({ kind: "dir", path: d.path, outcome: v === "gone" ? "already_removed" : "retained" });
  }
  return { status: "done", resources, signals: 0 };
}

/** consumer 持生命周期/per-key 锁；共享锁只冻结资源及写回，不跨 TERM/KILL 等待。 */
async function cleanupSandboxOrder(dir: string, key: SandboxOwnerKey, deps: CleanupDeps): Promise<CleanupReport> {
  if (!deps.withOrderCleanupLease) return refused("缺少订单生命周期清理租约");
  let completed: CleanupReport | undefined;
  try { return await deps.withOrderCleanupLease(key, async (held) => (completed = await cleanupLeased(dir, key, deps, held))); }
  catch (e) {
    const reason = `清理租约失败：${(e as Error).message}`;
    return completed ? { ...completed, status: completed.status === "refused" ? "refused" : "partial", reason } : refused(reason);
  }
}

async function cleanupLeased(dir: string, key: SandboxOwnerKey, deps: CleanupDeps, held: () => boolean): Promise<CleanupReport> {
  let lock;
  try { lock = await lockSandboxCleanupKey(dir, key); } catch (e) { return refused((e as Error).message); }
  let report: CleanupReport;
  try { report = await cleanupFrozen(dir, key, deps, held, lock); } catch (e) { report = refused((e as Error).message); }
  try { lock.release(); } catch (e) {
    report = { ...report, status: report.status === "refused" ? "refused" : "partial", reason: `记录锁释放失败：${(e as Error).message}` };
  }
  return report;
}

async function cleanupFrozen(dir: string, key: SandboxOwnerKey, deps: CleanupDeps, held: () => boolean, lock: LockHandle): Promise<CleanupReport> {
  const d = { probe: probeProcess, signal: (pid: number, sig: NodeJS.Signals) => void process.kill(pid, sig), graceMs: 5_000, killWaitMs: 3_000, ...deps };
  const now = (deps.now ?? Date.now)();
  const read = readSandboxOwner(dir, key);
  if (read.status !== "ok") return refused(read.reason);
  if (read.record.cleanup?.done) return completedReport(read.record);
  const evidence = await evidenceProblem(read.record, d);
  if (evidence) return refused(evidence);
  let record: SandboxOwnerRecord;
  try { record = await beginSandboxCleanup(dir, key, now, lock); } catch (e) { return refused((e as Error).message); }
  const authorize = async () => {
    for (const r of record.resources) {
      const v = identityVerdict(r, await d.probe(r.pid));
      if (v === "reused" || v === "unknown") throw new Error(`pid ${r.pid} 身份已变：${v}`);
    }
    const bad = await evidenceProblem(record, d);
    if (bad) throw new Error(bad);
    if (!held() || !lock.held()) throw new Error("清理租约已失");
  };
  const plan = await planResources(record, d.probe);
  if (typeof plan === "string") return refused(plan);
  for (const dir of record.dirs) {
    if (pathsOverlap(dir.path, record.root)) continue;
    const bad = await directoryProblem(dir, record.resources.map((r) => r.pid));
    if (bad) return refused(bad);
  }
  let archive: string;
  try {
    archive = await archiveOwnerEvidence(dir, record, plan.map((p) => ({ kind: p.r.kind, pid: p.r.pid, verdict: p.verdict })), now);
  } catch (e) {
    return refused(`属主证据保全失败：${(e as Error).message}`);
  }
  try { await authorize(); } catch (e) { return refused((e as Error).message); }
  const { resources, signals } = await stopAll(record, plan, { ...d, authorize });
  const done = resources.every((r) => r.outcome !== "stop_failed" && r.outcome !== "kept");
  const mark = { attempts: record.cleanup!.attempts, lastAt: now, done, outcomes: resources.map((r) => `${r.kind}:${r.pid ?? r.path}:${r.outcome}`) };
  try {
    const ownerLock = await lockSandboxOwner(dir, key);
    try {
      if (!held() || !lock.held()) throw new Error("清理租约已失，不写回");
      await markSandboxCleanup(dir, record, mark, ownerLock);
    } finally { ownerLock.release(); }
  } catch (e) {
    return { status: "partial", reason: `清理结果没记上：${(e as Error).message}`, resources, signals, archive };
  }
  return done ? { status: "done", resources, signals, archive } : { status: "partial", reason: "有进程 / socket 没清掉，稍后重试", resources, signals, archive };

}

interface OwnerReview {
  /** 属主目录本身读不了：status unknown，别当成「没有遗留」 */
  status: "ok" | "unknown";
  reason?: string;
  /** TTL 到了、还没清完的记录：只是该复核，仍要走 cleanup 的全部证据 */
  due: SandboxOwnerKey[];
  /** 损坏 / 软链 / 对不上的记录：只列举，不迁移、不清理 */
  unknown: Array<{ id: string; reason: string }>;
}

function reviewSandboxOwners(dir: string, now: number, ttlMs: number): OwnerReview {
  const all = listSandboxOwners(dir);
  if (all.status !== "ok") return { status: "unknown", reason: all.reason, due: [], unknown: [] };
  const ok = (e: OwnerListing): e is OwnerListing & { read: { status: "ok"; record: SandboxOwnerRecord } } => e.read.status === "ok";
  const entries = all.entries.map((e) => e.read.status === "ok" ? { ...e, read: readSandboxOwner(dir, e.read.record.key) } : e);
  return {
    status: "ok",
    due: entries.filter(ok).filter((e) => ownerReviewDue(e.read.record, now, ttlMs)).map((e) => e.read.record.key),
    unknown: entries.flatMap((e) => (e.read.status === "ok" ? [] : [{ id: e.id, reason: e.read.reason }])),
  };
}

/**
 * SBXC2 唯一接线入口：register 在 producer 启动后、报 started 前调用；失败则 producer 停自己的新资源。
 * addChild/addDir 补登记，开始清理后拒绝；未知历史只由 review 上报，TTL 不授权删除。
 * cleanup 在终态/结果回执后调用，必须注入与换代、恢复、资源创建共用的 withOrderCleanupLease。
 * 锁顺序是生命周期锁→per-key 锁→短共享事务；先冻结补登记，再释放共享锁停进程，最后短事务写回。
 * root 及重叠目录保留日志并报告 retained；本模块尚未接生产启动或结单路径。
 */
export interface SandboxOrderOwnership {
  register(input: RegisterInput): Promise<SandboxOwnerRecord>;
  addChild(key: SandboxOwnerKey, pid: number): Promise<SandboxOwnerRecord>;
  addDir(key: SandboxOwnerKey, path: string): Promise<SandboxOwnerRecord>;
  cleanup(key: SandboxOwnerKey): Promise<CleanupReport>;
  review(now: number, ttlMs: number): OwnerReview;
}

export function sandboxOrderOwnership(deps: CleanupDeps & { dir?: string }): SandboxOrderOwnership {
  const dir = deps.dir ?? statePath("sandbox-owners");
  return {
    register: (input) => registerSandboxOwner(dir, input, (deps.now ?? Date.now)()),
    addChild: (key, pid) => addSandboxOwned(dir, key, { pid }),
    addDir: (key, path) => addSandboxOwned(dir, key, { dir: path }),
    cleanup: (key) => cleanupSandboxOrder(dir, key, deps),
    review: (now, ttlMs) => reviewSandboxOwners(dir, now, ttlMs),
  };
}
