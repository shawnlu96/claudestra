/**
 * AREB1: the rebuild's hooks into ensureLocalAuthor (scheduler-local-author.ts), each at the edge of an external effect:
 * - target: an existing target is reused only when it is this rebuild's own checkout — a real directory (never a symlink),
 *   registered in this repo's worktree list at that path on the card's branch, with addAuthorWorktree's saved start.
 * - add (after checkout's fetch, before `worktree add`) and ready (right before `manager create`): swap and LIFE1's retire line
 *   are read again (high or unreadable = wait, one note per card + reason) and the PR head (origin/<branch> after the last
 *   fetch) must still be the card's headSHA (else manual, everything kept); add also re-checks the old branch and the drift.
 * - allowed: the launch guard's shared predicate (rebuildAllowed) with this ensure's own created worker.
 */
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE } from "./agent-lifecycle-config.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getTask } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { absent, rebuildAllowed, rebuildBranchGate, rebuildCheckoutDrift, type Created } from "./scheduler-author-rebuild-proof.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { addAuthorWorktree } from "./scheduler-create-retry.js";
import type { LocalAuthorEnv } from "./scheduler-local-author.js";
import { whileOwned } from "./scheduler-maintenance.js";
import type { Git } from "./scheduler-review-worktree.js";
import { readMemory } from "./sys-memory.js";
import type { EnsureResult } from "./worker-session.js";

type Plan = { repo: string; worktree: string; branch: string; base: string };
export interface Rebuild {
  replaces: string; family: "claude" | "codex"; name: string;
  allowed(created?: Created): string | null;
  target(git: Git, p: Plan): Promise<string | null>;
  add(git: Git, p: Plan, existing: boolean): Promise<string | EnsureResult | { code: number; out: string }>;
  ready(p: Plan, guard: () => void): Promise<EnsureResult | null>;
}
export interface PressureDeps { swapPct?: () => Promise<number | null>; readConfig?: () => SchedulerConfig; now?: () => number }

const START_FILE = "scheduler-author-start.json"; // addAuthorWorktree's saved start (scheduler-create-retry-worktree.ts)
const realOr = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

/** Swap above LIFE1's retire line, or either unreadable: wait with one note per card + reason. null = may build. */
export async function rebuildPressure(env: LocalAuthorEnv, task: LedgerTask, deps: PressureDeps): Promise<EnsureResult | null> {
  const note = (key: string, text: string): EnsureResult => {
    appendEvent(env.db, { actor: "scheduler", now: (deps.now ?? Date.now)(), dedupKey: `author-rebuild-wait:${task.id}:${task.agent}:${key}` }, // own transaction
      { project: task.project, target: task.id, kind: "note", text: `作者重建等待：${text}`, data: { op: "author_rebuild_wait", agent: task.agent, key } });
    return { kind: "wait", reason: `作者重建等待：${text}` };
  };
  let line: number, swap: number | null;
  try {
    line = (deps.readConfig ?? readSchedulerConfig)().lifecycle?.swapPct ?? DEFAULT_LIFECYCLE.swapPct;
    swap = await (deps.swapPct ?? (async () => (await readMemory()).swapPct))();
  } catch { swap = null; line = 0; }
  if (swap === null) return note("swap-unknown", "读不到系统 swap，不新建");
  return swap > line ? note("swap", `系统 swap ${Math.round(swap)}% 高于收回线 ${line}%，回落后再建`) : null;
}

/** origin/<branch> as the last fetch left it must be the card's headSHA. */
export async function rebuildPrHead(git: Git, branch: string, headSHA: string | null | undefined): Promise<string | null> {
  const pr = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  return headSHA && pr.code === 0 && pr.out.trim() === headSHA ? null : `PR 当前 head ${pr.out.trim() || "（无）"} 与卡上 ${headSHA ?? "（无）"} 不一致`;
}

/** null = nothing at the target, or this rebuild's own checkout (reusableAuthorWorktree then checks branch, start, edits). */
async function ownCheckout(git: Git, p: Plan): Promise<string | null> {
  const gone = absent(p.worktree);
  if (gone === true) return null;
  if (typeof gone === "string") return `${gone}，保留并等待核对`;
  const kept = `目标 ${p.worktree} 不是本卡重建建的 checkout`;
  const st = lstatSync(p.worktree);
  if (st.isSymbolicLink() || !st.isDirectory()) return `${kept}（软链或非目录），保留并等待核对`;
  const list = await git(["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return `读不了 worktree 列表，保留并等待核对`;
  const mine = list.out.split(/\n\s*\n/).map((r) => r.split("\n"))
    .find((r) => r[0]?.startsWith("worktree ") && realOr(r[0].slice("worktree ".length)) === realOr(p.worktree));
  if (!mine || !mine.includes(`branch refs/heads/${p.branch}`)) return `${kept}（不在本仓库 worktree 列表的 ${p.branch} 上），保留并等待核对`;
  const dir = await git(["-C", p.worktree, "rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return `${kept}（读不了其 Git 目录），保留并等待核对`;
  const saved = absent(join(dir.out.trim(), START_FILE));
  return saved === false ? null : `${kept}（${typeof saved === "string" ? saved : "没有建时保存的起点"}），保留并等待核对`;
}

export function rebuildHooks(env: LocalAuthorEnv, task: LedgerTask, deps: PressureDeps, r: { replaces: string; family: "claude" | "codex"; name: string; gone: string }): Rebuild {
  const manual = (why: string): EnsureResult => ({ kind: "manual", reason: `${r.gone}；重建作者：${why}` });
  const late = async (git: Git, p: Plan): Promise<EnsureResult | null> => {
    const wait = await rebuildPressure(env, task, deps);
    if (wait) return wait;
    const head = await rebuildPrHead(git, p.branch, task.headSHA);
    return head ? manual(head) : null;
  };
  return {
    ...r,
    allowed: (created) => rebuildAllowed(env.db, getTask(env.db, task.id) ?? task, r.replaces, r.family, created),
    target: ownCheckout,
    add: async (git, p, existing) => {
      const stop = (await late(git, p)) ?? (await rebuildBranchGate(env.db, git, p, r.replaces, existing));
      if (stop) return stop;
      const gone = absent(p.worktree);
      if (gone !== true) return gone || `目标目录 ${p.worktree} 已存在，保留并等待核对`;
      const add = await addAuthorWorktree(git, p, existing);
      return add.code === 0 && existing ? (await rebuildCheckoutDrift(git, p)) ?? add : add;
    },
    ready: (p, guard) => late((args) => whileOwned(guard, () => env.git(["-C", p.repo, ...args])), p),
  };
}
