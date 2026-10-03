/** Arbitration exhausts capable remote reviewers before the original local path, without rebinding ordinary review. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import { listEvents, LedgerError } from "./ledger-store.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { pendingDispute } from "./fix-strategy-plan.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { remoteContext, convergencePlacement } from "./fix-strategy-remote-context.js";
import { remoteOrder, offerConvergence } from "./fix-strategy-remote-order.js";
import { placeFor } from "./scheduler-family-pick.js";
import { orderWireOf } from "./order-wire.js";
import { convergenceEvent, createConvergenceWorker, type ConvergenceLifecycle } from "./fix-strategy-lifecycle.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { localReviewerCount } from "./scheduler-pool-facts.js";
import { chunkInputs } from "./order-wire-chunks.js";
import { sanitizeForeign } from "./order-wire-render.js";
import { readFile } from "node:fs/promises";

export async function remoteArbiterStep(db: Database, ctx: WriteCtx, intent: SchedulerIntent, maxWorkers: number, deps: ConvergenceLifecycle) {
  const existing = remoteOrder(db, intent.id);
  if (existing) {
    if (existing.status === "unknown") settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "unknown", receipt: "远端仲裁结果不明，交PM核对" });
    else if (["cancelled", "released"].includes(existing.status)) {
      settleIntent(db, ctx, { id: intent.id, from: "submitted", to: "cancelled", receipt: "远端仲裁单已退回/取消" });
    }
    return { ok: true, step: "waiting", detail: `远端仲裁单 ${existing.orderId}：${existing.status}` };
  }
  const task = mustTask(db, intent.taskId), events = listEvents(db, { project: task.project, target: task.id });
  const dispute = pendingDispute({ task, events });
  if (!dispute || dispute.seq !== Number(intent.id.split(":d").at(-1)) || dispute.data.specRev !== task.specRev) {
    throw new LedgerError("conflict", "仲裁不再是当前待裁争议");
  }
  const context = await remoteContext(db, task, deps); deps.active();
  const wrote = remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)!.authorFamily, family = wrote === "claude" ? "codex" : "claude";
  const author = getSchedulerSession(db, task.id, "author"), reviewer = getSchedulerSession(db, task.id, "reviewer");
  const original = events.find((e) => e.kind === "review" && e.data.reviewerSessionId === dispute.data.reviewerSessionId);
  const foreignSession = (original?.data.lend as { claim?: { session?: string } } | undefined)?.claim?.session;
  const authorClaim = events.findLast((e) => e.data.op === "lend_author_session" && e.data.head === task.headSHA)?.data.sessionId;
  const excluded = [author?.sessionId, reviewer?.sessionId, dispute.data.reviewerSessionId, foreignSession, authorClaim]
    .filter((s): s is string => typeof s === "string");
  const { facts } = convergencePlacement(db, task, context, family, "review", ctx.now ?? Date.now());
  if (facts.remote) facts.remote = { ...facts.remote, localPriority: "off" };
  const placed = placeFor(facts, "review", family);
  if (placed.kind === "peer" && context.spec) {
    let report: string;
    try { report = await (deps.readReport ?? context.lifecycle?.readReport ?? ((p) => readFile(p, "utf8")))(String(dispute.data.reportPath)); }
    catch (e) { return { ok: true, step: "waiting", detail: `仲裁原报告读不到：${(e as Error).message}` }; }
    deps.active();
    offerConvergence(db, ctx, intent, context, placed.peer, family, (current, orderId) => ({
      ...orderWireOf({ taskId: task.id, specRev: task.specRev, head: task.headSHA, round: task.round, step: "review", node: "arbitration", dedupKey: orderId,
        inputs: chunkInputs([["规格原文", context.spec!], ["原审查报告全文", report], ["执行者争议理由", dispute.text],
          ["被争议finding", JSON.stringify(dispute.data.findings)]]), outputs: ["upheld（成立）或 overturned（关闭）", "非空仲裁报告"],
        acceptance: ["只裁单上这一条 finding；独立新会话、只读，不提交、不推送"], writeBack: "lend submit <单号> --verdict upheld|overturned --report report.md" },
      { repo: facts.repo, pr: Number(current.pr?.match(/\/pull\/(\d+)/)?.[1]) || null }),
      convergence: { kind: "arbitration", intentId: intent.id, disputeSeq: dispute.seq,
        findingId: String(dispute.data.findingId), excludedSessions: excluded.map(sanitizeForeign) },
    }));
    return { ok: true, step: "pooled", detail: `独立${family}仲裁单挂给 ${placed.peer}` };
  }
  const source = deps.registry().find((r) => r.name === (author?.agent ?? task.agent))?.cwd;
  if (source || !context.source || localReviewerCount(db, task.project, task.id) >= maxWorkers) return null;
  if (intent.status === "pending") settleIntent(db, ctx, { id: intent.id, from: "pending", to: "submitted", receipt: "claimed; peer作者的本机仲裁" });
  const ref = await createConvergenceWorker(db, ctx, intent, task, family, context.source, "reviewer", deps); deps.active();
  if ("wait" in ref) return { ok: true, step: "waiting", detail: ref.wait };
  if (excluded.includes(ref.sessionId)) throw new LedgerError("conflict", "仲裁不可复用作者/审查会话");
  convergenceEvent(db, ctx, intent, "arbiter", { ref, disputeSeq: dispute.seq });
  return { ok: true, step: "ready", ref };
}
