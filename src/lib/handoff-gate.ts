/**
 * Handoff gates (HDG-1, docs/architecture/dag-tools.md「交接闸」): two machine-readable reasons a reviewed card in `merge` is not
 * handed over (or locally merged) yet. (1) The project's handoff hold, set by PM / owner: build / fix / review keep going, only the
 * step out of `merge` waits — unlike `ledger freeze`, which stops new work too. (2) A card bound to a feature DAG node waits until
 * every node of the DAG's current version is reviewed at its head in `merge`, already handed, or finished; then the batch goes out
 * in dependency order. A handoff already recorded is never taken back. tests/handoff-gate*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask, Stage } from "./ledger-stages.js";
import { handedInStay, type FeatureGate, type GateNode, type HandoffGateFacts } from "./handoff-gate-plan.js";
import { getMeta, getTask, LedgerError, listEvents, putHandoffHold, type HandoffHold, type LedgerMeta } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { isManager, type WriteCtx } from "./ledger-checks.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { mergeReviewProof } from "./scheduler-merge.js";

const DONE: readonly Stage[] = ["live", "verified", "done", "cancelled"];

/** Reviewed at the card's current head with no P0 / P1: an auto card by the same proof its own merge needs, a manual one by the verdict. */
function reviewed(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): boolean {
  const workflow = getWorkflow(db, task.id);
  if (workflow?.mode === "auto" && workflow.specRev === task.specRev) {
    try { mergeReviewProof(db, task, workflow); return true; } catch (e) {
      if (e instanceof LedgerError) return false; // no proof is the answer here: the sibling is simply not ready
      throw e;
    }
  }
  const r = currentReviewFacts(task, events);
  return r.kind === "facts" && r.facts.head === task.headSHA && ["pass", "changes"].includes(r.facts.verdict) &&
    !r.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1");
}

function nodeOf(db: Database, n: { key: string; taskId: string | null; deps: string[] }): GateNode {
  const base = { key: n.key, taskId: n.taskId, deps: n.deps };
  if (!n.taskId) return { ...base, state: "pending", stage: "planned", head: null, round: null };
  const t = getTask(db, n.taskId);
  if (!t) return { ...base, state: "pending", stage: "missing", head: null, round: null };
  const at = { ...base, stage: t.stage, head: t.headSHA, round: t.round };
  if (DONE.includes(t.stage)) return { ...at, state: "done" };
  if (t.stage !== "merge") return { ...at, state: "pending" };
  const events = listEvents(db, { project: t.project, target: t.id });
  return { ...at, state: handedInStay(events) ? "handed" : reviewed(db, t, events) ? "ready" : "pending" };
}

/** null = the card is in no feature DAG's current version, or that DAG has a single node: nothing to wait for. */
export function featureGate(db: Database, task: LedgerTask): FeatureGate | null {
  const f = task.featureId ? getFeature(db, task.featureId) : null;
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!f || !v) return null;
  const nodes = effectiveNodes(db, v);
  const self = nodes.find((n) => n.taskId === task.id);
  if (!self || nodes.length < 2) return null;
  return { featureId: f.id, version: v.version, self: self.key, nodes: nodes.map((n) => nodeOf(db, n)) };
}

export function handoffGateFacts(db: Database, task: LedgerTask): HandoffGateFacts {
  const hold = getMeta(db, task.project).handoffHold;
  return { hold: hold.on ? hold : null, feature: featureGate(db, task) };
}

/** `ledger handoff-hold <project> on|off`: PM / master / owner only; the reason and who / when stay in the project meta. */
export function setHandoffHold(db: Database, ctx: WriteCtx, input: { project: string; on: boolean; reason: string }): { meta: LedgerMeta; event: LedgerEvent } {
  return tx(db, () => {
    if (!isManager(db, ctx.actor, { agent: null, project: input.project })) throw new LedgerError("forbidden", `暂停交接要项目 ${input.project} 的 PM / master / owner（你是 ${ctx.actor}）`);
    if (input.on && !input.reason.trim()) throw new LedgerError("invalid", "打开暂停交接要写 --reason");
    if (getMeta(db, input.project).handoffHold.on === input.on) {
      throw new LedgerError("conflict", `项目 ${input.project} 的暂停交接已经是${input.on ? "开" : "关"}着的`);
    }
    const now = ctx.now ?? Date.now();
    const hold: HandoffHold = { on: input.on, reason: input.reason, by: ctx.actor, since: now };
    putHandoffHold(db, input.project, hold);
    const event = insertEvent(db, ctx, { project: input.project, target: "", kind: "meta", text: input.reason,
      data: { op: "set", patch: { handoffHold: hold } } }, true);
    return { meta: getMeta(db, input.project), event };
  });
}
