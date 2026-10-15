/** Private cards are eligible after a verified scheduler merge, or after PM moved a manually merged card past merge. */
import type { Database } from "bun:sqlite";
import { listTasks } from "./ledger-store.js";
import { cardRepo } from "./scheduler-foreign-repo.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip.js";

export function centerCards(db: Database, project: string, repo: string): string[] {
  return listTasks(db, project).filter((t) => {
    if (cardRepo(t) !== repo.toLowerCase() || schedulerV2SkipTask(db, t.id)) return false;
    if (["live", "verified"].includes(t.stage)) return true;
    return t.stage === "merge" && !!db.query("SELECT 1 FROM scheduler_merges WHERE taskId=? AND phase='merged' LIMIT 1").get(t.id);
  }).map((t) => t.id).sort();
}
