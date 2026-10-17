/** Execute the authorized commit in a disposable worktree: never pull or rewrite a PM's private working checkout. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runBounded } from "./run-bounded.js";

export const CENTER_SUBMODULE_FAILED = "中心部署检出失败(子模块)";

export async function centerCheckout(repo: string, jobDir: string, sha: string, run = runBounded) {
  const dir = join(jobDir, "checkout");
  const r = await run(["git", "-C", repo, "worktree", "add", "--detach", dir, sha], { timeoutMs: 60_000 });
  if (r.code !== 0 || r.timedOut) throw new Error("中心部署检出失败");
  const release = async () => {
    const removed = await run(["git", "-C", repo, "worktree", "remove", "--force", dir], { timeoutMs: 60_000 });
    if (removed.code !== 0 || removed.timedOut) console.error("中心部署临时检出待清理");
  };
  // The private deployment script's source closure lives in submodules; a bare detached worktree lacks those files.
  if (existsSync(join(dir, ".gitmodules"))) {
    const sub = await run(["git", "-C", dir, "submodule", "update", "--init", "--recursive"], { timeoutMs: 300_000 });
    if (sub.code !== 0 || sub.timedOut) { await release(); throw new Error(CENTER_SUBMODULE_FAILED); }
  }
  return { dir, release };
}
