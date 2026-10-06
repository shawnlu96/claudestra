/**
 * At the merge handoff the PR's net change is fixed (scheduler-merge-handoff.ts), so the card keeps locks only on the files it
 * actually changed that its fileGlobs cover; everything else goes back to other cards while the owner takes days to merge.
 * A carry only merges main in (same net diff): locks stay as they are. Back in fix, the fix dispatch re-takes the full fileGlobs
 * (planIntent acquires what it lacks, waiting if another card took a file meanwhile). tests/scheduler-merge-handoff-narrow.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { resourceKey } from "./ledger-scheduler.js";
import { cardFileLocks, coveredBy, replaceCardFileLocks } from "./ledger-scheduler-lease-sync.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { handoffOf } from "./scheduler-merge-handoff.js";

const OP = "merge_handoff_narrow";
const SHA = /^[a-f0-9]{40}$/i;

export type NarrowResult = { narrowed: true; from: string[]; to: string[]; duplicate: boolean } | { narrowed: false; reason: string };

/**
 * `files` = the PR's changed paths (both sides of a rename) at the handed head. Any path the scheduler cannot name as a resource,
 * an open intent, or a card no longer at this handoff keeps the locks whole: narrowing is an optimisation, never a guess.
 */
export function narrowHandoffLocks(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; files: readonly string[] }): NarrowResult {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "交接收窄只由调度服务做");
  return tx(db, () => {
    const task = mustTask(db, input.taskId), follow = handoffOf(db, task);
    if (task.stage !== "merge" || !SHA.test(input.head) || task.headSHA !== input.head || follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) {
      return { narrowed: false, reason: "卡不在这次交接上（阶段、head 或 PR 已变）" };
    }
    const key = `scheduler:${OP}:${task.id}:h${follow.event.seq}`;
    const prev = getEventByDedup(db, key);
    if (prev) return { narrowed: true, from: prev.data.from as string[], to: prev.data.to as string[], duplicate: true };
    if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id)) {
      return { narrowed: false, reason: "卡还有未结调度意图" };
    }
    const paths = input.files.map((f) => (f.includes("*") ? null : resourceKey(f)));
    if (paths.includes(null)) return { narrowed: false, reason: "PR 改动里有调度器认不了的路径" };
    const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.map((g) => (typeof g === "string" ? resourceKey(g) : null)) : [];
    if (!globs.length || globs.includes(null)) return { narrowed: false, reason: "卡的 fileGlobs 缺失或不合规" };
    const held = cardFileLocks(db, task.id);
    if (!held.length) return { narrowed: false, reason: "卡没拿文件锁" };
    // PR ∩ fileGlobs, and never a lock the card does not already cover: narrowing only ever gives files back
    const to = [...new Set(paths as string[])].filter((p) => globs.some((g) => coveredBy(p, g!)) && held.some((h) => coveredBy(p, h.resource))).sort();
    const from = held.map((h) => h.resource), now = ctx.now ?? Date.now();
    replaceCardFileLocks(db, task, held, to, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `交接后文件锁收窄到 PR 实际改动：${from.length} → ${to.length} 把`, data: { op: OP, handoffSeq: follow.event.seq, head: input.head, from, to, files: paths } }, true);
    return { narrowed: true, from, to, duplicate: false };
  });
}
