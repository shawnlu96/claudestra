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
        const rows = steps.get(task.id) ?? [];
        if (task.stage !== "review") {
          const step = stepAtStage(rows, task);
          if (step?.executorKind === "agent") agents.add(step.executor);
          else if (!step && task.agent) agents.add(task.agent);
          continue;
        }
        // Review bindings outlive rounds; retaining every local reviewer prevents unsafe undercounting.
        for (const step of rows) {
          if ((step.step === "review" || step.step === "final_review") && step.executorKind === "agent") agents.add(step.executor);
        }
        const sessions = db.query(`SELECT agent FROM scheduler_sessions
          WHERE taskId = ? AND role = 'reviewer' AND transport != 'peer'`).all(task.id) as { agent: string }[];
        for (const session of sessions) agents.add(session.agent);
      }
      return agents;
    })();
  } finally { db.close(); }
}
