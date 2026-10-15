/**
 * The one author-tree judgment GATESWAP1 (recovery-fix-local-swap-run.ts treeRefusal / treeProofSync) and the family-swap tree open
 * (fix-strategy-worktree.ts) share: a present tree is clean (the caller's complete dirty proof), its HEAD is the reviewed fix head,
 * and the source's local card branch is not on another commit. Written once as a generator of git asks, driven with await (the
 * preflight) or without (the commit-edge proof), so both read exactly the same steps and texts. On top of it foreignTreeRefusal
 * (SWAPFIX1 9a) adds what handing another old author's tree to the new author needs: a linked worktree of the source repo, on the
 * card branch, and no live registry session working in it. tests/fix-tree-proof*.test.ts.
 */
import { lstatSync, realpathSync } from "node:fs";
import type { Git } from "./scheduler-review-worktree.js";

type Probe = { code: number; out: string };
type Ask = { git: string[] } | { dirty: true };
type Proof = Generator<Ask, string | null, Probe | string | null>;
type GitSync = (args: string[]) => Probe;

export interface TreeProofTarget {
  /** the tree to prove; null = there is none (only the source's local branch is read) */
  dir: string | null;
  source: string | null;
  branch: string | null;
  head: string | null;
}

function* proof(t: TreeProofTarget): Proof {
  if (t.dir) {
    const dirty = (yield { dirty: true }) as string | null;
    if (dirty) return dirty;
    const sha = (yield { git: ["-C", t.dir, "rev-parse", "--verify", "HEAD"] }) as Probe, at = sha.out.trim();
    if (sha.code !== 0) return `作者工作树 ${t.dir} 读不了 HEAD，保留等待核对`;
    if (at !== t.head) return `作者工作树 ${t.dir} 在 ${at.slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
  }
  if (t.source && t.branch) {
    const local = (yield { git: ["-C", t.source, "rev-parse", "--verify", "--quiet", `refs/heads/${t.branch}`] }) as Probe, at = local.out.trim();
    if (local.code === 0 && at && at !== t.head) {
      return `本地分支 ${t.branch} 在 ${at.slice(0, 12)}，不是已审修复 head（可能有未推送成果），保留等待核对`;
    }
  }
  return null;
}

/** The awaited judgment; `dirty` is the caller's complete dirty proof of `dir`. null = the tree may be handed on. */
export async function fixTreeProof(g: Git, t: TreeProofTarget, dirty: () => Promise<string | null>): Promise<string | null> {
  const run = proof(t);
  for (let step = run.next(); ; ) {
    if (step.done) return step.value;
    step = run.next("dirty" in step.value ? await dirty() : await g(step.value.git));
  }
}

/** The same judgment with no await at all (commit-edge proofs read it at the point they act). */
export function fixTreeProofSync(g: GitSync, t: TreeProofTarget, dirty: () => string | null): string | null {
  const run = proof(t);
  for (let step = run.next(); ; ) {
    if (step.done) return step.value;
    step = run.next("dirty" in step.value ? dirty() : g(step.value.git));
  }
}

const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };

/** Registry rows the live-session check reads: a row not stopped whose working directory is the tree. */
export type LiveRow = { name: string; cwd?: string; status?: string };
export const liveSessionAt = (rows: readonly LiveRow[], dir: string): string | null =>
  rows.find((r) => r.cwd && r.status !== "stopped" && real(r.cwd) === real(dir))?.name ?? null;

/**
 * Another old local author's tree at the target (not this intent's, not the source itself): a linked worktree of the source repo,
 * on the card branch, then the shared judgment above with the complete dirty proof, and no live registry session in it.
 * null = the new author may take it over as it is (nothing deleted, nothing reset); any doubt is the refusal text.
 */
export async function foreignTreeRefusal(g: Git, t: { source: string; dir: string; branch: string; head: string },
  dirty: () => Promise<string | null>, live: (dir: string) => string | null): Promise<string | null> {
  const kept = `旧作者工作树 ${t.dir}`;
  if (lstatSync(t.dir).isSymbolicLink()) return `${kept} 是软链，保留并等待核对`;
  const [git, common, origin] = await Promise.all([g(["-C", t.dir, "rev-parse", "--path-format=absolute", "--git-dir"]),
    g(["-C", t.dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    g(["-C", t.source, "rev-parse", "--path-format=absolute", "--git-common-dir"])]);
  if (git.code !== 0 || common.code !== 0 || real(git.out) === real(common.out)) return `${kept} 不是独立的 linked worktree，保留并等待核对`;
  if (origin.code !== 0 || real(origin.out) !== real(common.out)) return `${kept} 不是作者来源仓库的 linked worktree，保留并等待核对`;
  const at = await g(["-C", t.dir, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (at.code !== 0 || at.out !== t.branch) return `${kept} 不在本卡分支 ${t.branch} 上（${at.out || "detached"}），保留并等待核对`;
  const why = await fixTreeProof(g, t, dirty);
  if (why) return why;
  const holder = live(t.dir);
  return holder ? `${kept} 仍是活会话 ${holder} 的工作目录，不交给新作者` : null;
}
