/**
 * Carries out a lifecycle plan (agent-lifecycle.ts) in "on" mode; observe and off never reach here, so they have no side effects.
 * retire = archive → `manager remove` (the same path PM uses) → the agent's own checkout (`git worktree remove`, no --force; its
 * node_modules and build output go with it) → its Claude Code temp folder; park = archive → `manager kill` (registry and checkout
 * kept for resume). The agent's paths are measured before and after and the difference goes into the ledger event.
 * Repeating a step is harmless: archive of a gone agent, remove of a removed one and a worktree already gone all count as done.
 */
import { join, sep } from "node:path";
import type { LifecyclePolicy } from "./agent-lifecycle-config.js";
import type { RetireRecord } from "./agent-lifecycle-store.js";
import type { Action, Plan } from "./agent-lifecycle.js";
import { archiveReceipt, killOutcome, removeCleanWorktree, type LiveAgent, type RetireDeps, within, worktreeDirs } from "./scheduler-retire.js";
import { claudeTmpDirFor, tmpDirVerdict, type TmpCleaner } from "./scheduler-retire-tmp.js";

export interface LifecycleDeps extends Pick<RetireDeps, "git" | "exists"> {
  /** plain manager CLI: archive / kill / remove */
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

export interface RunResult { done: { agent: string; rule: string; mode: string; freed: number | null }[]; failed: { agent: string; error: string }[] }

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

async function cleanDisk(a: Action, deps: LifecycleDeps, dirs: string[], steps: string[]): Promise<void> {
  const agents = (await deps.agents()).filter((x) => x.name !== a.agent);
  for (const dir of dirs) {
    const why = await removeCleanWorktree(deps, dir, agents);
    steps.push(why ? `worktree 没删 ${dir}：${why}` : `worktree 已清 ${dir}`);
  }
  if (!deps.tmp?.root) return;
  const live = agents.filter((x) => x.status !== "stopped" && x.cwd).map((x) => ({ name: x.name, cwd: x.cwd! }));
  for (const dir of dirs) {
    if (a.cwd && !within(a.cwd, dir)) continue; // the temp folder is keyed by the session's cwd; only an own checkout's is ours
    const v = tmpDirVerdict(claudeTmpDirFor(a.cwd ?? dir, deps.tmp.root), deps.tmp.root, live);
    if ("rm" in v) { await deps.tmp.rm(v.rm); steps.push(`临时目录已清 ${v.rm}`); }
    else if ("refuse" in v) steps.push(`临时目录没删：${v.refuse}`);
  }
}

/** One agent end to end; throws only for an unexpected error, a refused stop returns its reason. */
async function collect(a: Action, deps: LifecycleDeps): Promise<{ freed: number | null } | { error: string }> {
  const dirs = a.mode === "retire" ? ownedCheckouts(a, deps.worktreeRoot) : [];
  const measure = (dirs.length && deps.tmp?.root && a.cwd) ? [...dirs, claudeTmpDirFor(a.cwd, deps.tmp.root)] : dirs;
  const before = measure.length ? await deps.du(measure) : null;
  const steps = [archiveReceipt(await deps.manager("archive", a.agent))];
  const stop = killOutcome(await deps.manager(a.mode === "retire" ? "remove" : "kill", a.agent));
  if (!("receipt" in stop)) return { error: "busy" in stop ? `${a.agent} 正忙，下轮再收：${stop.busy}` : stop.failed };
  steps.push(stop.receipt);
  if (dirs.length) await cleanDisk(a, deps, dirs, steps);
  const after = measure.length ? await deps.du(measure) : null;
  await deps.record({ agent: a.agent, taskId: a.taskId, role: a.role, rule: a.rule, mode: a.mode, reason: a.reason, idleMs: a.idleMs,
    bytesBefore: before, bytesAfter: after, steps, now: deps.now() });
  return { freed: before !== null && after !== null ? Math.max(0, before - after) : null };
}

export async function runLifecycle(plan: Plan, policy: LifecyclePolicy, deps: LifecycleDeps): Promise<RunResult> {
  const out: RunResult = { done: [], failed: [] };
  if (policy.mode !== "on") return out;
  const one = async (a: Action) => {
    try {
      const r = await collect(a, deps);
      if ("error" in r) out.failed.push({ agent: a.agent, error: r.error });
      else out.done.push({ agent: a.agent, rule: a.rule, mode: a.mode, freed: r.freed });
    } catch (e) {
      out.failed.push({ agent: a.agent, error: (e as Error).message });
    }
  };
  let budget = policy.perPass;
  for (const a of plan.actions) {
    if (budget-- <= 0) return out;
    await one(a);
  }
  for (const a of plan.memory) {
    if (budget-- <= 0) break;
    const swap = await deps.swapPct(); // re-read after each: stop as soon as swap is back under the threshold
    if (swap === null || swap <= policy.swapPct) break;
    await one(a);
  }
  return out;
}
