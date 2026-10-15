/**
 * Carries out a lifecycle plan (agent-lifecycle.ts) in "on" mode; observe and off never reach here, so they have no side effects.
 * retire = check the agent still runs the session the plan was made for → archive → `manager remove` (the same path PM uses) → the
 * agent's own checkout (`git worktree remove`, no --force; its node_modules and build output go with it) → its Claude Code temp
 * folder. The agent's paths are measured before and after and the difference goes into the ledger event.
 * Disk safety: a temp folder goes only after its checkout is gone (a checkout kept because it is dirty, held or not a worktree keeps
 * its session's tool output too); a checkout that is a symlink is never touched; whatever is left is recorded as a pending cleanup
 * (agent-lifecycle-store.ts) and retried every pass, and the retire is reported as not finished.
 * Repeating a step is harmless: archive of a gone agent, remove of a removed one and a worktree already gone all count as done.
 * Nothing is stopped when the archive failed (the chat record must be kept first).
 * archive-only (rule lend_terminal, runLendTerminal): the same collect with no checkout / temp entries; an archive that did not land
 * always refuses (no "nothing to copy" pass), an archive already kept is not repeated, and the remove is whatever the caller's manager
 * maps it to (the lend leaf: runRemove's archive-only branch). runLifecycle refuses such an action.
 * With planAt set (production), archive names the planned session and remove carries the plan's identity and protections
 * (LifecycleRemoveGuard): manager re-checks them on the final objects (src/manager/agent-remove-guard.ts) instead of removing by name.
 */
import { lstatSync, rmSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { join, sep } from "node:path";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CleanupEntry, RetireRecord } from "./agent-lifecycle-store.js";
import type { Action, Plan } from "./agent-lifecycle.js";
import { archiveReceipt, killOutcome, stopped, type LiveAgent, type RetireDeps, within, worktreeDirs } from "./scheduler-retire.js";
import { claudeTmpDirFor, tmpDirVerdict, type TmpCleaner } from "./scheduler-retire-tmp.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { dueRetries, gatedCollect, retireWorktree, type CleanupOpts } from "./agent-lifecycle-cleanup.js";
import { pathsOverlap } from "./sandbox.js";
import { dirVerdict, identityVerdict, socketProblem, type OwnedDir, type OwnedResource, type ProcessProbe, type SandboxOwnerRecord } from "./sandbox-order-owner.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";

export interface LifecycleDeps extends Pick<RetireDeps, "git" | "exists">, CleanupOpts {
  /** plain manager CLI: archive / remove */
  manager(...args: string[]): Promise<Record<string, unknown>>;
  worktreeRoot: string;
  tmp?: TmpCleaner;
  agents(): Promise<LiveAgent[]>;
  /** total bytes under the paths that exist; null = could not measure */
  du(paths: string[]): Promise<number | null>;
  swapPct(): Promise<number | null>;
  /** the ledger write (production: `ledger scheduler-worker-retire`); throws when it did not land */
  record(r: RetireRecord): Promise<void>;
  now(): number;
  /** the existing PM notice channel, for the one notice of a cleanup only a person can resolve (agent-lifecycle-backoff.ts) */
  notifyPm?(a: Action, text: string, level: PmNoticeLevel): Promise<void>;
  /** when the plan's facts were read (lifecycleSnapshot's now); unset only in test seams that drive a fake manager by name */
  planAt?: number;
}

/** What a lifecycle remove carries; activeAt = the plan's last activity of that session (null = unknown then). */
export interface LifecycleRemoveGuard {
  sessionId: string | null; taskId: string | null; role: Action["role"]; rule: Action["rule"]; activeAt: number | null; policy: LifecyclePolicy;
}
export const LIFECYCLE_GUARD_FLAG = "--lifecycle-guard";

/**
 * The same flag for an agent no card links (a cron temp agent is never in a lifecycle plan): the remove re-checks only that the name
 * still runs this session, inside the same protected region, and skips the plan re-check. A guard without sessionOnly is unchanged.
 */
export interface SessionRemoveGuard { sessionOnly: true; sessionId: string }
export const sessionGuardArgs = (sessionId: string): string[] => [LIFECYCLE_GUARD_FLAG, JSON.stringify({ sessionOnly: true, sessionId } satisfies SessionRemoveGuard)];

/** The plan's identity for manager archive / remove; none without planAt or for archive-only (its own exact branch). */
function guardArgs(a: Action, deps: LifecycleDeps, policy: LifecyclePolicy | undefined): { archive: string[]; remove: string[] } {
  if (deps.planAt === undefined || !policy || a.archiveOnly) return { archive: [], remove: [] };
  const g: LifecycleRemoveGuard = { sessionId: a.sessionId ?? null, taskId: a.taskId, role: a.role, rule: a.rule,
    activeAt: a.idleMs === null ? null : deps.planAt - a.idleMs, policy };
  return { archive: a.sessionId ? ["--session", a.sessionId] : [], remove: [LIFECYCLE_GUARD_FLAG, JSON.stringify(g)] };
}

export interface RunResult { done: { agent: string; rule: string; freed: number | null }[]; failed: { agent: string; error: string }[] }

/** Checkouts this agent owns: the card's per-role worktree, and its cwd when that is a checkout under the worktree root. */
function ownedCheckouts(a: Action, root: string): string[] {
  const dirs = new Set<string>();
  if (a.taskId && (a.role === "author" || a.role === "reviewer")) {
    const [mine, rv] = worktreeDirs(root, a.taskId);
    if (mine && rv) dirs.add(a.role === "author" ? mine : rv);
  }
  if (a.cwd && a.cwd.startsWith(root + sep)) dirs.add(join(root, a.cwd.slice(root.length + 1).split(sep)[0]));
  return [...dirs];
}

/** Each owned checkout with the temp folder its session used (keyed by the session's cwd; only an own checkout's is ours). */
function cleanupEntries(a: Action, deps: LifecycleDeps): CleanupEntry[] {
  const root = deps.tmp?.root;
  return ownedCheckouts(a, deps.worktreeRoot).map((dir) => ({ checkout: dir,
    tmp: !root ? null : a.cwd ? (within(a.cwd, dir) ? claudeTmpDirFor(a.cwd, root) : null) : claudeTmpDirFor(dir, root) }));
}

const isSymlink = (p: string): boolean => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; /* not there: removeCleanWorktree counts it as done */ }
};

/**
 * Cleans what it may; returns what is left (a kept checkout keeps its temp folder with it). Every current agent counts as a holder
 * except `self`, the session this retire just stopped (name and session both); a retry has no self, so a same-name agent running
 * another session in the checkout keeps it. Held = not `stopped` (scheduler-retire.ts: status, pending and window together), also for
 * a temp folder whose checkout is already gone (a tmp-only retry), so the evidence of any current holder stays.
 */
async function cleanDisk(entries: CleanupEntry[], deps: LifecycleDeps, self: { name: string; sessionId: string } | null, steps: string[], a: Action): Promise<CleanupEntry[]> {
  const others = async () => (await deps.agents()).filter((x) => !self || x.name !== self.name || x.sessionId !== self.sessionId), agents = await others();
  const live = agents.filter((x) => !stopped(x) && x.cwd).map((x) => ({ name: x.name, cwd: x.cwd! }));
  const left: CleanupEntry[] = [];
  for (const e of entries) {
    const why = isSymlink(e.checkout) ? "是符号链接，不跟" : await retireWorktree(deps, e.checkout, a, agents, others, steps);
    if (why) {
      steps.push(`worktree 没删 ${e.checkout}：${why}${e.tmp ? "；它的临时目录一并留着" : ""}`);
      left.push(e);
      continue;
    }
    steps.push(`worktree 已清 ${e.checkout}`);
    if (!e.tmp || !deps.tmp?.root) continue;
    const holder = live.find((x) => within(x.cwd, e.checkout));
    let v: ReturnType<typeof tmpDirVerdict>;
    try { v = holder ? { refuse: `${holder.name} 还在 ${e.checkout} 工作（agent 没停）` } : tmpDirVerdict(e.tmp, deps.tmp.root, live); } catch (err) { v = { refuse: `检查出错：${(err as Error).message}` }; }
    if ("gone" in v) continue;
    if ("refuse" in v) { steps.push(`临时目录没删：${v.refuse}`); left.push({ checkout: e.checkout, tmp: e.tmp }); continue; }
    const err = await deps.tmp.rm(v.rm).then(() => null, (x: unknown) => {
      if (x instanceof SchedulerStopped) throw x;
      return (x as NodeJS.ErrnoException).code === "ENOENT" ? null : (x as Error).message;
    });
    if (err) { steps.push(`临时目录 ${v.rm} 删除失败：${err}`); left.push({ checkout: e.checkout, tmp: e.tmp }); }
    else steps.push(`临时目录已清 ${v.rm}`);
  }
  return left;
}

const measured = (entries: CleanupEntry[]): string[] => entries.flatMap((e) => (e.tmp ? [e.checkout, e.tmp] : [e.checkout]));

type Outcome = { freed: number | null; left: number } | { error: string };

/** One agent end to end; throws only for an unexpected error, a refused stop returns its reason. */
async function collect(a: Action, deps: LifecycleDeps, policy?: LifecyclePolicy): Promise<Outcome> {
  const retry = a.rule === "cleanup_retry";
  const entries = retry ? a.entries ?? [] : a.archiveOnly ? [] : cleanupEntries(a, deps);
  const paths = measured(entries);
  const before = paths.length ? await deps.du(paths) : null;
  const steps: string[] = [];
  if (!retry) {
    // the plan is from a snapshot: the name may have been removed and re-created since, so check the session before touching it
    const now = (await deps.agents()).find((x) => x.name === a.agent);
    if (now && (!a.sessionId || now.sessionId !== a.sessionId)) {
      return { error: `${a.agent} 现在跑的会话（${now.sessionId ?? "?"}）不是计划里的 ${a.sessionId ?? "?"}，先不收` };
    }
    const guard = guardArgs(a, deps, policy);
    const archived = a.archiveOnly?.historyKept ? { ok: true, note: "会话归档已在，不二次归档" } : await deps.manager("archive", a.agent, ...guard.archive);
    // gone from the registry, or no session file left to copy: nothing to keep; any other archive failure keeps the agent
    if (archived.ok !== true && (a.archiveOnly || !/不在 registry|不存在/.test(String(archived.error ?? archived.note ?? "")))) {
      return { error: `${a.agent} 归档没成，先不收（聊天记录要先保全）：${String(archived.error ?? archived.note ?? "?")}` };
    }
    steps.push(archiveReceipt(archived));
    const removed = await deps.manager("remove", a.agent, ...guard.remove);
    if (removed.refused === true) return { error: String(removed.error ?? `${a.agent} 收回被拒`) }; // never read as "already gone"
    const stop = killOutcome(removed);
    if (!("receipt" in stop)) return { error: "busy" in stop ? `${a.agent} 正忙，下轮再收：${stop.busy}` : stop.failed };
    steps.push(stop.receipt);
  }
  const self = !retry && a.sessionId ? { name: a.agent, sessionId: a.sessionId } : null;
  const left = entries.length ? await cleanDisk(entries, deps, self, steps, a) : [];
  const after = paths.length ? await deps.du(paths) : null;
  await deps.record({ agent: a.agent, sessionId: a.sessionId ?? null, taskId: a.taskId, role: a.role, rule: a.rule, reason: a.reason, idleMs: a.idleMs,
    bytesBefore: before, bytesAfter: after, steps, now: deps.now(), pending: left, retry, ...(retry ? { regAt: a.regAt ?? null } : {}) });
  return { freed: before !== null && after !== null ? Math.max(0, before - after) : null, left: left.length };
}

/** What an archive-only retire touches: the canonical archive and remove (manager), the session check (agents) and its record. */
export type LendTerminalDeps = Pick<LifecycleDeps, "manager" | "agents" | "record" | "now">;

/** The one entry for a lend_terminal action: collect with nothing on disk to measure or clean. */
export async function runLendTerminal(a: Action, deps: LendTerminalDeps): Promise<{ ok: true } | { error: string }> {
  if (a.rule !== "lend_terminal" || !a.archiveOnly || !a.sessionId) return { error: `${a.agent} 不是精确的 archive-only 退休` };
  const noDisk = async (): Promise<never> => { throw new Error("archive-only 退休不碰磁盘"); };
  const r = await collect(a, { ...deps, worktreeRoot: "", exists: () => false, git: noDisk, du: noDisk, swapPct: async () => null });
  return "error" in r ? r : { ok: true };
}

export async function runLifecycle(plan: Plan, policy: LifecyclePolicy, deps: LifecycleDeps): Promise<RunResult> {
  const out: RunResult = { done: [], failed: [] };
  if (policy.mode !== "on") return out;
  const one = async (a: Action) => {
    if (a.archiveOnly) { out.failed.push({ agent: a.agent, error: "archive-only 退休只经 runLendTerminal" }); return; }
    try {
      const r = await gatedCollect(a, deps, (x, d) => collect(x, d, policy));
      if ("error" in r) out.failed.push({ agent: a.agent, error: r.error });
      else if (r.left) { if (!r.quiet) out.failed.push({ agent: a.agent, error: r.notice ?? `${a.agent} 已停，但还有 ${r.left} 处落地物没清（已记待补清，下轮再试；原因见台账事件）` }); }
      else out.done.push({ agent: a.agent, rule: a.rule, freed: r.freed });
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ agent: a.agent, error: (e as Error).message });
    }
  };
  let budget = policy.perPass;
  for (const a of plan.actions) {
    if (budget-- <= 0) return out;
    await one(a);
  }
  for (const a of plan.memory) {
    if (budget <= 0) break;
    const swap = await deps.swapPct(); // re-read after each: stop as soon as swap is back under the threshold
    if (swap === null || swap <= policy.swapPct) break;
    budget--;
    await one(a);
  }
  for (const a of await dueRetries(plan.cleanups, deps)) {
    if (budget-- <= 0) break;
    await one(a);
  }
  return out;
}

// ── order sandbox resources (SBXC1 records, SBXC2 port) ──

/** bridge 先停（不再拉起新进程），再停登记的子进程，最后停 tmux server（连带 pane） */
const STOP_ORDER = ["bridge", "child", "tmux"] as const;

type SandboxResourceOutcome = "retained" | "stopped" | "already_exited" | "removed" | "already_removed" | "kept" | "stop_failed";
/** 进程带 pid，目录带 path */
export interface SandboxResourceReport { kind: OwnedResource["kind"] | "dir"; pid?: number; path?: string; outcome: SandboxResourceOutcome; detail?: string }
/** The caller's first reading of one registered process; reused / unknown never reach the entry (the caller refuses the whole order). */
export type SandboxPlanned = { r: OwnedResource; verdict: "same" | "gone" };
export interface SandboxRetireDeps {
  probe(pid: number): Promise<ProcessProbe>;
  signal(pid: number, sig: NodeJS.Signals): void;
  /** SIGTERM 之后等多久再 SIGKILL；SIGKILL 之后等多久认停不掉 */
  graceMs: number;
  killWaitMs: number;
  /** Re-checks order, generation, worker and lease; called before every signal and removal, throws to stop. */
  authorize(): Promise<void>;
}

/** 发信号前重核身份；对不上就不发。返回 true = 发出去了 */
async function signalIfSame(r: OwnedResource, sig: NodeJS.Signals, deps: SandboxRetireDeps): Promise<boolean> {
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
async function stopOne(r: OwnedResource, deps: SandboxRetireDeps): Promise<{ rep: SandboxResourceReport; signals: number }> {
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

/** 只检查明确登记的路径；任何打开文件/cwd 都保守视为占用，工具失败不能当空。 */
export async function sandboxDirProblem(d: OwnedDir, allowed: number[] = []): Promise<string | null> {
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

/**
 * The one entry that signals or removes an order sandbox's objects (rule: sandbox). It takes the owner record SBXC2 registered, frozen
 * by the caller's cleanup mark, and the caller's first identity reading; each process is read again right before every signal, and
 * only one that is the registered process both times is stopped. A plan that is not this record's own resources is refused whole;
 * anything that cannot be stopped or checked is reported and left. Root and overlapping dirs are kept. tests/sandbox-order-cleanup.test.ts
 */
export async function runSandboxRetire(record: SandboxOwnerRecord, plan: SandboxPlanned[], deps: SandboxRetireDeps): Promise<{ resources: SandboxResourceReport[]; signals: number }> {
  if (!record.cleanup || record.cleanup.done) throw new Error("属主记录没有冻结在清理中，不回收");
  if (plan.length !== record.resources.length || plan.some((p) => !record.resources.includes(p.r))) throw new Error("回收计划不是这份属主记录登记的资源");
  const resources: SandboxResourceReport[] = [];
  let signals = 0;
  for (const kind of STOP_ORDER) {
    for (const { r, verdict } of plan.filter((p) => p.r.kind === kind)) {
      let rep: SandboxResourceReport = { kind, pid: r.pid, outcome: "already_exited" };
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
    const bad = stopped ? await sandboxDirProblem(d) : "有进程没停掉，目录先留着";
    try { await deps.authorize(); } catch (e) {
      resources.push({ kind: "dir", path: d.path, outcome: "kept", detail: (e as Error).message }); continue;
    }
    resources.push(bad ? { kind: "dir", path: d.path, outcome: "kept", detail: bad } : removeOwnedDir(d));
  }
  return { resources, signals };
}

/** 删之前再核一次身份；rmSync 不跟随目录里的软链 */
function removeOwnedDir(d: OwnedDir): SandboxResourceReport {
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

// ── lend order checkouts ──

/**
 * The one entry that removes a lend order's checkouts (settle of an ended order, the stopped-retention sweep, reclaimEndedWork's
 * retire). The caller's assertCurrent re-reads its facts and throws to stop; it runs in the same synchronous step as the removal,
 * so an order claimed or a worker revived while the caller was waiting is kept. remove = the lend service's removeDir port.
 */
export function runLendWorkRetire(target: { orderId: string; assertCurrent(): void }, deps: { remove(orderId: string): void }): void {
  target.assertCurrent();
  deps.remove(target.orderId);
}
