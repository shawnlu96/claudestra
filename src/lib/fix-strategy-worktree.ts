/**
 * The replacement fix author's own checkout: the canonical author path (<root>/<task>) on the card branch at the reviewed head.
 * The source checkout (old author tree or, after a peer reclaim, the project main tree) is only read for git objects; it is
 * never fetched, checked out, reset or cleaned. A missing head, origin drift, a local branch elsewhere, a dirty or foreign
 * occupant and an unreadable source all hand to PM with zero effect. The old author's tree is adopted only when it already
 * is that canonical linked tree, clean at the head (git refuses a second checkout of the branch). Origin is the real remote
 * (ls-remote, read-only), checked before the tree and again right before handing it out; anything the git port throws (a
 * lease loss or stop) propagates even through helpers that turn errors into a dirty-tree note. tests/fix-strategy-worktree*.test.ts.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { remoteBranchHead, type RemoteHead } from "./order-deliver.js";
import { runBounded } from "./run-bounded.js";
import { rebuildPrHead } from "./scheduler-author-rebuild-checkout.js";
import { addAuthorWorktree, retryWorktreeDirty, reusableAuthorWorktree } from "./scheduler-create-retry-worktree.js";
import type { Git, Pinned } from "./scheduler-review-worktree.js";

const START_FILE = "scheduler-author-start.json"; // addAuthorWorktree's saved start (scheduler-create-retry-worktree.ts)

export interface FixTreeTarget { taskId: string; branch: string | null; head: string | null; root: string }
/** The branch head on the real origin as seen from `cwd`; never fetches into it. */
export type OriginHead = (cwd: string, branch: string) => Promise<RemoteHead>;
export const lsRemoteHead: OriginHead = (cwd, branch) => remoteBranchHead(cwd, branch, runBounded);

const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

/** The canonical author checkout path start_node uses, or null when the card id could leave the root. */
export function fixTreePath(root: string, taskId: string): string | null {
  const low = taskId.toLowerCase();
  return /^[\w.-]+$/.test(low) && !/^\.+$/.test(low) ? join(root, low) : null;
}

/** Only a tree addAuthorWorktree made carries its saved start; reusableAuthorWorktree alone also accepts older trees without it. */
async function createdHere(g: Git, dir: string): Promise<boolean> {
  const own = await g(["-C", dir, "rev-parse", "--absolute-git-dir"]);
  return own.code === 0 && existsSync(join(own.out, START_FILE));
}

/** The old author's own linked checkout at the target: registered there, on the branch, at the head, no edits. */
async function adoptable(g: Git, source: string, dir: string, branch: string, head: string): Promise<string | null> {
  if (real(source) !== real(dir)) return `目标 ${dir} 已被占用（不是本意图建的、也不是原作者的独立工作树），保留并等待核对`;
  const kept = `原作者工作树 ${dir}`;
  if (lstatSync(dir).isSymbolicLink()) return `${kept} 是软链，保留并等待核对`;
  const [git, common] = await Promise.all([g(["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"]),
    g(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])]);
  if (git.code !== 0 || common.code !== 0 || real(git.out) === real(common.out)) return `${kept} 不是独立的 linked worktree（主树不交给新作者），保留并等待核对`;
  const at = await g(["-C", dir, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (at.code !== 0 || at.out !== branch) return `${kept} 不在本卡分支 ${branch} 上（${at.out || "detached"}），保留并等待核对`;
  const sha = await g(["-C", dir, "rev-parse", "--verify", "HEAD"]);
  if (sha.code !== 0 || sha.out !== head) return `${kept} HEAD ${sha.out || "（无）"} 不是已审修复 head ${head}，保留旧 WIP 等待核对`;
  return retryWorktreeDirty(g, dir);
}

/** Run with a port that remembers the first error the git port threw and rethrows it after `run`, whatever `run` caught. */
async function surfacing<T>(g: Git, run: (g: Git) => Promise<T>): Promise<T> {
  const thrown: { error: unknown }[] = [];
  const out = await run(async (args) => { try { return await g(args); } catch (error) { thrown.push({ error }); throw error; } });
  if (thrown.length) throw thrown[0].error;
  return out;
}

async function originDrift(origin: OriginHead, source: string, branch: string, head: string): Promise<string | null> {
  const actual = await origin(source, branch);
  if (!actual.ok) return `查不到实际远端分支：${actual.error}，不建作者工作树`.slice(0, 400);
  return actual.head === head ? null : `实际远端分支 ${branch} 在 ${actual.head}，不是已审修复 head ${head}，不建作者工作树`;
}

/**
 * Open (once) or re-verify the replacement author's tree. `recorded` is this intent's journaled target: a retry only reuses
 * the tree it created itself (saved start = head) or the adopted old author tree, re-checked identically. No fetch, no force.
 */
export function openFixWorktree(g: Git, source: string, t: FixTreeTarget, recorded: string | null, origin: OriginHead = lsRemoteHead): Promise<Pinned> {
  return surfacing(g, (port) => openTree(port, source, t, recorded, origin));
}

async function openTree(g: Git, source: string, t: FixTreeTarget, recorded: string | null, origin: OriginHead): Promise<Pinned> {
  if (!t.head || !/^[0-9a-f]{40,64}$/.test(t.head)) return { manual: "卡上没有已审修复 head，不建作者工作树" };
  if (!t.branch) return { manual: "卡上没有正式分支，不建作者工作树" };
  const dir = fixTreePath(t.root, t.taskId);
  if (!dir) return { manual: "卡号不能安全映射到作者工作树目录" };
  if (recorded && real(recorded) !== real(dir)) return { manual: `本意图记录的工作树 ${recorded} 与规范目录 ${dir} 不符，保留等待核对` };
  const top = await g(["-C", source, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { manual: `作者来源 ${source} 不可读或不是 git 仓库，不建作者工作树` };
  const at = (args: string[]) => g(["-C", source, ...args]);
  if ((await at(["check-ref-format", "--branch", t.branch])).code !== 0) return { manual: "卡上分支名不合法" };
  const commit = await at(["rev-parse", "--verify", "--quiet", `${t.head}^{commit}`]);
  if (commit.code !== 0 || commit.out !== t.head) return { manual: `来源仓库里没有已审修复 head ${t.head}（不 fetch 主树），等待核对` };
  const drift = await rebuildPrHead(at, t.branch, t.head);
  if (drift) return { manual: `远端分支漂移：${drift}，不建作者工作树` };
  const branch = t.branch, head = t.head;
  const actual = () => originDrift(origin, top.out, branch, head);
  const early = await actual();
  if (early) return { manual: early };
  const ready = async (): Promise<Pinned> => { const late = await actual(); return late ? { manual: late } : { dir }; };
  const plan = { repo: top.out, worktree: dir, branch: t.branch, base: t.head };
  if (existsSync(dir)) {
    const own = recorded && await createdHere(g, dir) ? await reusableAuthorWorktree(at, plan) : "不是本意图建的";
    if (!own) return ready();
    const adopted = await adoptable(g, source, dir, t.branch, t.head);
    return adopted ? { manual: adopted.slice(0, 400) } : ready();
  }
  const local = await at(["rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`]);
  if (local.code === 0 && local.out !== t.head) return { manual: `本地分支 ${t.branch} 在 ${local.out}，不是已审修复 head（可能有旧 WIP），保留等待核对` };
  const add = await addAuthorWorktree(at, plan, local.code === 0);
  if (add.code !== 0) return { manual: `建作者工作树失败：${add.out}`.slice(0, 400) };
  const check = await reusableAuthorWorktree(at, plan);
  return check ? { manual: check } : ready();
}
