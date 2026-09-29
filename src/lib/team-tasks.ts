/** Resolve the current step rather than stale legacy delegate/reviewer fields. */
import type { Database } from "bun:sqlite";
import { listTasks } from "./ledger-store.js";
import { stepAtStage, stepsOf } from "./ledger-steps.js";

export const activeTeamTask = (task: { stage: string }) => !["done", "verified", "cancelled"].includes(task.stage);

export function teamTasks(db: Database, project: string, peer: string, agent: string) {
  return listTasks(db, project).filter((task) => {
    const step = stepAtStage(stepsOf(db, task), task);
    if (!activeTeamTask(task)) return false;
    if (!peer) return (step?.executorKind !== "peer" && step?.executor.replace(/^agent-/, "") === agent.replace(/^agent-/, "")) ||
      task.pm?.replace(/^agent-/, "") === agent.replace(/^agent-/, "");
    if (!step || step.executorKind !== "peer") return false;
    const at = step.executor.lastIndexOf("@");
    return at > 0 && step.executor.slice(at + 1) === peer &&
      step.executor.slice(0, at).replace(/^agent-/, "") === agent.replace(/^agent-/, "");
  }).map(({ id, title, stage }) => ({ id, title, stage }));
}
