/**
 * QUEUEPRIO1 · the unified merge queue's order among eligible versions once nothing is in flight (merge-queue-owner.ts settles
 * uncertain runs, the slot holder and unbegun intents first). Legacy: mainline repair cards first, then QUEUE1 (versionSeq, source,
 * task id). With the recovery key `mergeOwnerPriority` on, PRIO2 (`prioritySort`, entry merge_contest) re-orders the rest by the
 * owner's band and explicit order; same band and place keeps QUEUE1 age. Protected entries (repairs, admitted versions that already
 * own a live merge intent, e.g. a yielded run) never move and are never passed: a higher band only overtakes inside the stretch
 * between two protected entries. The owner order never promotes a version whose prerequisite cards are unfinished past the legacy
 * pick (the planner would only wait on it while the owner fence refuses its prerequisite); the legacy pick itself stays as it was,
 * so prioritySort observe/off keeps the legacy outcome (tests/merge-queue-owner-priority.test.ts).
 * Key observe = legacy runs, the would-be pick is recorded; off = legacy, nothing else is read.
 */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { listDeps, listTasks } from "./ledger-store.js";
import { ownerPorts } from "./merge-queue-owner-context.js";
import type { QueueEntry } from "./merge-queue-facts.js";
import type { RecoveryMode } from "./recovery-policy.js";
import { sortByPriority, type Ranked } from "./scheduler-priority-order.js";
import { recordPrioritySort } from "./scheduler-priority-order-record.js";

const MERGE_OWNER_PRIORITY_KEY = "mergeOwnerPriority";

/** Read before every pick, so `ledger scheduler-recovery … --key mergeOwnerPriority` takes effect without a restart. */
export function ownerPriorityMode(db: Database, project: string): RecoveryMode {
  try { return ownerPorts(db).policy(project, MERGE_OWNER_PRIORITY_KEY).mode; }
  catch (e) { console.error(`[merge-owner] ${project} ${MERGE_OWNER_PRIORITY_KEY} 策略不可读，按 off：${String(e)}`); return "off"; }
}

/** Keep every protected entry where it is and sort each stretch between two of them by `order` (a stable priority order). */
function withinStretches<T>(legacy: readonly T[], order: readonly T[], fixed: (x: T) => boolean): T[] {
  const at = new Map(order.map((x, i) => [x, i] as const)), out: T[] = [];
  let stretch: T[] = [];
  const flush = () => { out.push(...stretch.sort((a, b) => at.get(a)! - at.get(b)!)); stretch = []; };
  for (const x of legacy) if (fixed(x)) { flush(); out.push(x); } else stretch.push(x);
  flush();
  return out;
}

/** Same dependency gate as the planner (scheduler-snapshot `blockedBy`), read once per pick. */
function waitingOnDeps(db: Database, project: string, entries: readonly QueueEntry[]): ReadonlySet<string> {
  const views = depViews(listDeps(db, project), listTasks(db, project));
  return new Set(entries.filter((e) => blockedBy(e.taskId, views).length).map((e) => e.taskId));
}

export interface OwnerPriorityPick { entry: QueueEntry | null; why: string | null }

/**
 * `legacy` is already repair-first QUEUE1 order; `admit` is the caller's full gate (repository, manual switch, eligibility,
 * train). `inFlight` marks entries that own a live merge intent. `override` replaces the key only for the observe comparison,
 * which records no PRIO2 sample. Returns `why` = null when the legacy explanation still holds.
 */
export function ownerPriorityPick(db: Database, project: string, legacy: readonly QueueEntry[], admit: (e: QueueEntry) => boolean,
  inFlight: (e: QueueEntry) => boolean, repairs: ReadonlySet<string>, now: number, override?: RecoveryMode): OwnerPriorityPick {
  const mode = override ?? ownerPriorityMode(db, project);
  const verdicts = new Map<QueueEntry, boolean>();
  const ok = (e: QueueEntry) => { if (!verdicts.has(e)) verdicts.set(e, admit(e)); return verdicts.get(e)!; };
  const first = (list: readonly QueueEntry[]) => list.find(ok) ?? null;
  if (mode === "off") return { entry: first(legacy), why: null };
  const fixed = (e: QueueEntry) => repairs.has(e.taskId) || (inFlight(e) && ok(e));
  const waiting = waitingOnDeps(db, project, legacy), legacyChosen = first(legacy);
  // The walk ends at the legacy pick at the latest: only a promotion is checked against prerequisites, never the legacy outcome.
  const ranked = (list: readonly QueueEntry[]) => list.find((e) => ok(e) && (e === legacyChosen || fixed(e) || !waiting.has(e.taskId))) ?? null;
  const sort = sortByPriority(db, "merge_contest", legacy, (e) => ({ project, taskId: e.taskId }), { pinned: fixed, record: false, now });
  const would = withinStretches(legacy, sort.would, fixed), wouldChosen = ranked(would);
  const chosen = mode === "on" ? ranked(withinStretches(legacy, sort.applied, fixed)) : legacyChosen;
  if (mode === "on" && !override) {
    recordPrioritySort("merge_contest", { ranked: sort.ranked, would: would.map((e) => sort.rankOf(e)!) as Ranked<QueueEntry>[],
      opts: {}, now, ledger: db.filename, claim: { legacy: legacyChosen, would: wouldChosen, blocked: [] } });
  }
  const r = chosen ? sort.rankOf(chosen) : undefined;
  if (mode !== "on" || chosen === legacyChosen || !r?.rank || r.mode !== "on" || r.pinned) return { entry: chosen, why: null };
  const place = r.rank.order === null ? "" : ` 第 ${r.rank.order + 1} 位`;
  return { entry: chosen, why: `owner 档位 ${r.rank.band}${place}，同档按队龄（保留在途与 yielded 队位）` };
}

interface PickLike { entry: QueueEntry | null; intentId: string | null; reason: string }
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/**
 * Key observe: record (deduped per target + version + both picks) the version the owner order would hand the slot instead of
 * the legacy pick. Only differences are written; no request text or owner words go into the sample.
 */
export async function observeOwnerPriority(db: Database, manager: Manager, project: string,
  pick: (mode: RecoveryMode) => PickLike): Promise<void> {
  if (ownerPriorityMode(db, project) !== "observe") return;
  const old = pick("off"), next = pick("on"), target = next.entry?.taskId;
  if (!target || old.intentId || next.intentId || target === old.entry?.taskId) return;
  const e = next.entry!, prior = old.entry?.taskId ?? null;
  const key = `prio:${Bun.hash(`${target}:${e.versionSeq}:${e.head}:${e.specRev}:${prior}:${next.reason}`).toString(36)}`;
  const result = await manager("ledger", "scheduler-recovery-observe", target, "--mechanism", MERGE_OWNER_PRIORITY_KEY, "--action-key", key,
    "--action", `按 owner 档位会先合 ${target}，现序先合 ${prior ?? "无人"}：${next.reason}`,
    "--data", JSON.stringify({ chosen: target, old: prior, versionSeq: e.versionSeq, head: e.head, source: e.source, reason: next.reason }));
  if (result.ok !== true && result.held !== true) console.error(`[merge-owner] ${project} 档位观察记录失败：${String(result.error)}`);
}
