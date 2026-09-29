import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";

const worktreeCache = new Map<string, boolean>();
/**
 * 工作目录是不是 git 的 linked worktree：往上找第一个 .git，是文件、且指向 `…/worktrees/<名字>` 才算。
 * submodule 的 .git 也是文件，但指向 `…/modules/…`，它的 memory 目录不和别人共用，不能当执行者。按目录缓存（cwd 不会变）
 */
export function isLinkedWorktree(dir: string | null | undefined): boolean {
  if (!dir) return false;
  const hit = worktreeCache.get(dir);
  if (hit !== undefined) return hit;
  let v = false;
  for (let d = dir; ; d = dirname(d)) {
    const g = join(d, ".git");
    if (existsSync(g)) {
      try {
        v = statSync(g).isFile() && /[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(readFileSync(g, "utf8").trim());
      } catch {
        v = false; // 刚好被删：当普通仓库，下次 cwd 变了才会重算（cwd 不变，这里只是防抛）
      }
      break;
    }
    if (dirname(d) === d) break;
  }
  worktreeCache.set(dir, v);
  return v;
}
