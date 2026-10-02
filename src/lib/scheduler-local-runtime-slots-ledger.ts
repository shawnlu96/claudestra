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
        if (step) {
          if (step.executorKind === "agent" && step.state === "assigned"
            && (task.stage !== "review" || step.round === task.round)) agents.add(step.executor);
          continue;
        }
        if (task.stage !== "review") {
          if (task.agent) agents.add(task.agent);
          continue;
        }
        // A scheduler binding is authoritative when no explicit review step was assigned.
        const session = db.query(`SELECT agent FROM scheduler_sessions WHERE taskId = ? AND role = 'reviewer'
          AND state = 'active' AND transport != 'peer' ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(task.id) as { agent: string } | null;
        if (session) agents.add(session.agent);
      }
      return agents;
    })();
  } finally { db.close(); }
}
