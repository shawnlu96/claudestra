/**
 * Observe mode: compute the plan for an observe card and record it as a ledger event — no intent, no resource claim,
 * no message, no stage move. A new record is written only when the decision differs from the card's previous record,
 * and the dedup key chains on that record, so repeated ticks, duplicate notifications and restarts write nothing new.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getMeta, LedgerError, toEvent } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { planScheduler, type PlannerDecision } from "./scheduler-plan.js";
import { observeSnapshot, type SnapshotOpts } from "./scheduler-snapshot.js";
import { selectWorkerRoute, type WorkerRoute } from "./worker-session.js";

export interface ObservedDecision {
  kind: PlannerDecision["kind"];
  code?: string;
  id?: string;
  node?: string;
  action?: string;
  recipient?: string | null;
  targetStage?: string;
  sessionRole?: string;
  reason: string;
}

function compact(d: PlannerDecision): ObservedDecision {
  if (d.kind !== "intent") return { kind: d.kind, code: d.code, reason: d.reason };
  return { kind: "intent", id: d.id, node: d.node, action: d.action, recipient: d.recipient, reason: d.reason,
    ...(d.targetStage ? { targetStage: d.targetStage } : {}), ...(d.sessionRole ? { sessionRole: d.sessionRole } : {}) };
}

/** The route the engine would use for this recipient; a peer or an unaddressable executor shows up as manual. */
function routeFor(d: PlannerDecision, opts: SnapshotOpts, peerExecutor: string | null): WorkerRoute | null {
  if (d.kind !== "intent" || !["dispatch", "review", "ensure_session"].includes(d.action)) return null;
  if (peerExecutor && d.action !== "review") return selectWorkerRoute({ agent: peerExecutor, peer: peerExecutor.split("@").pop() });
  if (!d.recipient) return null;
  const reg = opts.registry.find((a) => a.name === d.recipient);
  if (!reg) return { kind: "manual", reason: `${d.recipient} 不在本机 registry` };
  return selectWorkerRoute({ agent: reg.name, runtime: reg.runtime, transport: reg.transport, acpPending: reg.acpPending });
}

function latestObservation(db: Database, taskId: string): LedgerEvent | null {
  const row = db.query(`SELECT * FROM events WHERE target = ? AND kind = 'scheduler' AND json_extract(data, '$.op') = 'observe'
    ORDER BY seq DESC LIMIT 1`).get(taskId);
  return row ? toEvent(row as Parameters<typeof toEvent>[0]) : null;
}

export interface ObserveResult { observation: LedgerEvent; duplicate: boolean; decision: ObservedDecision }

export function observeTask(db: Database, ctx: WriteCtx, taskId: string, opts: SnapshotOpts): ObserveResult {
  return tx(db, () => {
    const task = mustTask(db, taskId);
    const meta = getMeta(db, task.project);
    if (ctx.actor !== "scheduler" && (ctx.actor === meta.team?.dispatcher || !isManager(db, ctx.actor, { project: task.project, agent: null }))) {
      throw new LedgerError("forbidden", "只有调度服务或项目 PM / master / owner 能写观察记录");
    }
    const workflow = getWorkflow(db, task.id);
    if (workflow?.mode !== "observe") throw new LedgerError("conflict", "任务不在 observe 模式");
    const snapshot = observeSnapshot(db, task, opts);
    const plan = planScheduler(snapshot);
    const decision = compact(plan);
    const peerStep = snapshot.author ? null : (task.assigneeKind === "peer_agent" ? task.assignee : null);
    const route = routeFor(plan, opts, peerStep);
    const stageSeq = snapshot.events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? 0;
    const sigBody = JSON.stringify({ decision: { ...decision, reason: undefined }, route, stage: task.stage, stageSeq,
      round: task.round, head: task.headSHA, specRev: task.specRev });
    const sig = createHash("sha256").update(sigBody).digest("hex").slice(0, 24);
    const previous = latestObservation(db, task.id);
    if (previous && previous.data.sig === sig) return { observation: previous, duplicate: true, decision };
    const asOfSeq = (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE target = ?").get(task.id) as { seq: number }).seq;
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: `scheduler:observe:${task.id}:p${previous?.seq ?? 0}:${sig}` }, {
      project: task.project, target: task.id, kind: "scheduler", text: `观察：${decision.reason}`.slice(0, 600),
      data: { op: "observe", sig, decision, route, stage: task.stage, stageSeq, round: task.round, head: task.headSHA,
        specRev: task.specRev, asOfSeq, template: workflow.template, version: workflow.templateVersion,
        ...(ctx.actor === "scheduler" ? {} : { manual: true }) },
    }, true);
    return { observation: event, duplicate: false, decision };
  });
}
