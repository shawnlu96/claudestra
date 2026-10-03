/** Untouched checkouts left by clean create failures can be reused; every uncertain case is preserved for PM. */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Git } from "./scheduler-review-worktree.js";
import { writeTextAtomicSync } from "./state-file.js";

type Plan = { repo: string; worktree: string; branch: string; base: string };
const START_FILE = "scheduler-author-start.json";

/** Record the resolved base in Git's private worktree directory, so a later fetch cannot redefine this card's start. */
export async function addAuthorWorktree(git: Git, p: Plan): Promise<{ code: number; out: string }> {
  const start = await git(["rev-parse", "--verify", `${p.base}^{commit}`]);
  if (start.code !== 0) return start;
  const add = await git(["worktree", "add", "-b", p.branch, p.worktree, start.out]);
  if (add.code !== 0) return add;
  const dir = await git(["-C", p.worktree, "rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return dir;
  try {
    writeTextAtomicSync(join(dir.out, START_FILE), JSON.stringify({ repo: p.repo, worktree: p.worktree, branch: p.branch, base: p.base, sha: start.out }));
    return add;
  } catch (e) { return { code: 1, out: `保存 worktree 起点失败：${String(e)}` }; }
}

/** Without a saved start (older checkouts), require equality to the current base, never merely ancestry. */
async function expectedStart(git: Git, p: Plan): Promise<{ sha: string } | { reason: string }> {
  const dir = await git(["-C", p.worktree, "rev-parse", "--absolute-git-dir"]);
  if (dir.code !== 0) return { reason: `读不了 worktree 起点：${dir.out}` };
  try {
    const saved = JSON.parse(readFileSync(join(dir.out, START_FILE), "utf8"));
    if (saved.repo !== p.repo || saved.worktree !== p.worktree || saved.branch !== p.branch || saved.base !== p.base
      || typeof saved.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(saved.sha)) return { reason: "保存的 worktree 起点与本卡不符" };
    return { sha: saved.sha };
  } catch (e) {
    // Missing metadata predates this mechanism; corrupt or unreadable metadata cannot authorize a retry.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { reason: `读不了保存的 worktree 起点：${String(e)}` };
  }
  const base = await git(["rev-parse", "--verify", `${p.base}^{commit}`]);
  return base.code === 0 ? { sha: base.out } : { reason: `读不了本卡起点 ${p.base}：${base.out}` };
}

/** Only the exact dependency links checkout creates are exempt, even when Git ignores their paths. */
function dependencyLinks(worktree: string, repo?: string): { allowed: Set<string>; changed: string[] } {
  const allowed = new Set<string>(), changed: string[] = [];
  for (const sub of ["node_modules", "web/node_modules"]) {
    const dest = join(worktree, sub);
    try {
      const stat = lstatSync(dest);
      if (repo && stat.isSymbolicLink() && resolve(dirname(dest), readlinkSync(dest)) === resolve(repo, sub)) allowed.add(sub);
      else changed.push(sub);
    } catch (e) {
      // Absent links are fine; other stat/readlink failures must not be mistaken for a clean checkout.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") changed.push(`${sub}: ${String(e)}`);
    }
  }
  return { allowed, changed };
}

/** Explicit untracked listing ignores status.showUntrackedFiles; NUL records preserve unusual filenames. */
export async function retryWorktreeDirty(git: Git, worktree: string, repo?: string): Promise<string | null> {
  const st = await git(["-C", worktree, "status", "--porcelain", "-z", "--untracked-files=all"]);
  if (st.code !== 0) return `worktree ${worktree} 读不了工作区状态：${st.out}`.slice(0, 400);
  const { allowed, changed } = dependencyLinks(worktree, repo);
  changed.push(...st.out.split("\0").filter((l) => l && !(l.startsWith("?? ") && allowed.has(l.slice(3)))));
  return changed.length ? `worktree 有改动（${worktree}），不复用也不删除，保留并等待核对：${changed.slice(0, 5).join("; ")}`.slice(0, 400) : null;
}

/** Same branch, exact initial SHA, no edits: a clean create failure may retry without deleting its prepared worktree. */
export async function reusableAuthorWorktree(git: Git, p: Plan): Promise<string | null> {
  const at = (args: string[]) => git(["-C", p.worktree, ...args]);
  const kept = `worktree ${p.worktree} 已存在`;
  const branch = await at(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.out !== p.branch) return `${kept}，但不在本卡分支 ${p.branch} 上（${branch.out || "detached"}），保留并等待核对`;
  const start = await expectedStart(git, p);
  if ("reason" in start) return `${kept}，${start.reason}，保留并等待核对`;
  const head = await at(["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0 || head.out !== start.sha) return `${kept}，HEAD 不在本卡起点 ${start.sha} 上（有自己的提交或起点错误），保留并等待核对`;
  return retryWorktreeDirty(git, p.worktree, p.repo);
}
