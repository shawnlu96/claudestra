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
import type { LendState } from "./lend-journal.js";
import { statePath } from "./paths.js";
import {
  addSandboxOwned, archiveOwnerEvidence, dirIdentity, identityVerdict, listSandboxOwners, lockSandboxOwner, markSandboxCleanup, ownerReviewDue,
  ownershipConflict, probeProcess, readSandboxOwner, registerSandboxOwner, socketProblem,
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
  probe?: (pid: number) => Promise<ProcessProbe>;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** SIGTERM 之后等多久再 SIGKILL；SIGKILL 之后等多久认停不掉 */
  graceMs?: number;
  killWaitMs?: number;
  now?: () => number;
}

type ResourceOutcome = "stopped" | "already_exited" | "pid_reused" | "removed" | "already_removed" | "kept" | "stop_failed";
/** 进程带 pid，目录带 path */
interface ResourceReport { kind: OwnedResource["kind"] | "dir"; pid?: number; path?: string; outcome: ResourceOutcome; detail?: string }

/**
 * done = 每个登记进程都确认已退出（或 pid 已被复用、原进程必然已退），socket 和登记目录也清了；
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

type Planned = { r: OwnedResource; verdict: "same" | "gone" | "reused" };

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
async function signalIfSame(r: OwnedResource, sig: NodeJS.Signals, deps: Required<Pick<CleanupDeps, "probe" | "signal">>): Promise<boolean> {
  if (identityVerdict(r, await deps.probe(r.pid)) !== "same") return false;
  deps.signal(r.pid, sig);
  return true;
}

async function waitExit(r: OwnedResource, probe: (pid: number) => Promise<ProcessProbe>, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; ; await Bun.sleep(50)) {
    const v = identityVerdict(r, await probe(r.pid));
    if (v === "gone" || v === "reused") return true;
    if (Date.now() >= deadline) return false;
  }
}

/** 单个进程：TERM → 等 → KILL → 等；只有探测确认退出才算 stopped */
async function stopOne(r: OwnedResource, deps: Required<Pick<CleanupDeps, "probe" | "signal" | "graceMs" | "killWaitMs">>): Promise<{ rep: ResourceReport; signals: number }> {
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
async function removeSocket(r: OwnedResource, root: string): Promise<string | null> {
  if (!lstatSync(r.socket!, { throwIfNoEntry: false })) return null;
  const bad = socketProblem(r.socket!, root);
  if (bad) return `socket 没删：${bad}`;
  const listening = await socketListening(r.socket!);
  if (listening !== false) return `socket 没删：${listening ? "还有 server 在听" : "探不清有没有 server 在听"}`;
  try { unlinkSync(r.socket!); return null; } catch (e) { return `socket 没删：${(e as Error).message}`; }
}

async function stopAll(record: SandboxOwnerRecord, plan: Planned[], deps: Required<Pick<CleanupDeps, "probe" | "signal" | "graceMs" | "killWaitMs">>) {
  const resources: ResourceReport[] = [];
  let signals = 0;
  for (const kind of STOP_ORDER) {
    for (const { r, verdict } of plan.filter((p) => p.r.kind === kind)) {
      let rep: ResourceReport = { kind, pid: r.pid, outcome: verdict === "gone" ? "already_exited" : "pid_reused" };
      if (verdict === "same") {
        const s = await stopOne(r, deps);
        rep = s.rep;
        signals += s.signals;
      }
      if (kind === "tmux" && rep.outcome !== "stop_failed") {
        const left = await removeSocket(r, record.root);
        if (left) rep = { ...rep, outcome: "stop_failed", detail: left };
      }
      resources.push(rep);
    }
  }
  const stopped = resources.every((r) => r.outcome !== "stop_failed");
  for (const d of record.dirs) resources.push(stopped ? removeDir(d) : { kind: "dir", path: d.path, outcome: "kept", detail: "有进程没停掉，目录先留着" });
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

/** consumer 入口：见文件头。持记录锁跑完全程，与登记 / 补登记互斥 */
async function cleanupSandboxOrder(dir: string, key: SandboxOwnerKey, deps: CleanupDeps): Promise<CleanupReport> {
  const d = { probe: probeProcess, signal: (pid: number, sig: NodeJS.Signals) => void process.kill(pid, sig), graceMs: 5_000, killWaitMs: 3_000, ...deps };
  const now = (deps.now ?? Date.now)();
  let lock;
  try { lock = await lockSandboxOwner(dir, key); } catch (e) { return refused((e as Error).message); }
  try {
    const read = readSandboxOwner(dir, key);
    if (read.status !== "ok") return refused(read.reason);
    const record = read.record;
    const evidence = await evidenceProblem(record, d);
    if (evidence) return refused(evidence);
    const all = listSandboxOwners(dir);
    if (all.status !== "ok") return refused(all.reason);
    const conflict = ownershipConflict(record, all.entries);
    if (conflict) return refused(conflict);
    const plan = await planResources(record, d.probe);
    if (typeof plan === "string") return refused(plan);
    let archive: string;
    try {
      archive = await archiveOwnerEvidence(dir, record, plan.map((p) => ({ kind: p.r.kind, pid: p.r.pid, verdict: p.verdict })), now);
    } catch (e) {
      return refused(`属主证据保全失败：${(e as Error).message}`);
    }
    const { resources, signals } = await stopAll(record, plan, d);
    const done = resources.every((r) => r.outcome !== "stop_failed" && r.outcome !== "kept");
    const mark = { attempts: (record.cleanup?.attempts ?? 0) + 1, lastAt: now, done, outcomes: resources.map((r) => `${r.kind}:${r.pid ?? r.path}:${r.outcome}`) };
    try {
      await markSandboxCleanup(dir, record, mark, lock);
    } catch (e) {
      return { status: "partial", reason: `清理结果没记上：${(e as Error).message}`, resources, signals, archive };
    }
    return done ? { status: "done", resources, signals, archive } : { status: "partial", reason: "有进程 / socket 没清掉，稍后重试", resources, signals, archive };
  } finally {
    lock.release();
  }
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
  return {
    status: "ok",
    due: all.entries.filter(ok).filter((e) => ownerReviewDue(e.read.record, now, ttlMs)).map((e) => e.read.record.key),
    unknown: all.entries.flatMap((e) => (e.read.status === "ok" ? [] : [{ id: e.id, reason: e.read.reason }])),
  };
}

/**
 * 后续接线（SBXC2）唯一入口。本卡不接任何生产路径。
 * - register：producer 在沙箱 bridge / 私有 tmux / 子进程都起来之后、对外报 started 之前调；抛错 = 没登记，producer 应自己停掉刚起的进程并报启动失败。
 * - addChild / addDir：后起、需要回收的子进程 / 自有临时目录（place / validation / disk-measure 之类）补登记；清理开始后拒绝。
 *   目录前缀只能拿来诊断，不能当归属证据，所以只有创建端在这里显式登记的目录才会被删。
 * - cleanup：订单进终态、结果已回执之后调（lend 循环结单处）；resolve 时报告里每个进程都已确认退出，或写明哪个没停掉（partial，下轮再调）；
 *   refused 什么都没动，原因如实上报，不重试成「成功」。
 * - review：周期复核用；due 只代表该再调一次 cleanup，unknown 原样报给人，不自动认领。
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
