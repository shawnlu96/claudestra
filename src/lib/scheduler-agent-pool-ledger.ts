import { quotaPoolTotals } from "./scheduler-agent-pool-quota.js";
/** Bindings, formally created authors and ticketed manual authors reserve project capacity; registry names alone cannot consume it. */
import type { Database } from "bun:sqlite";
import { AUTOSTART_DEDUP_PREFIX, DAG_START_DEDUP_PREFIX, dedupRangeEnd } from "./ledger-autostart-grant.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import { zeroAgentCounts, type AgentPoolLoad } from "./scheduler-agent-pool.js";
import type { AgentLimits } from "./scheduler-agent-pool-config.js";
import { hasStepsTable, MANUAL_TICKET } from "./scheduler-manual-author.js";

const hasTable = (db: Database, name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** One working local seat: a distinct agent (or begun creation); `reviewer` when any of its working rows is a review. */
export interface WorkingSeat { family: AuthorFamily; reviewer: boolean }

/**
 * workingSeats 的 starts 读（调度快照每张卡都跑）：autostart claim 和 start_node 的 task-set 都按 dedupKey 前缀圈区间，走 events 的
 * dedupKey 唯一索引；`+e.project` 让规划器别选 events_project_target（几乎全表都是同一个项目，等于整表扫）。原条件一个不删，结果不变。
 * 行序也不变：旧计划按 events_project_target 的 (target, seq) 走 e、DISTINCT 留首次出现，这里按每组最早的 (target, seq) 排
 * （char(1) 小于 id 里的任何字符，拼接序 = 二元组序）；同一 agent 两个家族时首行定家族，seats 的插入序也随之一致。
 */
export const STARTS_SQL = `SELECT t.agent, w.authorFamily AS family FROM events e JOIN tasks t
      ON t.id=CASE WHEN json_extract(e.data,'$.op')='autostart_claim' THEN json_extract(e.data,'$.taskId') ELSE e.target END
      JOIN task_workflows w ON w.taskId=t.id WHERE +e.project=? AND t.id!=?
      AND ((e.dedupKey >= '${AUTOSTART_DEDUP_PREFIX}' AND e.dedupKey < '${dedupRangeEnd(AUTOSTART_DEDUP_PREFIX)}')
        OR (e.dedupKey >= '${DAG_START_DEDUP_PREFIX}' AND e.dedupKey < '${dedupRangeEnd(DAG_START_DEDUP_PREFIX)}'))
      AND ((json_extract(e.data,'$.op')='autostart_claim' AND json_extract(e.data,'$.peer') IS NULL)
        OR (w.mode='auto' AND e.kind='task' AND json_extract(e.data,'$.op')='set' AND e.dedupKey LIKE 'dag-start:%:task-set'))
      AND t.stage IN ('spec','restate','build','fix') AND t.agent IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId=t.id AND s.role='author')
      AND NOT EXISTS (SELECT 1 FROM scheduler_intents i WHERE i.taskId=t.id AND i.action='ensure_session'
        AND i.node IN ('restate','write','fix') AND i.status IN ('submitted','unknown'))
      GROUP BY t.agent, w.authorFamily ORDER BY MIN(e.target || char(1) || printf('%020d', e.seq))`;

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
    const creating = db.query(`SELECT i.taskId, i.node, i.receipt, t.agent, w.authorFamily FROM scheduler_intents i
      JOIN tasks t ON t.id=i.taskId JOIN task_workflows w ON w.taskId=t.id
      WHERE t.project=? AND t.id!=? AND i.action='ensure_session' AND i.status IN ('submitted','unknown')
      AND (t.stage IN ('spec','restate','build','fix','review') OR i.node='adversarial_review') AND NOT EXISTS
      (SELECT 1 FROM scheduler_sessions s WHERE s.createIntentId=i.id AND s.state!='retired')`)
      .all(project, exceptTask ?? "") as { taskId: string; node: string; receipt: string | null; agent: string | null; authorFamily: AuthorFamily }[];
    for (const r of creating) {
      const family = r.receipt?.match(/ensure (?:author|reviewer) (claude|codex)/)?.[1] as AuthorFamily | undefined;
      // A named author and its ensure reservation are the same seat, including a retained unknown result.
      const key = ["restate", "write", "fix"].includes(r.node) && r.agent ? r.agent : `creating:${r.taskId}:${r.node}`;
      if (!seats.has(key)) seat(key, family ?? r.authorFamily, r.node === "adversarial_review");
    }
  }
  // start_node's task-set is written only after create succeeds; autostart has its own durable claim.
  if (hasTable(db, "events")) {
    const starts = db.query(STARTS_SQL)
      .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily }[];
    for (const r of starts) if (!seats.has(r.agent)) seat(r.agent, r.family, false);
  }
  // An unbound manual author working the card holds one seat on its manager-written step ticket; other manual agents hold none.
  if (hasStepsTable(db) && hasTable(db, "task_workflows")) {
    const manual = db.query(`SELECT DISTINCT t.agent, w.authorFamily AS family FROM tasks t JOIN task_workflows w ON w.taskId=t.id
      WHERE t.project=? AND t.id!=? AND t.agent IS NOT NULL AND t.agent!='' AND (t.assigneeKind IS NULL OR t.assigneeKind='agent')
      AND t.stage IN ('spec','restate','build','fix') AND ${MANUAL_TICKET}
      AND NOT EXISTS (SELECT 1 FROM scheduler_sessions s WHERE s.taskId=t.id AND s.role='author' AND s.state!='retired')`)
      .all(project, exceptTask ?? "") as { agent: string; family: AuthorFamily }[];
    for (const r of manual) if (!seats.has(r.agent)) seat(r.agent, r.family, false);
  }
  return seats;
}

export function localAgentPool(db: Database, project: string, totals: AgentLimits, exceptTask: string | null = null): AgentPoolLoad {
  totals = quotaPoolTotals(db, project, totals);
  const running = zeroAgentCounts();
  for (const s of workingSeats(db, project, exceptTask)?.values() ?? []) running[s.family]++;
  return { totals, running };
}
