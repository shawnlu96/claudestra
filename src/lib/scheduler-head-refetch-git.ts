/**
 * SELFHEAL1 · the one bounded fetch of a review head, shared by prepareReviewHead (lend cards: lend branch, then PR head) and
 * peerPrHeadMissing (peer PR cards: refs/pull/<n>/head). `net` is the bounded, lease-checked network git (boundedGit's timeout and
 * no-prompt env); `has` re-checks the exact commit after each fetch, so a ref that moved on never counts as fetched.
 * tests/scheduler-head-refetch.test.ts.
 */
import type { Git } from "./scheduler-review-worktree.js";

const cut = (s: string): string => s.replace(/\s+/g, " ").slice(0, 300);

/** null = the commit is here now; otherwise one line per ref tried. */
export async function fetchHeadVia(net: Git, repoDir: string, refs: readonly string[], has: () => Promise<boolean>): Promise<string[] | null> {
  const tried: string[] = [];
  for (const ref of refs) {
    const f = await net(["-C", repoDir, "fetch", "--no-tags", "-q", "origin", ref]);
    if (f.code === 0 && await has()) return null;
    tried.push(f.code === 0 ? `${ref}：取到了但不含该 commit（引用已移动？）` : `${ref}：${cut(f.out)}`);
  }
  return tried;
}
