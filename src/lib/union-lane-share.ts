/**
 * merge-arch-UNIONLANE1 · ordered union files (registry-order.ts ORDERED_UNION_FILES, merge=union + KEYSORT1 order check +
 * KEYUNION1 local union merge) are built for many cards inserting lines at once, so they neither occupy a lane
 * (dag-tools-lanes.ts) nor take / wait on a file lock (scheduler-plan.ts). fileGlobs stay as written: the out-of-spec file
 * check still counts the file in scope. Recovery key unionLaneShare (default on); off = lanes and locks exactly as before.
 * observe = as off, and a dispatch that only another card's lock on such a file holds back queues one would-be record: the planner
 * cannot write, so records wait in this process's outbox until drainUnionLaneShareObserved. tests/union-lane-share.test.ts.
 */
import { isOrderedUnionFile } from "./registry-order.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode } from "./recovery-policy.js";

const KEY = "unionLaneShare";
const OUTBOX_MAX = 500;
const outbox = new Map<string, ObservedAction>();

/** Read every time; an unreadable file / unknown key is off (the exclusive behavior as before). */
export function unionLaneShareMode(project: string, path?: string): RecoveryMode {
  try { const p = recoveryPolicy(project, KEY, path); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
}
export const unionLaneShareOn = (project: string, path?: string): boolean => unionLaneShareMode(project, path) === "on";

/** Both planner gates honor the snapshot override; absent = re-read the project's recovery policy. */
export const unionLanePlanMode = (s: { task: { project: string }; unionLaneShare?: boolean }): RecoveryMode =>
  s.unionLaneShare === undefined ? unionLaneShareMode(s.task.project) : s.unionLaneShare ? "on" : "off";

/** `resources` without the ordered union files when sharing is on; the same array otherwise. */
export const sharedOut = <T extends string>(resources: readonly T[], on: boolean): readonly T[] =>
  on ? resources.filter((r) => !isOrderedUnionFile(r)) : resources;

/** Whether any of `resources` is an ordered union file, so the policy is read only when it can change the answer. */
export const touchesUnionFile = (resources: readonly string[]): boolean => resources.some(isOrderedUnionFile);

type Held = { resource: string; taskId: string };
/**
 * The first of `resources` that another card's lock in `held` blocks (null = none). on skips locks on ordered union
 * files; off / observe block as before, and observe queues a sample when only such locks block.
 */
export function blockingLock(task: { id: string; project: string }, held: readonly Held[], resources: readonly string[],
  overlap: (resource: string, h: Held) => boolean, mode: RecoveryMode): { resource: string; held: Held } | null {
  const first = (locks: readonly Held[]) => {
    for (const resource of resources) { const h = locks.find((l) => overlap(resource, l)); if (h) return { resource, held: h }; }
    return null;
  };
  const shared = mode === "off" ? held : held.filter((h) => !isOrderedUnionFile(h.resource));
  if (mode === "on") return first(shared);
  const hit = first(held);
  if (hit && mode === "observe" && !first(shared)) queue(task, hit.held);
  return hit;
}

function queue(task: { id: string; project: string }, h: Held): void {
  const actionKey = `union-lane:${h.taskId}:${h.resource}`.slice(0, 120);
  const id = `${task.project}\0${task.id}\0${actionKey}`;
  if (outbox.has(id) || outbox.size >= OUTBOX_MAX) return;
  outbox.set(id, { project: task.project, mechanism: KEY, target: task.id, actionKey,
    action: `不等 ${h.taskId} 对有序并集文件 ${h.resource} 的锁、照常派单`, data: { heldBy: h.taskId, resource: h.resource } });
}

/** Would-be records waiting for a writer, oldest first. */
export const unionLaneSharePending = (): ObservedAction[] => [...outbox.values()];

/**
 * Hand every waiting record to `observe` (recordObserved, or the scheduler identity's `ledger scheduler-recovery-observe`).
 * A record whose write throws goes back in the queue for the next drain. Returns how many were handed over.
 */
export async function drainUnionLaneShareObserved(observe: (a: ObservedAction) => void | Promise<void>): Promise<number> {
  let done = 0;
  for (const [id, a] of [...outbox]) {
    outbox.delete(id);
    try { await observe(a); done++; } catch { if (outbox.size < OUTBOX_MAX) outbox.set(id, a); }
  }
  return done;
}

/** Tests only: forget this process's queue. */
export function resetUnionLaneShareObserved(): void { outbox.clear(); }
