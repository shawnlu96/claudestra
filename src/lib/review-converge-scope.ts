/**
 * The fix diff a round ≥ SCOPE_ROUND review is scoped to: files changed between the head the previous round reviewed and this
 * round's verdict head. The planner is pure and the ledger CLI re-plans inside its own transaction, so both read it from the
 * snapshot; commits never change, so a computed answer is cached per process. No checkout holding both commits → null, and
 * the planner then demotes nothing on scope (a P1 is kept rather than dropped on a guess). tests/review-converge-scope.test.ts.
 */
import { existsSync } from "node:fs";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { statePath } from "./paths.js";
import { REPO_ROOT } from "./repo-root.js";
import { prevReviewedHead, SCOPE_ROUND, type FixDiff } from "./review-converge.js";

export type DiffRunner = (dir: string, from: string, to: string) => string[] | null;

const SHA = /^[a-f0-9]{40}$/i;
const cache = new Map<string, string[]>();

const gitDiffNames: DiffRunner = (dir, from, to) => {
  const r = Bun.spawnSync(["git", "-C", dir, "diff", "--name-only", "--no-renames", "-z", `${from}..${to}`], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().split("\0").filter(Boolean) : null;
};

/** Checkouts likely to hold both commits: the card's review worktree, the author's worktree, then this install's own repo. */
export function diffDirs(taskId: string): string[] {
  const id = taskId.toLowerCase();
  return [statePath("worktrees", `rv-${id}`), statePath("worktrees", id), REPO_ROOT].filter((d) => existsSync(d));
}

/** null outside the scoped rounds, without a current-round verdict, or when no checkout can answer. */
export function fixDiffOf(task: Pick<LedgerTask, "id" | "round">, events: readonly LedgerEvent[],
  run: DiffRunner = gitDiffNames, dirs: string[] = diffDirs(task.id)): FixDiff | null {
  if (task.round < SCOPE_ROUND) return null;
  const to = events.findLast((e) => e.kind === "review" && e.data.round === task.round)?.data.head;
  const from = prevReviewedHead(events, task.round);
  if (typeof to !== "string" || !from || !SHA.test(to) || !SHA.test(from)) return null;
  const key = `${from}..${to}`;
  const hit = cache.get(key);
  if (hit) return { from, to, files: hit };
  for (const dir of dirs) {
    let files: string[] | null;
    try { files = run(dir, from, to); }
    catch (e) {
      // Git may be unavailable, or this checkout may vanish between discovery and diff; retain P1 rather than guessing.
      console.warn(`[review-converge] diff ${from}..${to} failed in ${dir}: ${(e as Error).message}`);
      continue;
    }
    if (!files) continue;
    cache.set(key, files);
    return { from, to, files };
  }
  return null;
}
