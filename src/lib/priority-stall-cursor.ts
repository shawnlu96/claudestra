/**
 * Cursor identities are filtered against current due targets and recovery mode before reuse. Budget tails are baseline
 * behaviour; only stop-origin tails require priorityStallCursor=on. Keeping their provenance makes live rollback effective.
 * Partial commands resume via the store's claim / cycle. Tests: tests/priority-stall-cursor.test.ts.
 */
import type { Database } from "bun:sqlite";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

const PRIORITY_STALL_CURSOR = "priorityStallCursor";
// Keep identities, not stale facts: targets can finish or change mode between rounds.
interface PendingTarget { key: string; stoppedProject?: string }
const pendingTargets = new WeakMap<Database, PendingTarget[]>();

export const cursorKey = (project: string, key: string): string => JSON.stringify([project, key]);

/** This round's order: the saved cursor still due, then every other due target in its natural order. Consumes the cursor. */
export function takeCursor(db: Database, due: ReadonlySet<string>, policy: RecoveryPolicyPort = recoveryPolicy): string[] {
  const pending = (pendingTargets.get(db) ?? []).filter((t) => due.has(t.key)
    && (t.stoppedProject === undefined || modeOf(policy, t.stoppedProject) === "on")).map((t) => t.key);
  pendingTargets.delete(db);
  const queued = new Set(pending);
  return [...pending, ...[...due].filter((key) => !queued.has(key))];
}

/** Budget exhausted before `rest`: the unscanned tail is next round's front. */
export function keepBudgetTail(db: Database, rest: string[]): void {
  pendingTargets.set(db, rest.map((key) => ({ key })));
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
  const kept = rest.filter((t) => mode(t.project) === "on").map((t) => ({ key: t.key, stoppedProject: t.project }));
  pendingTargets.set(db, kept);
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
  return kept.map((t) => t.key);
}
