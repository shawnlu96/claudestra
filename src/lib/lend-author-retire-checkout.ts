/** Reusing a lender's branch requires this mechanism's durable retirement, exact PR head and no worktree holder. */
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { retiredLendAuthor } from "./lend-author-retire-state.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { absent, rebuildCheckoutDrift } from "./scheduler-author-rebuild-proof.js";
import { rebuildPrHead, refreshTrackingRef, type Rebuild } from "./scheduler-author-rebuild-checkout.js";
import { addAuthorWorktree } from "./scheduler-create-retry.js";
import type { LedgerTask } from "./ledger-stages.js";
import type { LocalAuthorEnv } from "./scheduler-local-author.js";
import type { Git } from "./scheduler-review-worktree.js";
import { whileOwned } from "./scheduler-maintenance.js";
import type { EnsureResult } from "./worker-session.js";

export async function lendAuthorBranchGate(git: Git, p: { branch: string; base: string; worktree: string }): Promise<string | null> {
  const head = await git(["rev-parse", "--verify", `refs/heads/${p.branch}^{commit}`]);
  if (head.code !== 0 || head.out.trim() !== p.base) return `分支 ${p.branch} head 与已核 PR head 不一致`;
  const list = await git(["worktree", "list", "--porcelain"]);
  if (list.code !== 0 || !list.out.includes("worktree ")) return "读不到 worktree 列表";
  if (list.out.split("\n").includes(`branch refs/heads/${p.branch}`)) return `分支 ${p.branch} 被别的 worktree 占用`;
  return null;
}

export function lendAuthorCheckout(env: LocalAuthorEnv, task: LedgerTask): Rebuild | undefined {
  if (!retiredLendAuthor(env.db, task) || task.agent) return;
  const family = getWorkflow(env.db, task.id)!.authorFamily;
  const manual = (reason: string): EnsureResult => ({ kind: "manual", reason });
  const allowed = () => {
    const t = getTask(env.db, task.id);
    return !t || t.rev !== task.rev || t.headSHA !== task.headSHA || t.specRev !== task.specRev || t.agent
      || recoveryPolicy(t.project, "lendAuthorRebuild", env.registryPath ? join(dirname(env.registryPath), "recovery-policy.json") : undefined).mode !== "on"
      || !retiredLendAuthor(env.db, t) ? "peer 作者退役证明或恢复策略已变" : null;
  };
  const fresh = async (git: Git, branch: string): Promise<string | null> =>
    (await refreshTrackingRef(git, branch)) ?? (await rebuildPrHead(git, branch, task.headSHA));
  return {
    family, name: `agent-task-${task.id.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.slice(0, 54), allowed,
    target: async (_git, p) => {
      const a = absent(p.worktree);
      return a === true ? null : `目标 worktree 已存在或读不到，保留现场：${p.worktree}`;
    },
    add: async (git, p, existing) => {
      const why = allowed() ?? await fresh(git, p.branch) ?? (existing ? await lendAuthorBranchGate(git, p) : null);
      if (why) return manual(why);
      const add = await addAuthorWorktree(git, p, existing);
      return add.code === 0 ? (await rebuildCheckoutDrift(git, p)) ?? add : add;
    },
    ready: async (p, guard) => {
      const git = (args: string[]) => whileOwned(guard, () => env.git(["-C", p.repo, ...args]));
      const why = allowed() ?? await fresh(git, p.branch);
      return why ? manual(why) : null;
    },
  };
}
