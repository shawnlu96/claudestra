/**
 * AREB1: the card's author is not in the registry. Only an author LIFE1 formally retired (scheduler-author-rebuild-proof.ts)
 * is rebuilt, through the same new-author path as an unassigned card (ensureLocalAuthor, same slots / quota / queue), under
 * the recovery key authorRebuild: off = the old manual; observe = the old manual plus one observe event; on = rebuild.
 * Before building: swap is not above LIFE1's retire line (else wait, one note per card + reason), the PR head (origin/<branch>
 * after fetch) is the card's headSHA, and a peer write lease keeps the card the peer's. The new name, the family, the leftover
 * branch and the writer's re-check are the shared predicates of scheduler-author-rebuild-proof.ts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { heldLease } from "./ledger-lend-lease.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { rebuildHooks, rebuildPrHead, rebuildPressure } from "./scheduler-author-rebuild-checkout.js";
import { authorRetireProof, rebuildAgentName } from "./scheduler-author-rebuild-proof.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "./scheduler-local-author.js";
import { localAuthorPlan } from "./scheduler-local-author-plan.js";
import type { LocalStartOptions } from "./scheduler-local-runtime-start.js";
import type { EnsureResult } from "./worker-session.js";

export interface AuthorRebuildDeps {
  policy?: RecoveryPolicyPort;
  /** system swap use in percent; null = unreadable (never rebuilds) */
  swapPct?: () => Promise<number | null>;
  readConfig?: () => SchedulerConfig;
  now?: () => number;
  start?: LocalStartOptions;
}

const manual = (reason: string): EnsureResult => ({ kind: "manual", reason });

/** Called only when task.agent is set and absent from the registry; `gone` is the unchanged manual reason. */
export async function rebuildRetiredAuthor(env: LocalAuthorEnv, task: LedgerTask, family: AuthorFamily, gone: string,
  deps: AuthorRebuildDeps = {}): Promise<EnsureResult> {
  const old = task.agent;
  if (!old) return manual(gone);
  const decision = decideRecovery((deps.policy ?? recoveryPolicy)(task.project, "authorRebuild"));
  if (decision.kind === "skip") return manual(gone);
  if (String(task.extra.placement ?? "").startsWith("peer:") || heldLease(env.db, task)) return manual(gone); // the peer's author, not ours
  const proof = authorRetireProof(env.db, task);
  if (proof.kind !== "retired") return manual(gone);
  const now = (deps.now ?? Date.now)();
  if (decision.kind === "observe") {
    recordObserved(env.db, { project: task.project, mechanism: "authorRebuild", target: task.id, actionKey: `rebuild:${proof.retireSeq}`,
      action: `为卡 ${task.id} 重建作者（${old} 已被生命周期正式收回，收回事件 #${proof.retireSeq}）`, data: { agent: old, retireSeq: proof.retireSeq } }, now);
    return manual(gone);
  }
  const plan = await localAuthorPlan(env.db, task, env.worktreeRoot, deps.start ?? {}); // repo and branch only: the name is ensureLocalAuthor's
  if (typeof plan === "string") return manual(`${gone}；重建作者：${plan}`);
  const wait = await rebuildPressure(env, task, deps); // read again at the add and right before create (scheduler-author-rebuild-checkout.ts)
  if (wait) return wait;
  if (!task.headSHA) return manual(`${gone}；重建作者：卡上没有 head`);
  const git = (args: string[]) => env.git(["-C", plan.repo, ...args]);
  const fetch = await git(["fetch", "-q", "origin"]);
  if (fetch.code !== 0) return manual(`${gone}；重建作者：fetch 失败：${fetch.out}`.slice(0, 400));
  const head = await rebuildPrHead(git, plan.branch, task.headSHA);
  if (head) return manual(`${gone}；重建作者：${head}`);
  const name = rebuildAgentName(task.id, old);
  if (!name) return manual(`${gone}；重建作者：${old} 之后形成不了合法的新作者名`);
  return ensureLocalAuthor(env, task, deps.start ?? {}, rebuildHooks(env, task, deps, { replaces: old, family, name, gone }));
}
