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
 */
import { lstatSync } from "node:fs";
import { join, sep } from "node:path";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { CleanupEntry, RetireRecord } from "./agent-lifecycle-store.js";
import type { Action, Plan } from "./agent-lifecycle.js";
import { archiveReceipt, killOutcome, removeCleanWorktree, type LiveAgent, type RetireDeps, within, worktreeDirs } from "./scheduler-retire.js";
import { claudeTmpDirFor, tmpDirVerdict, type TmpCleaner } from "./scheduler-retire-tmp.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export interface LifecycleDeps extends Pick<RetireDeps, "git" | "exists"> {
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
 * another session in the checkout keeps it.
 */
async function cleanDisk(entries: CleanupEntry[], deps: LifecycleDeps, self: { name: string; sessionId: string } | null, steps: string[]): Promise<CleanupEntry[]> {
  const agents = (await deps.agents()).filter((x) => !self || x.name !== self.name || x.sessionId !== self.sessionId);
  const left: CleanupEntry[] = [];
  for (const e of entries) {
    const why = isSymlink(e.checkout) ? "是符号链接，不跟" : await removeCleanWorktree(deps, e.checkout, agents);
    if (why) {
      steps.push(`worktree 没删 ${e.checkout}：${why}${e.tmp ? "；它的临时目录一并留着" : ""}`);
      left.push(e);
      continue;
    }
    steps.push(`worktree 已清 ${e.checkout}`);
    if (!e.tmp || !deps.tmp?.root) continue;
    const live = agents.filter((x) => x.status !== "stopped" && x.cwd).map((x) => ({ name: x.name, cwd: x.cwd! }));
    let v: ReturnType<typeof tmpDirVerdict>;
    try { v = tmpDirVerdict(e.tmp, deps.tmp.root, live); } catch (err) { v = { refuse: `检查出错：${(err as Error).message}` }; }
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
async function collect(a: Action, deps: LifecycleDeps): Promise<Outcome> {
  const retry = a.rule === "cleanup_retry";
  const entries = retry ? a.entries ?? [] : cleanupEntries(a, deps);
  const paths = measured(entries);
  const before = paths.length ? await deps.du(paths) : null;
  const steps: string[] = [];
  if (!retry) {
    // the plan is from a snapshot: the name may have been removed and re-created since, so check the session before touching it
    const now = (await deps.agents()).find((x) => x.name === a.agent);
    if (now && (!a.sessionId || now.sessionId !== a.sessionId)) {
      return { error: `${a.agent} 现在跑的会话（${now.sessionId ?? "?"}）不是计划里的 ${a.sessionId ?? "?"}，先不收` };
    }
    const archived = await deps.manager("archive", a.agent);
    // gone from the registry, or no session file left to copy: nothing to keep; any other archive failure keeps the agent
    if (archived.ok !== true && !/不在 registry|不存在/.test(String(archived.error ?? archived.note ?? ""))) {
      return { error: `${a.agent} 归档没成，先不收（聊天记录要先保全）：${String(archived.error ?? archived.note ?? "?")}` };
    }
    steps.push(archiveReceipt(archived));
    const stop = killOutcome(await deps.manager("remove", a.agent));
    if (!("receipt" in stop)) return { error: "busy" in stop ? `${a.agent} 正忙，下轮再收：${stop.busy}` : stop.failed };
    steps.push(stop.receipt);
  }
  const self = !retry && a.sessionId ? { name: a.agent, sessionId: a.sessionId } : null;
  const left = entries.length ? await cleanDisk(entries, deps, self, steps) : [];
  const after = paths.length ? await deps.du(paths) : null;
  await deps.record({ agent: a.agent, sessionId: a.sessionId ?? null, taskId: a.taskId, role: a.role, rule: a.rule, reason: a.reason, idleMs: a.idleMs,
    bytesBefore: before, bytesAfter: after, steps, now: deps.now(), pending: left, retry, ...(retry ? { regAt: a.regAt ?? null } : {}) });
  return { freed: before !== null && after !== null ? Math.max(0, before - after) : null, left: left.length };
}

export async function runLifecycle(plan: Plan, policy: LifecyclePolicy, deps: LifecycleDeps): Promise<RunResult> {
  const out: RunResult = { done: [], failed: [] };
  if (policy.mode !== "on") return out;
  const one = async (a: Action) => {
    try {
      const r = await collect(a, deps);
      if ("error" in r) out.failed.push({ agent: a.agent, error: r.error });
      else if (r.left) out.failed.push({ agent: a.agent, error: `${a.agent} 已停，但还有 ${r.left} 处落地物没清（已记待补清，下轮再试；原因见台账事件）` });
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
  for (const a of plan.cleanups) {
    if (budget-- <= 0) break;
    await one(a);
  }
  return out;
}
