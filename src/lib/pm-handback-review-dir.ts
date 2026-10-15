/**
 * PMHAND1 9补2 · where createReviewer adds the reviewer's worktree from when the card has no bound author cwd, no peer PR repository
 * and no lend project directory (a PM-dispatched local author binds nothing): the project's repoDir from scheduler.json, for a
 * card in the project's own repository only. A private-repo card (repo: globs) or a PR in another repository gets null and stays
 * with the old refusal (reviewed by a peer). prepareReviewHead still checks / fetches the head and the worktree is the usual
 * detached review checkout. Each use leaves one sample note per card + head. Doc: docs/architecture/pm-handback.md.
 */
import type { Database } from "bun:sqlite";
import { privateCardRepo } from "./card-repo.js";
import type { LedgerTask } from "./ledger-stages.js";
import { readSchedulerConfig, type SchedulerConfig } from "./scheduler-config.js";
import { foreignRepoOf, projectRepo } from "./scheduler-foreign-repo.js";
import { recordHandbackSample } from "./pm-handback-sample.js";

export function handbackReviewDir(env: { db: Database; readConfig?: () => SchedulerConfig }, task: LedgerTask): string | null {
  if (privateCardRepo(task)) return null;
  let policy: SchedulerConfig["projects"][string] | undefined;
  try { policy = (env.readConfig ?? readSchedulerConfig)().projects[task.project]; }
  catch (e) { console.error(`⚠️ [pm-handback] ${task.id} 读 scheduler.json 失败，审查目录不退到项目仓库：${(e as Error).message}`); return null; }
  if (!policy?.repoDir || foreignRepoOf(task, projectRepo(policy))) return null;
  recordHandbackSample(env.db, { project: task.project, taskId: task.id, head: task.headSHA, type: "review_dir_fallback",
    text: `执行者没有绑定的工作目录，审查 checkout 退到项目仓库 ${policy.repoDir} 取 head`, data: { repoDir: policy.repoDir } }, Date.now());
  return policy.repoDir;
}
