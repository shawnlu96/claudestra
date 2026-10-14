/** The session writer's existing transaction replaces only this mechanism's formally retired peer author. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { listEvents } from "./ledger-store.js";
import type { LedgerTask } from "./ledger-stages.js";
import { retiredLendAuthor } from "./lend-author-retire-state.js";
import type { BindSessionInput, SchedulerSession } from "./scheduler-sessions.js";

export function lendAuthorBindPrior(db: Database, ctx: WriteCtx, task: LedgerTask, input: BindSessionInput,
  prior: SchedulerSession | null, mayRecover: () => boolean, commit: (prior: SchedulerSession) => void): SchedulerSession | null {
  if (!prior || input.role !== "author" || input.transport === "peer" || task.stage !== "fix" || ctx.actor !== "scheduler"
    || prior.state !== "retired" || prior.transport !== "peer" || task.agent !== input.agent || !retiredLendAuthor(db, task)
    || getWorkflow(db, task.id)?.authorFamily !== input.family || !mayRecover()) return prior;
  const local = listEvents(db, { target: task.id }).findLast(e => e.data.op === "local_author" && e.data.intentId === input.intentId);
  if (!local || local.data.agent !== input.agent || local.data.family !== input.family || local.data.rev !== task.rev) return prior;
  const intent = getIntent(db, input.intentId), retire = listEvents(db, { target: task.id }).findLast(e => e.data.op === "lend_author_retire");
  if (!intent || !retire || intent.action !== "ensure_session" || intent.node !== "fix" || intent.status !== "submitted"
    || intent.specRev !== task.specRev || intent.head !== task.headSHA || intent.eventSeq <= retire.seq) return prior;
  commit(prior);
  return null;
}
