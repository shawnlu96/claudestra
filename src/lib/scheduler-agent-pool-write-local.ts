/**
 * dispatch-recovery-WRITELOCAL1: a new card's writing treats this machine's author family as an equal of every peer family,
 * instead of placeAgentPool's write order (any peer Claude seat before this machine's Codex). Switch: recovery key
 * writeLocalEqual. on = the least loaded of every peer family (both families ranked together) and this machine's author family
 * when it has a free seat wins (ties here); observe = the placement is unchanged and one would-be record per card and
 * stage window is queued; off = unchanged, nothing queued. Fixing and review, a pinned card (placement=local / peer:X), a card
 * whose write lease is held, file locks and quota lines are not read here: a private card reaches placeAgentPool through
 * peersOnly (no local seat), and an over-the-line family has no local seat in the pool totals already.
 * The planner is a read: the would-be record waits in this process's outbox until a caller with a ledger write drains it
 * (drainWriteLocalObserved; recordObserved dedups, so a replayed plan or a restart never records twice).
 * tests/scheduler-agent-pool-write-local*.test.ts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { ObservedAction, RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import type { PlaceRole, Placement, PlacementFacts } from "./scheduler-placement.js";

const WRITE_LOCAL_KEY = "writeLocalEqual";
const FAMILIES: readonly AuthorFamily[] = ["claude", "codex"];

/** `window` names the stage window the card is placed in (one record per card and window). */
interface WriteLocalCard { project: string; task: string; window: string }
interface WriteLocalPort {
  /** Read only when the switch would change the placement; throwing or an unknown value = off. */
  mode(): RecoveryMode;
  /** The card being placed; absent = nothing is recorded under observe (a start or capacity simulation). */
  card?: WriteLocalCard;
}
/** The switch rides on the placement facts, so every path that copies them (retries, reservations) keeps it. */
export type WriteLocalFacts = PlacementFacts & { writeLocal?: WriteLocalPort };

const OUTBOX_MAX = 500;
const outbox = new Map<string, ObservedAction>();
/** Records already queued or written by this process; the ledger's dedup key is what makes a restart safe. */
const seen = new Set<string>();

function readMode(port: WriteLocalPort): RecoveryMode {
  try {
    const mode = port.mode();
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch { return "off"; /* A failed policy read never turns the new placement on. */ }
}

/**
 * The facts with the project's switch attached, and the card when task and window are given; the policy is read at most once,
 * and only if it matters. The reader is injected for the same reason as reviewLocalFacts (ledger-write reaches placeAgentPool).
 */
export function writeLocalFacts<T extends PlacementFacts>(f: T, at: { project: string; task?: string; window?: string },
  policy: RecoveryPolicyPort): T & WriteLocalFacts {
  let mode: RecoveryMode | undefined;
  const card = at.task !== undefined && at.window !== undefined ? { card: { project: at.project, task: at.task, window: at.window } } : {};
  return { ...f, writeLocal: { ...card, mode: () => mode ??= policy(at.project, WRITE_LOCAL_KEY).mode } };
}

/** The family a local start would run: a bound local author's, else the pool's (poolAuthorRuntime: Claude while it has room). */
function localFamily(f: PlacementFacts): AuthorFamily {
  if (f.local.family) return f.local.family;
  const pool = f.local.pool;
  if (pool) return pool.running.claude < pool.totals.claude ? "claude" : "codex";
  return (f.remote as { localAuthorRuntime?: AuthorFamily } | null)?.localAuthorRuntime ?? "claude";
}

function queue(card: WriteLocalCard, family: AuthorFamily, running: number, total: number, peer: { family: AuthorFamily; load: number }): void {
  const actionKey = `write-local:${card.window}`;
  const key = [card.project, card.task, actionKey].join("\u0000");
  // A full outbox means nobody is draining: drop the record without marking it, keeping memory constant.
  if (seen.has(key) || outbox.size >= OUTBOX_MAX) return;
  if (seen.size >= OUTBOX_MAX * 10) seen.clear();
  seen.add(key);
  outbox.set(key, { project: card.project, mechanism: WRITE_LOCAL_KEY, target: card.task, actionKey,
    action: `本会派本机：${family} 本机在跑 ${running} / 名额 ${total}，peer 最少 ${peer.family} 负载 ${peer.load}`,
    data: { family, running, total, peerFamily: peer.family, peerLoad: peer.load, window: card.window } });
}

interface PeerBest { peer: string; load: number }

/** One placement for the same seat: same kind, machine and family (the reason text is not part of the choice). */
const samePlace = (a: Placement, b: Placement): boolean =>
  a.kind === b.kind && (a as { peer?: string }).peer === (b as { peer?: string }).peer && (a as { family?: string }).family === (b as { family?: string }).family;

/**
 * Called by placeAgentPool with its own result. `peerBest(family)` = the least loaded peer of that family that passes every
 * hard constraint (null = none), by the existing familyBusy / familyTotals measure. on ranks both peer families together and
 * the winner against this machine's author family (ties here); a placement = on, send it there; null = keep `placed` (off,
 * observe, another role, a pinned or leased card, or the global minimum is already `placed`).
 */
export function writeLocalEqual(f: WriteLocalFacts, role: PlaceRole, placed: Placement,
  peerBest: (family: AuthorFamily) => PeerBest | null): Placement | null {
  if (role !== "write" || placed.kind === "wait" || f.pin || f.writeLeasePeer || !f.locksFree || !f.writeLocal) return null;
  const family = localFamily(f);
  const total = f.local.pool?.totals[family] ?? f.remote?.agents?.[family] ?? 0;
  const running = f.local.pool?.running[family] ?? f.local.running;
  const best = FAMILIES.map((x) => ({ family: x, row: peerBest(x) }))
    .filter((r): r is { family: AuthorFamily; row: PeerBest } => r.row !== null).sort((a, b) => a.row.load - b.row.load)[0];
  const here = total > running && (!best || running <= best.row.load);
  if (!here && !best) return null;
  const peerText = best ? ` ${best.family} 负载 ${best.row.load}` : "无";
  const want: Placement = here
    ? { kind: "local", family, reason: `${family} 本机在跑 ${running} / 名额 ${total}，peer 最少${peerText}，写单和 peer 平等、平手本机` }
    : { kind: "peer", peer: best!.row.peer, family: best!.family, reason: `${best!.family} 在跑 ${best!.row.load}，写单两家族和本机一起比负载最少` };
  if (samePlace(want, placed)) return null;
  const mode = readMode(f.writeLocal);
  if (mode === "off") return null;
  if (mode === "on") return want;
  if (here && placed.kind === "peer" && f.writeLocal.card) {
    queue(f.writeLocal.card, family, running, total, best ? { family: best.family, load: best.row.load } : { family: placed.family, load: 0 });
  }
  return null;
}

/** Would-be records waiting for a writer, oldest first. */
export const writeLocalPending = (): ObservedAction[] => [...outbox.values()];

/** Same contract as drainReviewLocalObserved: a record whose write throws goes back for the next drain. */
export async function drainWriteLocalObserved(observe: (a: ObservedAction) => void | Promise<void>): Promise<number> {
  const batch = [...outbox];
  outbox.clear();
  let done = 0;
  for (const [key, a] of batch) {
    const ok = await Promise.resolve().then(() => observe(a)).then(() => true, () => false);
    if (ok) done++;
    else if (outbox.size < OUTBOX_MAX) outbox.set(key, a);
  }
  return done;
}

/** Tests only: forget this process's queue and its already-queued keys. */
export function resetWriteLocalObserved(): void { outbox.clear(); seen.clear(); }
