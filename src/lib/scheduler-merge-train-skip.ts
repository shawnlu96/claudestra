/**
 * Which `taskId:head` the next merge train leaves out (nextSkip), and how a void hands on what it already settled
 * (dispatch-recovery-TRAINHANG2, recovery key trainCiTimeout, the same key as TRAINHANG1; no key of its own):
 * - off: as before, a void hands on only the skip it inherited (and what voidUnlocated added to it); its serial / bounced regroup.
 * - observe: the same skip, plus one trainCiTimeout observation per void (the port's ledger note, deduped per train) naming the
 *   keys on would also have skipped.
 * - on: a void also hands on the cards it had already sent serial (a conflict, a lone red on a non-required check, …) or bounced,
 *   at their tested heads: the void is about the train, not about them, so regrouping them replays the same failure. A new head boards.
 * The mode is read once at the void's cleanup (scheduler-merge-train.ts stampVoidSkip) and saved as `voidSkip`; nextSkip only reads
 * that (or the mode a caller passes), so it stays pure. An unreadable key or a broken policy = off: the port's observe counts only
 * when the policy file itself names it for trainCiTimeout (configuredVoidSkip), never recoveryPolicy's default observe.
 */
import { RECOVERY_POLICY_PATH, readRecoveryFile, type RecoveryMode } from "./recovery-policy.js";
import type { TrainState } from "./scheduler-merge-train.js";

export const skipKey = (c: { taskId: string; head: string }) => `${c.taskId}:${c.head.toLowerCase()}`;

const MODES: readonly RecoveryMode[] = ["on", "observe", "off"];
/** The trainCiTimeout mode for the void skip; a throw or anything that is not a mode = off. */
export function voidSkipMode(read: () => RecoveryMode): RecoveryMode {
  try { const m = read(); return MODES.includes(m) ? m : "off"; }
  catch { return "off"; }
}

/** The car id of a void's observation: its ledger actionKey is `train-timeout:<train>:void-skip`, apart from every real car's. */
export const VOID_SKIP_CAR = "void-skip";

/**
 * The trainCiTimeout mode the policy file itself names for `project`: its key, else the project's mode. A missing file, project or
 * both, or a file that does not parse = off (recoveryPolicy would answer its default observe there). `read` = a test's path / fake.
 */
export function configuredVoidSkip(project: string, read?: (project: string) => RecoveryMode, path = RECOVERY_POLICY_PATH): RecoveryMode {
  if (read) return voidSkipMode(() => read(project));
  const r = readRecoveryFile(path);
  if (r.status !== "ok" || !Object.hasOwn(r.data.projects, project)) return "off";
  const p = r.data.projects[project]!;
  return voidSkipMode(() => p.keys?.trainCiTimeout ?? p.mode ?? "off");
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

/** How much of the observation's text the keys may take: recordObserved's prefix plus the sentence stay well under its 600. */
export const VOID_SKIP_NOTE_KEYS = 400;
/**
 * The void's observation text: the keys on would also skip, as many as fit VOID_SKIP_NOTE_KEYS, then a count. Every full key is in
 * the note's structured `data.members` (the observation car's members), so the text can stay bounded.
 */
export function voidSkipNote(held: readonly string[]): string {
  const shown: string[] = [];
  for (const k of held) {
    if ([...shown, k].join("、").length > VOID_SKIP_NOTE_KEYS) break;
    shown.push(k);
  }
  const rest = held.length - shown.length;
  const list = rest ? `${shown.length ? `${shown.join("、")} 等 ` : ""}共 ${held.length} 张（完整见 members）` : shown.join("、");
  return `作废后 ${list} 下一趟不再上车（这次照旧回去重新组车）`;
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
