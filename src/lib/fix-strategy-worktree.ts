/** The replacement author gets only its pinned linked checkout; source trees and uncertain WIP are preserved.
 * Identity, the real origin and dirty content are re-proved on reuse. tests/fix-strategy-worktree*.test.ts.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { remoteBranchHead, type RemoteHead } from "./order-deliver.js";
import { runBounded } from "./run-bounded.js";
import { rebuildPrHead, refreshTrackingRef } from "./scheduler-author-rebuild-checkout.js";
import { addAuthorWorktree, reusableAuthorWorktree } from "./scheduler-create-retry-worktree.js";
import { buildArtifactOwner, type ConvArtifactContext } from "./conv-ignored-build-artifacts.js";
import { convArtifactMode, convArtifactProof, quarantineConvArtifacts } from "./conv-ignored-build-artifacts-quarantine.js";
import type { Git, Pinned } from "./scheduler-review-worktree.js";
import { foreignTreeRefusal } from "./fix-tree-proof.js";
import type { RecoveryMode } from "./recovery-policy.js";

const START_FILE = "scheduler-author-start.json"; // addAuthorWorktree's saved start (scheduler-create-retry-worktree.ts)

export interface FixTreeTarget { taskId: string; branch: string | null; head: string | null; root: string; artifacts?: ConvArtifactContext; foreign?: ForeignTreePort }
/**
 * SWAPFIX1 9a: another old local author's tree at the target (neither this intent's nor the source) may be taken over as it is when
 * fix-tree-proof.ts's foreignTreeRefusal (GATESWAP1's judgment plus linked / branch / no live session) passes. Switch fixLocalSwap:
 * off (or no port) = the old refusal; observe = record the would-be takeover, the old refusal; on = take it over and record it.
 */
export interface ForeignTreePort {
  mode(): RecoveryMode;
  /** a live registry session working in `dir`, or null */
  live(dir: string): string | null;
  sample(mode: "observe" | "on", dir: string): void;
}
/** The branch head on the real origin as seen from `cwd`; never fetches into it. */
export type OriginHead = (cwd: string, branch: string) => Promise<RemoteHead>;
/** The tracking ref this open fast-forwarded (from = before, null when there was none; to = the reviewed head). */
interface RefRefresh { branch: string; from: string | null; to: string }
export type FixTree = Pinned & { refreshed?: RefRefresh };
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

async function ownerRepo(g: Git, dir: string): Promise<string | undefined> {
  return buildArtifactOwner(dir, await g(["-C", dir, "worktree", "list", "--porcelain"]));
}

/** The old author's own linked checkout at the target: registered there, on the branch, at the head, no edits. */
async function adoptable(g: Git, source: string, dir: string, branch: string, head: string, artifacts?: ConvArtifactContext): Promise<string | null> {
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
  return (await convArtifactProof(g, dir, await ownerRepo(g, dir), artifacts, true)).reason;
}

/** Run with a port that remembers the first error the git port threw and rethrows it after `run`, whatever `run` caught. */
async function surfacing<T>(g: Git, run: (g: Git) => Promise<T>): Promise<T> {
  const thrown: { error: unknown }[] = [];
  const out = await run(async (args) => { try { return await g(args); } catch (error) { thrown.push({ error }); throw error; } });
  if (thrown.length) throw thrown[0].error;
  return out;
}

/**
 * The source's refs/remotes/origin/<branch> is not the reviewed head (or the head's objects are not here yet): fast-forward
 * it alone when the real origin is exactly that head; origin elsewhere (drift), unreadable, or a fetch git refuses (not a fast-forward) hands to PM with the reason.
 */
async function refreshStale(at: Git, origin: OriginHead, repo: string, branch: string, head: string): Promise<RefRefresh | { manual: string }> {
  const was = await at(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  const from = was.code === 0 && was.out ? was.out : null, local = `本机跟踪引用 origin/${branch} 在 ${from ?? "（无）"}`;
  const actual = await origin(repo, branch);
  if (!actual.ok) return { manual: `${local}，不是已审修复 head ${head}；查不到实际远端分支：${actual.error}，不建作者工作树`.slice(0, 400) };
  if (actual.head !== head) return { manual: `远端分支漂移：期望已审修复 head ${head}，实际远端 ${actual.head}（${local}），不建作者工作树` };
  const failed = await refreshTrackingRef(at, branch);
  if (failed) return { manual: `${local}，快进刷新到 ${head} 失败：${failed}，不建作者工作树`.slice(0, 400) };
  const still = await rebuildPrHead(at, branch, head);
  return still ? { manual: `刷新后跟踪引用仍不符：${still}，不建作者工作树` } : { branch, from, to: head };
}

async function originDrift(origin: OriginHead, source: string, branch: string, head: string): Promise<string | null> {
  const actual = await origin(source, branch);
  if (!actual.ok) return `查不到实际远端分支：${actual.error}，不建作者工作树`.slice(0, 400);
  return actual.head === head ? null : `实际远端分支 ${branch} 在 ${actual.head}，不是已审修复 head ${head}，不建作者工作树`;
}

/**
 * Open (once) or re-verify the replacement author's tree. `recorded` is this intent's journaled target: a retry only reuses
 * the tree it created itself (saved start = head) or the adopted old author tree, re-checked identically. No force; the only fetch is refreshStale's one fast-forward.
 */
export function openFixWorktree(g: Git, source: string, t: FixTreeTarget, recorded: string | null, origin: OriginHead = lsRemoteHead): Promise<FixTree> {
  return surfacing(g, (port) => openTree(port, source, t, recorded, origin));
}

async function openTree(g: Git, source: string, t: FixTreeTarget, recorded: string | null, origin: OriginHead): Promise<FixTree> {
  if (!t.head || !/^[0-9a-f]{40,64}$/.test(t.head)) return { manual: "卡上没有已审修复 head，不建作者工作树" };
  if (!t.branch) return { manual: "卡上没有正式分支，不建作者工作树" };
  const dir = fixTreePath(t.root, t.taskId);
  if (!dir) return { manual: "卡号不能安全映射到作者工作树目录" };
  if (recorded && real(recorded) !== real(dir)) return { manual: `本意图记录的工作树 ${recorded} 与规范目录 ${dir} 不符，保留等待核对` };
  const top = await g(["-C", source, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { manual: `作者来源 ${source} 不可读或不是 git 仓库，不建作者工作树` };
  const at = (args: string[]) => g(["-C", source, ...args]);
  if ((await at(["check-ref-format", "--branch", t.branch])).code !== 0) return { manual: "卡上分支名不合法" };
  const head = t.head, present = async () => { const c = await at(["rev-parse", "--verify", "--quiet", `${head}^{commit}`]); return c.code === 0 && c.out === head; };
  const absent = !(await present());
  let refreshed: RefRefresh | undefined;
  if (absent || await rebuildPrHead(at, t.branch, head)) {
    const fresh = await refreshStale(at, origin, top.out, t.branch, head);
    if ("manual" in fresh) return absent ? { manual: `来源仓库里没有已审修复 head ${head}；${fresh.manual}`.slice(0, 400) } : fresh;
    if (absent && !(await present())) return { manual: `单分支抓取后来源仓库里仍没有已审修复 head ${head}，不建作者工作树` };
    refreshed = fresh;
  }
  const tree = await buildTree(g, at, source, { dir, branch: t.branch, head: t.head, repo: top.out }, recorded, origin, t.artifacts, t.foreign);
  return refreshed ? { ...tree, refreshed } : tree;
}

async function buildTree(g: Git, at: Git, source: string, { dir, branch, head, repo }: { dir: string; branch: string; head: string; repo: string },
  recorded: string | null, origin: OriginHead, artifacts?: ConvArtifactContext, foreign?: ForeignTreePort): Promise<Pinned> {
  artifacts = artifacts && convArtifactMode(artifacts) !== "off" ? artifacts : undefined;
  const actual = () => originDrift(origin, repo, branch, head);
  const early = await actual();
  if (early) return { manual: early };
  const ready = async (verify: () => Promise<string | null>): Promise<Pinned> => {
    const late = await actual();
    if (late) return { manual: late };
    const owner = artifacts && await ownerRepo(g, dir);
    const refused = artifacts ? owner ? await quarantineConvArtifacts(g, dir, owner, artifacts, { branch, head }, async () => await actual() ?? await verify()) : "缺主仓库归属，不隔离" : null;
    const final = artifacts && !refused ? await actual() : null;
    return refused || final ? { manual: refused ?? final! } : { dir };
  };
  const plan = { repo, worktree: dir, branch, base: head };
  const dirty = async () => (await convArtifactProof(g, dir, await ownerRepo(g, dir), artifacts, true)).reason;
  const ownCheck = () => reusableAuthorWorktree(at, plan, artifacts ? dirty : undefined);
  const adoptCheck = () => adoptable(g, source, dir, branch, head, artifacts);
  if (existsSync(dir)) {
    const own = recorded && await createdHere(g, dir) ? await ownCheck() : "不是本意图建的";
    if (!own) return ready(ownCheck);
    const adopted = await adoptCheck();
    if (!adopted) return ready(adoptCheck);
    const mode = foreign && real(source) !== real(dir) ? foreign.mode() : "off";
    const foreignCheck = () => foreignTreeRefusal(g, { source, dir, branch, head }, dirty, foreign!.live);
    if (mode === "off" || await foreignCheck()) return { manual: adopted.slice(0, 400) };
    const late = foreign!.mode(); // read again after the proof's awaits
    if (late !== "on") { if (late === "observe") foreign!.sample("observe", dir); return { manual: adopted.slice(0, 400) }; }
    const taken = await ready(foreignCheck);
    if (!("dir" in taken)) return taken;
    // ready() awaits the origin (and isolation) after the proof: the switch and the registry are read again here, with no await
    // before the hand-over; the caller's create / bind gate reads them once more at its own edges (fix-strategy-remote.ts)
    const holder = foreign!.live(dir);
    if (foreign!.mode() !== "on" || holder) return { manual: holder ? `旧作者工作树 ${dir} 已是活会话 ${holder} 的工作目录，不交给新作者` : adopted.slice(0, 400) };
    foreign!.sample("on", dir);
    return taken;
  }
  const local = await at(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0 && local.out !== head) return { manual: `本地分支 ${branch} 在 ${local.out}，不是已审修复 head（可能有旧 WIP），保留等待核对` };
  const add = await addAuthorWorktree(at, plan, local.code === 0);
  if (add.code !== 0) return { manual: `建作者工作树失败：${add.out}`.slice(0, 400) };
  const check = await reusableAuthorWorktree(at, plan);
  return check ? { manual: check } : ready(ownCheck);
}
