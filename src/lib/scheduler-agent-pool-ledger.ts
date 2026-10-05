import { quotaPoolTotals } from "./scheduler-agent-pool-quota.js";
/** Bindings, formally created authors and ticketed manual authors reserve project capacity; registry names alone cannot consume it. */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { zeroAgentCounts, type AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import { hasStepsTable, MANUAL_TICKET } from "./scheduler-manual-author.js";

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

export function localAgentPool(db: Database, project: string, totals: AgentLimits, exceptTask: string | null = null): AgentPoolLoad {
  totals = quotaPoolTotals(db, project, totals);
  const running = zeroAgentCounts();
  if (!hasTable(db, "scheduler_sessions")) return { totals, running };
  const rows = db.query(`SELECT DISTINCT s.agent, s.family FROM scheduler_sessions s JOIN tasks t ON t.id=s.taskId
    WHERE t.project=? AND t.id!=? AND s.transport!='peer' AND s.state!='retired'
    AND ((s.role='author' AND t.stage IN ('spec','restate','build','fix')) OR (s.role='reviewer' AND t.stage='review'))`)
    .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily }[];
  const agents = new Set<string>();
  for (const r of rows) {
    if (agents.has(r.agent)) continue;
    agents.add(r.agent); running[r.family]++;
  }
  // A submitted ensure has already begun creating. Reserve it until a binding or an explicit cancellation exists.
  if (hasTable(db, "scheduler_intents")) {
    const creating = db.query(`SELECT i.taskId, i.node, i.receipt, w.authorFamily FROM scheduler_intents i
      JOIN tasks t ON t.id=i.taskId JOIN task_workflows w ON w.taskId=t.id
      WHERE t.project=? AND t.id!=? AND i.action='ensure_session' AND i.status IN ('submitted','unknown')
      AND t.stage IN ('spec','restate','build','fix','review') AND NOT EXISTS
      (SELECT 1 FROM scheduler_sessions s WHERE s.createIntentId=i.id AND s.state!='retired')`)
      .all(project, exceptTask ?? "") as { taskId: string; node: string; receipt: string | null; authorFamily: AuthorFamily }[];
    for (const r of creating) {
      const family = r.receipt?.match(/ensure (?:author|reviewer) (claude|codex)/)?.[1] as AuthorFamily | undefined;
      const key = `creating:${r.taskId}:${r.node}`;
      if (!agents.has(key)) { agents.add(key); running[family ?? r.authorFamily]++; }
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
    for (const r of starts) if (!agents.has(r.agent)) { agents.add(r.agent); running[r.family]++; }
  }
  // An unbound manual author working the card holds one seat on its manager-written step ticket; other manual agents hold none.
  if (hasStepsTable(db) && hasTable(db, "task_workflows")) {
    const manual = db.query(`SELECT DISTINCT t.agent, w.authorFamily AS family FROM tasks t JOIN task_workflows w ON w.taskId=t.id
      WHERE t.project=? AND t.id!=? AND t.agent IS NOT NULL AND t.agent!='' AND (t.assigneeKind IS NULL OR t.assigneeKind='agent')
      AND t.stage IN ('spec','restate','build','fix') AND ${MANUAL_TICKET}
      AND NOT EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId=t.id AND s.role='author' AND s.state!='retired')`)
      .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily }[];
    for (const r of manual) if (!agents.has(r.agent)) { agents.add(r.agent); running[r.family]++; }
  }
  return { totals, running };
}
