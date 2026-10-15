/** Merge identities survive card stage changes; successful deployments consume exactly their captured identities. */
import type { Database } from "bun:sqlite";
import { listTasks } from "./ledger-store.js";
import { cardRepo } from "./scheduler-foreign-repo.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip.js";

export function centerCardKeys(db: Database, project: string, repo: string): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const t of listTasks(db, project)) {
    if (cardRepo(t) !== repo.toLowerCase() || schedulerV2SkipTask(db, t.id)) continue;
    const merged = db.query("SELECT mergeSha,prRef,reviewedHead FROM scheduler_merges WHERE taskId=? AND phase='merged' ORDER BY updatedAt DESC LIMIT 1")
      .get(t.id) as { mergeSha: string; prRef: string; reviewedHead: string } | null;
    const advanced = ["live", "verified", "done"].includes(t.stage);
    if (!merged && !advanced) continue;
    const sameMerge = merged && (!advanced || merged.prRef === t.pr && merged.reviewedHead === t.headSHA);
    keys[t.id] = `${repo.toLowerCase()}:${sameMerge ? merged.mergeSha : `${t.pr}:${t.headSHA}`}`;
  }
  return keys;
}
export function centerCards(db: Database, project: string, repo: string, deployed: Record<string, string[]> = {}): string[] {
  return Object.entries(centerCardKeys(db, project, repo)).filter(([id, key]) => !deployed[id]?.includes(key)).map(([id]) => id).sort();
}
