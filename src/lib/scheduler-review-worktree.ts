/**
 * The per-card reviewer's own checkout: a detached linked worktree of the author's repository, pinned to the head under
 * review before every dispatch. It shares the object store, so a head the author committed is visible without a fetch,
 * and the author's later commits never shift what the reviewer reads. A reviewer that left tracked edits is not
 * overwritten: the dispatch stops for PM. This isolates files only — the session's permission mode is the runtime's.
 */
import { existsSync } from "node:fs";

export type Git = (args: string[]) => Promise<{ code: number; out: string }>;
export type Pinned = { dir: string } | { manual: string };

export const git: Git = async (args) => {
  const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: (code === 0 ? out : err || out).trim() };
};

/** Move the reviewer's checkout to `head`, refusing when the reviewer changed tracked files. */
export async function pinReviewWorktree(dir: string, head: string, g: Git = git): Promise<Pinned> {
  const st = await g(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  if (st.code !== 0) return { manual: `审查 worktree ${dir} 读不了：${st.out}`.slice(0, 400) };
  if (st.out) return { manual: `审查 worktree 有已跟踪文件被改过（审查员不该改被审代码），不覆盖：${st.out.split("\n").slice(0, 5).join("; ")}`.slice(0, 400) };
  const co = await g(["-C", dir, "checkout", "-q", "--detach", head]);
  if (co.code !== 0) return { manual: `审查 worktree 切不到 ${head}：${co.out}`.slice(0, 400) };
  const at = await g(["-C", dir, "rev-parse", "HEAD"]);
  return at.code === 0 && at.out === head ? { dir } : { manual: `审查 worktree 切完不在 ${head}（在 ${at.out}）` };
}

/** Create `dir` (once) from the author's repository and pin it. */
export async function openReviewWorktree(authorDir: string, dir: string, head: string | null, g: Git = git): Promise<Pinned> {
  if (!head) return { manual: "卡上没有交付 head，审查 worktree 不知道固定到哪" };
  if (existsSync(dir)) return pinReviewWorktree(dir, head, g);
  const top = await g(["-C", authorDir, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { manual: `执行者目录 ${authorDir} 不是 git 仓库，建不了独立的审查 worktree` };
  const add = await g(["-C", authorDir, "worktree", "add", "--detach", dir, head]);
  if (add.code !== 0) return { manual: `建审查 worktree 失败：${add.out}`.slice(0, 400) };
  return pinReviewWorktree(dir, head, g);
}
