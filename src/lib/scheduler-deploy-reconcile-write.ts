/** The scheduler's leased CLI owns every observation and deploy+stage write; the service's reader never writes. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { appendEvent, applyMove } from "./ledger-write.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { tx } from "./ledger-tx.js";
import { recordObserved, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readReconcileFacts, reconcileGitProof, DEPLOY_RECONCILE_MARK, type ReconcileFacts } from "./scheduler-deploy-reconcile-facts.js";
import type { runBounded } from "./run-bounded.js";

export interface ReconcileInput { taskId: string; taskRev: number; intentId: string; mergeRev: number; sourceSeq: number }
interface WriteDeps { repoDir: string; assertActive: () => void; policy?: RecoveryPolicyPort; command?: typeof runBounded; now?: () => number }

function fenced(db: Database, input: ReconcileInput, now: number): ReconcileFacts {
  const current = readReconcileFacts(db, input.taskId, now);
  if ("reason" in current) throw new LedgerError("conflict", current.reason);
  const { task, merge, source } = current.facts;
  if (task.rev !== input.taskRev || merge.intentId !== input.intentId || merge.rev !== input.mergeRev || source.seq !== input.sourceSeq) {
    throw new LedgerError("conflict", "task / merge / production deployment changed");
  }
  return current.facts;
}

export async function writeDeployReconcile(db: Database, ctx: WriteCtx, input: ReconcileInput, deps: WriteDeps): Promise<Record<string, unknown>> {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "部署补记只给持有效租约的调度服务");
  deps.assertActive();
  const task = getTask(db, input.taskId);
  if (!task) throw new LedgerError("not_found", "任务不存在");
  const policy = deps.policy ?? recoveryPolicy, mode = policy(task.project, "deployReconcile").mode;
  const clock = deps.now ?? (() => ctx.now ?? Date.now());
  if (mode === "off") throw new LedgerError("forbidden", "deployReconcile is off");
  const before = fenced(db, input, clock());
  const proof = await reconcileGitProof(deps.repoDir, before.merge.mergeSha!, String(before.source.data.version), deps.assertActive, deps.command);
  if ("reason" in proof) throw new LedgerError("conflict", proof.reason);
  return tx(db, () => {
    deps.assertActive();
    const now = clock(), { task, merge, source } = fenced(db, input, now);
    if (policy(task.project, "deployReconcile").mode !== mode) throw new LedgerError("conflict", "deployReconcile policy changed");
    if (merge.mergeSha !== before.merge.mergeSha || source.data.version !== before.source.data.version) throw new LedgerError("conflict", "部署证明已变");
    if (mode === "observe") {
      const result = recordObserved(db, { project: task.project, mechanism: "deployReconcile", target: task.id, actionKey: "reconcile",
        action: `补记 ${task.id} 部署 ${proof.version.slice(0, 12)} 并推 merge → live`,
        data: { sourceSeq: source.seq, mergeSha: merge.mergeSha, version: proof.version, intentId: merge.intentId } }, now);
      return { ok: true, mode, ...result, version: proof.version };
    }
    appendEvent(db, { ...ctx, now }, { project: task.project, target: task.id, kind: "deploy",
      data: { version: proof.version, rollbackPoint: null, reconciledBy: DEPLOY_RECONCILE_MARK } });
    applyMove(db, { ...ctx, now }, task, { from: "merge", to: "live" }, false, "", "pm");
    return { ok: true, mode, recorded: true, version: proof.version };
  });
}
