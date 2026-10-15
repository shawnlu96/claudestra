/** Execute the authorized commit in a disposable worktree: never pull or rewrite a PM's private working checkout. */
import { join } from "node:path";
import { runBounded } from "./run-bounded.js";

export async function centerCheckout(repo: string, jobDir: string, sha: string, run = runBounded) {
  const dir = join(jobDir, "checkout");
  const r = await run(["git", "-C", repo, "worktree", "add", "--detach", dir, sha], { timeoutMs: 60_000 });
  if (r.code !== 0 || r.timedOut) throw new Error("中心部署检出失败");
  return { dir, async release() {
    const removed = await run(["git", "-C", repo, "worktree", "remove", "--force", dir], { timeoutMs: 60_000 });
    if (removed.code !== 0 || removed.timedOut) console.error("中心部署临时检出待清理");
  } };
}
