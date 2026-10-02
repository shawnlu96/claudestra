/** Read one ledger snapshot; idle registry sessions cannot reserve working capacity. */
import { Database } from "bun:sqlite";
import { LEDGER_PATH, toTask } from "./ledger-store.js";
import { stepsByTask, stepAtStage } from "./ledger-steps.js";

export function workingCodexAgents(path = LEDGER_PATH): Set<string> {
  const db = new Database(path, { readonly: true });
  try {
    return db.transaction(() => {
      for (const table of ["tasks", "task_steps", "scheduler_sessions"]) {
        if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw new Error(`missing ledger table ${table}`);
      }
      const agents = new Set<string>(), steps = stepsByTask(db);
      const tasks = db.query("SELECT * FROM tasks WHERE stage IN ('spec','restate','build','fix','review')").all();
      for (const row of tasks) {
        const task = toTask(row as Record<string, unknown>);
        const step = stepAtStage(steps.get(task.id) ?? [], task);
        if (step && (task.stage !== "review" || step.round === task.round)) {
          if (step.executorKind === "agent") agents.add(step.executor);
          continue;
        }
        if (task.stage !== "review") {
          if (task.agent) agents.add(task.agent);
          continue;
        }
        // Review sessions survive fix rounds; only this round’s dispatched work makes the binding busy.
        const session = db.query(`SELECT agent FROM scheduler_sessions WHERE taskId = ? AND role = 'reviewer'
          AND state = 'active' AND transport != 'peer' AND EXISTS (
            SELECT 1 FROM scheduler_intents i JOIN events e ON e.target = i.taskId
            WHERE i.taskId = scheduler_sessions.taskId AND i.recipient = scheduler_sessions.agent
              AND i.action = 'review' AND i.status IN ('submitted','done','unknown') AND i.head = ?
              AND e.kind = 'stage' AND json_extract(e.data, '$.to') = 'review'
              AND json_extract(e.data, '$.round') = ? AND i.eventSeq > e.seq
              AND e.seq = (SELECT MAX(seq) FROM events WHERE target = i.taskId AND kind = 'stage'
                AND json_extract(data, '$.to') = 'review')) ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(task.id, task.headSHA, task.round) as { agent: string } | null;
        if (session) agents.add(session.agent);
      }
      return agents;
    })();
  } finally { db.close(); }
}
