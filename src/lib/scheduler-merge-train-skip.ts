/**
 * Which `taskId:head` the next merge train leaves out (nextSkip), and how a void hands on what it already settled
 * (dispatch-recovery-TRAINHANG2, recovery key trainCiTimeout, the same key as TRAINHANG1; no key of its own):
 * - off: as before, a void hands on only the skip it inherited (and what voidUnlocated added to it); its serial / bounced regroup.
 * - observe: the same skip, plus one train `observe` event per void naming the keys on would also have skipped.
 * - on: a void also hands on the cards it had already sent serial (a conflict, a lone red on a non-required check, …) or bounced,
 *   at their tested heads: the void is about the train, not about them, so regrouping them replays the same failure. A new head boards.
 * The mode is read once at the void's cleanup (scheduler-merge-train.ts stampVoidSkip) and saved as `voidSkip`; nextSkip only reads
 * that (or the mode a caller passes), so it stays pure. An unreadable key or a broken policy = off.
 */
import type { RecoveryMode } from "./recovery-policy.js";
import type { TrainState } from "./scheduler-merge-train.js";

export const skipKey = (c: { taskId: string; head: string }) => `${c.taskId}:${c.head.toLowerCase()}`;

const MODES: readonly RecoveryMode[] = ["on", "observe", "off"];
/** The trainCiTimeout mode for the void skip; a throw or anything that is not a mode = off. */
export function voidSkipMode(read: () => RecoveryMode): RecoveryMode {
  try { const m = read(); return MODES.includes(m) ? m : "off"; }
  catch { return "off"; }
}

/** The cards a train sent serial or bounced before it ended, at the heads it tested. */
function settledKeys(prev: TrainState): string[] {
  const serial = prev.serial.map((id) => prev.members.find((m) => m.taskId === id)).filter((m) => !!m);
  return [...serial, ...prev.bounced].map(skipKey);
}

/** What on hands on beyond off after a void: the settled keys not already in the inherited skip. */
export function voidHeldKeys(prev: TrainState): string[] {
  if (prev.outcome !== "void") return [];
  const had = new Set(prev.skip ?? []);
  return [...new Set(settledKeys(prev))].filter((k) => !had.has(k));
}

/**
 * What the next train must leave out: the last one's skip list plus the cards it sent serial or bounced. A void adds them only
 * under on (`mode`, default the one its cleanup saved); off / observe keep the old rule, a void inherits nothing of its own.
 */
export function nextSkip(prev: TrainState | null, mode: RecoveryMode = prev?.voidSkip ?? "off"): string[] {
  if (!prev) return [];
  const own = prev.outcome === "void" && mode !== "on" ? [] : settledKeys(prev);
  return [...new Set([...(prev.skip ?? []), ...own])];
}
