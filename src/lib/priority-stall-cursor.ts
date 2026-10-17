/**
 * STALLCUR1 · the priority-stall scan cursor: which due targets the next tick starts from. Identities only (JSON [project, key]);
 * every round re-filters them against the latest due set, so a target that finished, went verified, turned off or is skipped
 * simply drops out. Budget exhaustion keeps the unscanned tail (STALLVER1). A SchedulerStopped mid-scan keeps the interrupted
 * target and the tail under recovery key priorityStallCursor (default on): on keeps them, observe records one sample per project
 * and drops them like off, off drops them (the old behaviour: the next round starts from the front). A target whose commands
 * partly landed resumes from the store's own claim / cycle on its next claim, so nothing already done is redone.
 * Rollback: `ledger scheduler-recovery claude-orchestrator off --key priorityStallCursor --reason ...`. tests/priority-stall-cursor.test.ts.
 */
import type { Database } from "bun:sqlite";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

const PRIORITY_STALL_CURSOR = "priorityStallCursor";
// Keep identities, not stale facts: targets can finish or change mode between rounds.
const pendingTargets = new WeakMap<Database, string[]>();

export const cursorKey = (project: string, key: string): string => JSON.stringify([project, key]);

/** This round's order: the saved cursor still due, then every other due target in its natural order. Consumes the cursor. */
export function takeCursor(db: Database, due: ReadonlySet<string>): string[] {
  const pending = (pendingTargets.get(db) ?? []).filter((key) => due.has(key));
  pendingTargets.delete(db);
  const queued = new Set(pending);
  return [...pending, ...[...due].filter((key) => !queued.has(key))];
}

/** Budget exhausted before `rest`: the unscanned tail is next round's front. */
export function keepBudgetTail(db: Database, rest: string[]): void {
  pendingTargets.set(db, rest);
}

/** rev is read lazily: only an observed project's first target needs it. */
export interface StoppedTarget { key: string; project: string; taskId: string | null; rev: () => number }
export interface CursorOpts { policy?: RecoveryPolicyPort; now?: number }

const PART_BAD = /[^\w.:@/-]/g;
const part = (s: string) => (s.replace(PART_BAD, "_").slice(0, 120) || "-");

function modeOf(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try { return policy(project, PRIORITY_STALL_CURSOR).mode; } catch { return "off"; } // an unreadable switch never keeps
}

/**
 * The scan was stopped at rest[0] (not finished; targets before it are). The switch is read now, per project: on keeps that
 * project's targets in order, observe writes one note per project (deduped by first target + its revision; identities only,
 * never card text) and keeps nothing, off keeps nothing. Never throws: the stop must still propagate.
 */
export function keepStoppedTail(db: Database, rest: StoppedTarget[], opts: CursorOpts = {}): string[] {
  const policy = opts.policy ?? recoveryPolicy, modes = new Map<string, RecoveryMode>();
  const mode = (project: string) => modes.get(project) ?? modes.set(project, modeOf(policy, project)).get(project)!;
  const kept = rest.filter((t) => mode(t.project) === "on").map((t) => t.key);
  if (kept.length) pendingTargets.set(db, kept);
  for (const [project, m] of modes) {
    if (m !== "observe") continue;
    const mine = rest.filter((t) => t.project === project), first = mine[0]!;
    try {
      const rev = first.rev();
      // The ledger target must be a task (or "" = project level); the stall key itself goes into the dedup actionKey.
      recordObserved(db, { project, mechanism: PRIORITY_STALL_CURSOR, target: first.taskId ?? "", actionKey: part(`keep:${rev}:${JSON.parse(first.key)[1]}`),
        action: `停止后保留 ${mine.length} 个未扫目标到下一轮队首`, data: { remaining: mine.length, rev } }, opts.now ?? Date.now());
    } catch { /* a read-only connection or a lost race only loses the sample */ }
  }
  return kept;
}
