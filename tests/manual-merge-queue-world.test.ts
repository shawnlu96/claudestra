/**
 * Shared MQ1 fixture (no tests of its own; named *.test.ts to stay inside the card's file globs): manual cards on the MTR1 world
 * (tests/scheduler-merge-reclaim-world.ts), the policy file the pass reads by default, and PM / scheduler ledger CLI calls.
 */
import { writeFileSync } from "node:fs";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";
import type { ReclaimWorld } from "./scheduler-merge-reclaim-world.js";

export const writePolicy = (mode: "on" | "observe" | "off") =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: mode } } } }));

/** The real ledger CLI as `actor` against the world's ledger. */
export const ledgerAs = (w: ReclaimWorld, actor: string, ...args: string[]) => runLedger(args, { db: w.db, actor, projectIds: ["p"],
  loadRegistry: async () => ({} as Registry), saveRegistry: async () => {}, now: () => Date.now() }) as Promise<Record<string, unknown>>;

/**
 * A card PM took over by hand: a real structured review by another family exists, but the engine's review dispatch, its ack and
 * the reviewer session row are gone (RD1 / SBH2 shape), so the auto merge gate would answer merge_review_unproven.
 */
export function manualCard(world: ReclaimWorld, id: string) {
  const c = world.card(id), db = world.db;
  db.query("DELETE FROM scheduler_sessions WHERE taskId = ?").run(id);
  db.query("DELETE FROM scheduler_intents WHERE taskId = ?").run(id);
  setWorkflow(db, { actor: "owner", now: Date.now() }, { taskId: id, taskRev: getTask(db, id)!.rev, workflowRev: 1, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "缩小范围", reason: "PM 接管，人工审查后合并" });
  const review = listEvents(db, { project: "p", target: id }).findLast((e) => e.kind === "review")!;
  return { ...c, reviewSeq: review.seq };
}

export const requestArgs = (c: { taskId: string; head: string; reviewSeq: number }, ...extra: string[]) =>
  ["manual-merge-request", c.taskId, "--head", c.head, "--spec-rev", "1", "--round", "1", "--review-seq", String(c.reviewSeq), "--reason", "人工审过，排队合并", ...extra];
