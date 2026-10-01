/**
 * 出借方写的卡建审查 worktree 用哪个仓库（i28-PUB1）：卡固定给 peer 写（start_node placement = peer:X）时本机没有执行者目录，
 * 接管 / 远端交付之后 createReviewer（scheduler-auto-deps.ts）取不到 authorDir 就只能交 PM。这时退到 scheduler.json 里这个项目的
 * repoDir（每个调度项目必填的绝对路径），并保证交付 head 在本机：没有就从 origin 拉一次出借分支（只取对象，不动工作区、不建本地分支）。
 * 只对 head 由出借单写的卡生效（remoteHeadFamily 认得出），本机执行者的卡照旧取不到就交 PM。tests/lend-pr-takeover.test.ts。
 */
import type { Database } from "bun:sqlite";
import { LEND_BRANCH_RE } from "./lend-git.js";
import type { LedgerTask } from "./ledger-stages.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import type { Git } from "./scheduler-review-worktree.js";

const SHA40 = /^[0-9a-f]{40}$/;

export async function lendReviewDir(db: Database, task: LedgerTask, git: Git, read: () => SchedulerConfig = readSchedulerConfig): Promise<string | null> {
  if (!task.headSHA || !SHA40.test(task.headSHA) || !remoteHeadFamily(db, task)) return null;
  let dir: string | undefined;
  try { dir = read().projects[task.project]?.repoDir; } catch (e) {
    console.error(`⚠️ [lend-takeover] 读 scheduler.json 失败，${task.id} 的审查目录退不到项目仓库：${(e as Error).message}`);
    return null;
  }
  if (!dir) return null;
  if ((await git(["-C", dir, "cat-file", "-e", `${task.headSHA}^{commit}`])).code === 0) return dir;
  if (!task.branch || !LEND_BRANCH_RE.test(task.branch)) return null;
  await git(["-C", dir, "fetch", "--no-tags", "-q", "origin", `refs/heads/${task.branch}`]);
  return (await git(["-C", dir, "cat-file", "-e", `${task.headSHA}^{commit}`])).code === 0 ? dir : null;
}
