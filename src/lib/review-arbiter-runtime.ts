import { pendingDispute } from "./fix-strategy-plan.js";
/** Local arbitration uses a separate, fresh cross-family context and leaves the ordinary review binding intact. */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { getEventByDedup, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { gitDirtySync, gitHeadSync } from "./scheduler-review-worktree.js";
import { localReviewerCount } from "./scheduler-pool-facts.js";
import { readRegistryAgentsSync } from "./registry.js";
import type { SessionRef, WorkOrder } from "./worker-session.js";
import { statePath } from "./paths.js";
import { SRC_DIR } from "./repo-root.js";
import { DISPUTE_RULE, FIX_STRATEGY_RULE } from "./fix-strategy.js";
import { convergenceIntent } from "./fix-strategy-runtime.js";
import { convergenceEvent, convergenceLifecycle, createConvergenceWorker, stopConvergenceAuthor, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import type { ArbitrationVerdict } from "./review-arbiter.js";
import { remoteArbiterStep } from "./review-arbiter-remote.js";

export function arbiterBinding(db: Database, id: string): SessionRef | null {
  const value = getEventByDedup(db, `scheduler:${id}:arbiter`)?.data.ref;
  return value && typeof value === "object" ? value as SessionRef : null;
}

export async function arbiterStep(db: Database, ctx: WriteCtx, id: string, maxWorkers: number,
  deps: ConvergenceLifecycle = convergenceLifecycle()) {
  deps.active();
  const intent = convergenceIntent(db, ctx, id, "arbitrate"), task = mustTask(db, intent.taskId);
  const existing = arbiterBinding(db, id);
  if (getEventByDedup(db, `scheduler:${id}:verdict`)) {
    const wait = await stopConvergenceAuthor(db, ctx, intent, existing, deps);
    if (wait) return { ok: true, step: "waiting", detail: wait };
    if (intent.status !== "done") settleIntent(db, ctx, { id, from: "submitted", to: "done", receipt: "仲裁结论已记，新仲裁会话已归档停止" });
    return { ok: true, step: "arbitrated", detail: "仲裁结论已记，仲裁会话已退役" };
  }
  if (existing) {
    const blocked = deps.localFamilyWait?.(task, existing.family);
    return blocked ? { ok: true, step: "waiting", detail: blocked } : { ok: true, step: "ready", ref: existing };
  }
  if (task.stage !== "review" || task.rev !== intent.taskRev) throw new LedgerError("conflict", "仲裁计划已过期");
  const remote = await remoteArbiterStep(db, ctx, intent, maxWorkers, deps); if (remote) return remote;
  if (localReviewerCount(db, task.project, task.id) >= maxWorkers) return { ok: true, step: "waiting", detail: "本机仲裁审查槽已满，等空位" };
  const disputeSeq = Number(id.split(":d").at(-1));
  const dispute = pendingDispute({ task, events: listEvents(db, { project: task.project, target: task.id }) });
  if (dispute?.seq !== disputeSeq) throw new LedgerError("conflict", "仲裁不再是当前待裁争议");
  if (!dispute || dispute.data.specRev !== task.specRev) throw new LedgerError("conflict", "仲裁缺同规格的争议事件");
  const author = getSchedulerSession(db, task.id, "author"), reviewer = getSchedulerSession(db, task.id, "reviewer");
  const wrote = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily;
  const source = deps.registry().find((r) => r.name === (author?.agent ?? task.agent))?.cwd;
  if (!source) return { ok: true, step: "waiting", detail: "缺作者 checkout，不能准备独立仲裁目录" };
  if (intent.status === "pending") settleIntent(db, ctx, { id, from: "pending", to: "submitted", receipt: "claimed; 独立仲裁新会话" });
  const ref = await createConvergenceWorker(db, ctx, intent, task, wrote === "claude" ? "codex" : "claude", source, "reviewer", deps);
  deps.active();
  if ("wait" in ref) return { ok: true, step: "waiting", detail: ref.wait };
  if (ref.sessionId === dispute.data.reviewerSessionId || ref.sessionId === reviewer?.sessionId || ref.sessionId === author?.sessionId || ref.agent === task.agent) {
    throw new LedgerError("conflict", "仲裁必须是不同于原审查员和作者的新会话");
  }
  convergenceEvent(db, ctx, intent, "arbiter", { ref, disputeSeq });
  return { ok: true, step: "ready", ref };
}

export function arbiterOrder(db: Database, id: string): WorkOrder {
  const intent = convergenceIntent(db, { actor: "scheduler" }, id, "arbitrate"), task = mustTask(db, intent.taskId);
  const disputeSeq = getEventByDedup(db, `scheduler:${id}:arbiter`)?.data.disputeSeq;
  const dispute = listEvents(db, { project: task.project, target: task.id }).find((e) => e.seq === disputeSeq)!;
  return { taskId: task.id, specRev: task.specRev, head: intent.head, round: task.round, node: "arbitration", step: "review", dedupKey: id,
    inputs: [`规格：bun ${SRC_DIR}/manager.ts ledger show ${task.id}`, `只裁 finding ${dispute.data.findingId}；相关 diff：git diff ${dispute.data.head} ${intent.head}`,
      `原报告全文：${dispute.data.reportPath}`, `执行者理由：${dispute.text}`, `原 finding：${JSON.stringify(dispute.data.findings)}`, DISPUTE_RULE, FIX_STRATEGY_RULE],
    outputs: ["只裁这一条：upheld（成立）或 overturned（关闭）", "非空仲裁报告路径"], acceptance: ["只读代码；不得修改 checkout", "仲裁结论有约束力"],
    writeBack: `bun ${SRC_DIR}/manager.ts ledger scheduler-arbiter-verdict ${id} --verdict upheld|overturned` +
      ` --head ${intent.head} --report ${statePath("ledger", "reviews", `${task.id}-arb-${intent.eventSeq}.md`)}`,
    delivery: { mode: "text", reason: "独立仲裁单使用专用结论回写，全文包含单号与理由" } };
}

export function recordArbitration(db: Database, ctx: WriteCtx, id: string, verdict: string, head: string, report: string,
  caller: { session?: string; registryPath?: string; gitHead?: typeof gitHeadSync; gitDirty?: typeof gitDirtySync; reportText: string }): void {
  tx(db, () => {
    const intent = convergenceIntent(db, { actor: "scheduler" }, id, "arbitrate"), task = mustTask(db, intent.taskId), ref = arbiterBinding(db, id);
    if (!ref || ctx.actor !== ref.agent || caller.session !== ref.sessionId) throw new LedgerError("forbidden", "只有绑定的新仲裁会话能写结论");
    if (intent.status !== "submitted" || task.stage !== "review" || intent.head !== head || task.rev !== intent.taskRev) {
      throw new LedgerError("conflict", "仲裁单已经过期或没有派出");
    }
    const wrote = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily;
    const row = readRegistryAgentsSync(caller.registryPath).find((r) => r.name === ref.agent);
    if (!row?.cwd || row.sessionId !== ref.sessionId || (row.runtime === "codex" ? "codex" : "claude") !== ref.family || ref.family === wrote ||
      (caller.gitHead ?? gitHeadSync)(row.cwd) !== head || (caller.gitDirty ?? gitDirtySync)(row.cwd)) throw new LedgerError("conflict", "仲裁目录/session/模型家族不符");
    if ((verdict !== "upheld" && verdict !== "overturned") || !caller.reportText.trim()) throw new LedgerError("invalid", "仲裁要有 upheld/overturned 与非空报告");
    const disputeSeq = getEventByDedup(db, `scheduler:${id}:arbiter`)!.data.disputeSeq;
    const dispute = listEvents(db, { project: task.project, target: task.id }).find((e) => e.seq === disputeSeq)!;
    const prior = getEventByDedup(db, `scheduler:${id}:verdict`);
    if (prior) {
      if (prior.data.verdict !== verdict || prior.data.report !== report) throw new LedgerError("dedup_mismatch", "仲裁已有不同结论");
      return;
    }
    insertEvent(db, { actor: "scheduler", now: ctx.now, dedupKey: `scheduler:${id}:verdict` }, { project: task.project, target: task.id,
      kind: "scheduler", text: `仲裁 ${dispute.data.findingId}：${verdict}`, data: { op: "arbitration_result", intentId: id,
        specRev: task.specRev, round: task.round, disputeSeq, findingId: dispute.data.findingId, family: dispute.data.family,
        verdict: verdict as ArbitrationVerdict, report, reviewer: ref.agent, reviewerSessionId: ref.sessionId, reviewerFamily: ref.family } }, true);
  });
}
