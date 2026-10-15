/**
 * 订单沙箱的资源回收：证据、冻结、保全、记账在这里；发信号、删 socket / 目录只在 LIFE1 执行器（agent-lifecycle-run.ts runSandboxRetire）。
 * 动手前要齐四样正面证据：记录可读、订单在终态且没有待交结果、代次没变、worker 确定不在（worker-liveness 四态里的 no_window；
 * running / unknown 不动，no_host 窗口还在、归 lend 循环收）。再核没有别的记录声称同一资源、全部进程身份读得清，最后先保全证据。
 * 任何一步不满足都是零信号零删除，执行器不会被调到。属主记录与证据在属主目录，永不删。tests/sandbox-order-cleanup.test.ts
 */
import { runSandboxRetire, sandboxDirProblem, type SandboxPlanned, type SandboxResourceReport } from "./agent-lifecycle-run.js";
import type { LockHandle } from "./file-lock.js";
import type { LendState } from "./lend-journal.js";
import { statePath } from "./paths.js";
import { pathsOverlap } from "./sandbox.js";
import {
  addSandboxOwned, archiveOwnerEvidence, beginSandboxCleanup, dirRetainReason, dirVerdict, forDelete, identityVerdict, listSandboxOwners,
  lockSandboxCleanupKey, lockSandboxOwner, markSandboxCleanup, ownerReviewDue,
  probeProcess, readSandboxOwner, registerSandboxOwner, socketProblem,
  type OwnedDir, type OwnerListing, type ProcessProbe, type RegisterInput, type SandboxOwnerKey, type SandboxOwnerRecord,
} from "./sandbox-order-owner.js";
import type { WorkerLiveness } from "./worker-liveness.js";

/** 订单终态：不会再跑、也不会再交结果（result_pending 等回执，不算） */
const TERMINAL: readonly LendState[] = ["acked", "stopped", "cancelled", "released", "declined"];

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

/**
 * done = 每个登记进程都确认已退出，socket 和登记临时目录也清了；根与日志始终保留；根外目录被同路径重建 / 缺出生时间认不出的保留，reason 报一次（记 done，之后不再报）；
 * refused = 证据不足，零动作；partial = 动过手但有没停掉 / 没清掉 / 没记上的，下次再调重试。
 */
interface CleanupReport { status: "done" | "refused" | "partial"; reason?: string; resources: SandboxResourceReport[]; signals: number; archive?: string }

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

/** 全部进程与目录的身份先读一遍：有一个说不清就整单拒绝（保留的根外目录不在此列） */
async function planResources(record: SandboxOwnerRecord, probe: (pid: number) => Promise<ProcessProbe>, retained: Map<OwnedDir, string>): Promise<SandboxPlanned[] | string> {
  const out: SandboxPlanned[] = [];
  for (const d of record.dirs) {
    if (retained.has(d)) continue;
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


/** 根外登记目录里被同路径重建（birth 不等）或认不出（缺出生时间）的：不交执行器删，保留，记 done 时报一次 */
function retainedDirs(record: SandboxOwnerRecord): Map<OwnedDir, string> {
  const held = new Map<OwnedDir, string>();
  for (const d of record.dirs) {
    if (pathsOverlap(d.path, record.root)) continue;
    const why = dirRetainReason(d);
    if (why) held.set(d, why);
  }
  return held;
}

/** 已完成记录只回放历史退出证据；不再把 PID/目录重新认领，仍核保留目录的真实身份（被替换 / 缺出生时间而保留的根外目录照旧保留、不再报）。 */
function completedReport(record: SandboxOwnerRecord): CleanupReport {
  const resources: SandboxResourceReport[] = record.resources.map((r) => ({ kind: r.kind, pid: r.pid, outcome: "already_exited" }));
  const held = retainedDirs(record);
  for (const d of record.dirs) {
    const v = dirVerdict(d);
    if (v !== "gone" && !held.has(d) && (v !== "same" || !pathsOverlap(d.path, record.root))) return refused(`完成记录目录不再可信：${d.path}`);
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
  const retained = retainedDirs(record);
  const plan = await planResources(record, d.probe, retained);
  if (typeof plan === "string") return refused(plan);
  for (const dir of record.dirs) {
    if (pathsOverlap(dir.path, record.root) || retained.has(dir)) continue;
    const bad = await sandboxDirProblem(dir, record.resources.map((r) => r.pid));
    if (bad) return refused(bad);
  }
  let archive: string;
  try {
    archive = await archiveOwnerEvidence(dir, record, plan.map((p) => ({ kind: p.r.kind, pid: p.r.pid, verdict: p.verdict })), now);
  } catch (e) {
    return refused(`属主证据保全失败：${(e as Error).message}`);
  }
  try { await authorize(); } catch (e) { return refused((e as Error).message); }
  // 交执行器的根外目录用 forDelete 副本：执行器 rmSync 前那次同步复核也按 delete 判，此后缺出生时间 / 被替换就 kept 不删
  const toRetire = record.dirs.filter((x) => !retained.has(x)).map((x) => pathsOverlap(x.path, record.root) ? x : forDelete(x));
  const retired = await runSandboxRetire({ ...record, dirs: toRetire }, plan, { ...d, authorize });
  const resources = [...retired.resources, ...[...retained].map(([x, detail]): SandboxResourceReport => ({ kind: "dir", path: x.path, outcome: "retained", detail }))];
  const signals = retired.signals;
  const note = retained.size ? [...retained.values()].join("；") : undefined; // 只在记 done 这一次报；之后 completedReport 不再报
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
  return done ? { status: "done", ...(note && { reason: note }), resources, signals, archive } : { status: "partial", reason: "有进程 / socket 没清掉，稍后重试", resources, signals, archive };

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
 * root 及重叠目录保留日志并报告 retained；结单路径经 lend-drive.ts withSandboxRetire 调 cleanup，停进程 / 删除由 LIFE1 执行器做。
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
