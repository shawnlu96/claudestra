import { quotaPoolTotals } from "./scheduler-agent-pool-quota.js";
/** Bindings and formally created authors reserve project capacity; registry names alone cannot consume it. */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { zeroAgentCounts, type AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** One working local seat: a distinct agent (or begun creation); `reviewer` when any of its working rows is a review. */
export interface WorkingSeat { family: AuthorFamily; reviewer: boolean }

/**
 * The canonical working-stage read (LS2, RVCAP1) behind both the AgentPool and the local reviewer count: authors in
 * spec/restate/build/fix, reviewers in review or with an unsettled review effect, and begun creations. A reviewer's begun
 * creation stays reserved whatever the card's stage. null = the ledger has no session table (no authority to read).
 */
export function workingSeats(db: Database, project: string, exceptTask: string | null = null): Map<string, WorkingSeat> | null {
  if (!hasTable(db, "scheduler_sessions")) return null;
  const intents = hasTable(db, "scheduler_intents"), seats = new Map<string, WorkingSeat>();
  const seat = (key: string, family: AuthorFamily, reviewer: boolean): void => {
    const had = seats.get(key);
    seats.set(key, { family: had?.family ?? family, reviewer: reviewer || !!had?.reviewer });
  };
  // An unsettled review effect: a review order in flight / of unknown outcome, or delivered (done = receipt, not a verdict) to
  // this reviewer without its same-head verdict from this session after it (ledgerResult's proof). Leaving review cancels nothing.
  const unsettledReview = intents ? ` OR EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action='review'
    AND (i.status IN ('submitted','unknown') OR (i.status='done' AND i.recipient=s.agent AND NOT EXISTS (SELECT 1 FROM events e
      WHERE e.project=t.project AND e.target=t.id AND e.kind='review' AND e.seq>i.eventSeq
      AND json_extract(e.data,'$.head') IS i.head AND json_extract(e.data,'$.reviewerSessionId')=s.sessionId))))` : "";
  const rows = db.query(`SELECT DISTINCT s.agent, s.family, s.role FROM scheduler_sessions s JOIN tasks t ON t.id=s.taskId
    WHERE t.project=? AND t.id!=? AND s.transport!='peer' AND s.state!='retired'
    AND ((s.role='author' AND t.stage IN ('spec','restate','build','fix')) OR (s.role='reviewer' AND (t.stage='review'${unsettledReview})))`)
    .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily; role: string }[];
  for (const r of rows) seat(r.agent, r.family, r.role === "reviewer");
  // A submitted ensure has already begun creating. Reserve it until a binding or an explicit cancellation exists.
  if (intents) {
    const creating = db.query(`SELECT i.taskId, i.node, i.receipt, w.authorFamily FROM scheduler_intents i
      JOIN tasks t ON t.id=i.taskId JOIN task_workflows w ON w.taskId=t.id
      WHERE t.project=? AND t.id!=? AND i.action='ensure_session' AND i.status IN ('submitted','unknown')
      AND (t.stage IN ('spec','restate','build','fix','review') OR i.node='adversarial_review') AND NOT EXISTS
      (SELECT 1 FROM scheduler_sessions s WHERE s.createIntentId=i.id AND s.state!='retired')`)
      .all(project, exceptTask ?? "") as { taskId: string; node: string; receipt: string | null; authorFamily: AuthorFamily }[];
    for (const r of creating) {
      const family = r.receipt?.match(/ensure (?:author|reviewer) (claude|codex)/)?.[1] as AuthorFamily | undefined;
      const key = `creating:${r.taskId}:${r.node}`;
      if (!seats.has(key)) seat(key, family ?? r.authorFamily, r.node === "adversarial_review");
    }
  }
  // start_node's task-set is written only after create succeeds; autostart has its own durable claim.
  if (hasTable(db, "events")) {
    const starts = db.query(`SELECT DISTINCT t.agent, w.authorFamily AS family FROM events e JOIN tasks t
      ON t.id=CASE WHEN json_extract(e.data,'$.op')='autostart_claim' THEN json_extract(e.data,'$.taskId') ELSE e.target END
      JOIN task_workflows w ON w.taskId=t.id WHERE e.project=? AND t.id!=?
      AND ((json_extract(e.data,'$.op')='autostart_claim' AND json_extract(e.data,'$.peer') IS NULL)
        OR (w.mode='auto' AND e.kind='task' AND json_extract(e.data,'$.op')='set' AND e.dedupKey LIKE 'dag-start:%:task-set'))
      AND t.stage IN ('spec','restate','build','fix') AND t.agent IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId=t.id AND s.role='author')
      AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action='ensure_session'
        AND i.node IN ('restate','write','fix') AND i.status IN ('submitted','unknown'))`)
      .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily }[];
    for (const r of starts) if (!seats.has(r.agent)) seat(r.agent, r.family, false);
  }
  return seats;
}

export function localAgentPool(db: Database, project: string, totals: AgentLimits, exceptTask: string | null = null): AgentPoolLoad {
  totals = quotaPoolTotals(db, project, totals);
  const running = zeroAgentCounts();
  for (const s of workingSeats(db, project, exceptTask)?.values() ?? []) running[s.family]++;
  return { totals, running };
}
