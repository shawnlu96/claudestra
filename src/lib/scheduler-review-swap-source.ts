/**
 * dispatch-recovery-RVSRC1 · where a replacement reviewer's worktree comes from. Peer PR card → scheduler.json repoDir
 * (peerPrRepoDir); author in this machine's registry → its cwd (both unchanged). Author not in the registry (a lent-out
 * executor on another machine, task.agent empty) → the same repoDir, only when the card's head is already a local commit
 * there: no fetch, and the main tree's working copy and branch are never touched (the worktree is a detached linked one).
 * tests/scheduler-review-swap-source*.test.ts.
 */
import type { LedgerTask } from "./ledger-stages.js";
import { peerPrRepoDir } from "./peer-pr-hold.js";
import type { RegistryAgent } from "./registry.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import type { Git } from "./scheduler-review-worktree.js";

export async function reviewSource(task: LedgerTask, author: string | null, rows: readonly Pick<RegistryAgent, "name" | "cwd">[], g: Git,
  read = readSchedulerConfig): Promise<{ dir: string } | { manual: string }> {
  const peer = peerPrRepoDir(task, read);
  if (peer) return { dir: peer };
  const local = author ? rows.find((r) => r.name === author) : undefined;
  if (local) return local.cwd ? { dir: local.cwd } : { manual: "找不到作者工作目录，无法建立新的审查 worktree" };
  let repo: string | null = null;
  try { repo = read().projects[task.project]?.repoDir ?? null; }
  catch (e) { return { manual: `作者不在本机，读 scheduler.json 失败：${(e as Error).message}`.slice(0, 400) }; }
  if (!repo) return { manual: `作者不在本机，scheduler.json 里没有项目 ${task.project} 的 repoDir，无法建立新的审查 worktree` };
  if (!task.headSHA) return { manual: "卡上没有交付 head，审查 worktree 不知道固定到哪" };
  const r = await g(["-C", repo, "cat-file", "-e", `${task.headSHA}^{commit}`]);
  return r.code === 0 ? { dir: repo } : { manual: `作者不在本机，head ${task.headSHA.slice(0, 12)} 不是 ${repo} 的本地提交（不 fetch），无法建立新的审查 worktree` };
}
