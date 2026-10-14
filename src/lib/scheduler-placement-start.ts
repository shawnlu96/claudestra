import { poolLocalFacts } from "./scheduler-agent-pool-context.js";
import { reserveFinishing, reservedStartPlacement } from "./scheduler-agent-pool-reserve.js";
import type { PlacementFacts } from "./scheduler-placement.js";
import { localFamilyRefusal } from "./scheduler-local-families-placement.js";
/**
 * start_node's placement (i28-W5): where a new card's writing goes, by the same placeFor the planner uses. `auto` picks
 * by tier and load; a new local start requires writing room and localPriority enabled; `peer:<name>` is
 * a pin that must pass every hard constraint now or start_node refuses. Reading the config / borrow / origin repo is
 * injected; a failed read means no peer, never a guess. tests/dag-tools-placement.test.ts.
 */
import type { Database } from "bun:sqlite";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { BorrowEntry } from "./lend-config.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { placeFor, PEER_PLACEMENT } from "./scheduler-family-pick.js";
import { peerFacts } from "./scheduler-placement-plan.js";
import { borrowPeers, localReviewerCount, localWriterCount } from "./scheduler-pool-facts.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";
import { newLocalWriteRoom } from "./scheduler-slot-hold.js";
import type { PlacementReservation, ReservationPort } from "./scheduler-placement-reservations.js";
import { peersOnly } from "./scheduler-agent-pool-plan.js";
import { getTask } from "./ledger-store.js";
import { recoveryPolicy, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

export type StartPlacement = { where: "local"; reason: string } |
  { where: "peer"; peer: string; repo: string; reason: string; reservation?: PlacementReservation } | { where: "refused"; reason: string };

export interface StartPlacementIO {
  /** scheduler.json's policy for the project; null = not listed. */
  policy(project: string): { remote: RemotePolicy | null; maxWorkers: number } | null;
  borrow(): Promise<readonly BorrowEntry[]>;
  /** GitHub owner/repo of the project directory's origin; null = not a GitHub remote. */
  originRepo(dir: string): Promise<string | null>;
  now(): number;
  /** One injected policy source; observe computes shadow placement without consuming a seat. */
  reservations?: ReservationPort | ((project: string) => ReservationPort);
  /** privateStartPlacement's reader; absent = the file-backed recoveryPolicy. Only read for a private card. */
  recovery?: RecoveryPolicyPort;
}

/**
 * dispatch-recovery-PRIVSTART1: a private card (a `repo:` fileGlob, the autostart private gate's test) has no checkout the planner
 * accepts here, so its start goes to a peer or waits. Recovery key privateStartPlacement: off = unchanged; observe = unchanged, plus one
 * would-be record per card and spec revision for a start that goes ahead (a refused one is 等 either way: not recorded);
 * on = placement over peersOnly(facts), and no peer room / no placement / a failed read is refused, never this machine.
 * A public card never reads the key. tests/scheduler-placement-start-private*.test.ts.
 */
const PRIVATE_KEY = "privateStartPlacement";
export const PRIVATE_ONLY_PEER = "私仓卡只放 peer";
const isPrivateStart = (globs: readonly string[]): boolean => globs.some((g) => g.startsWith("repo:"));

/** A public card is always off; a failed or unknown read is off too (it never turns the peers-only placement on). */
export function privateStartMode(project: string, globs: readonly string[], policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  if (!isPrivateStart(globs)) return "off";
  try {
    const mode = policy(project, PRIVATE_KEY).mode;
    return mode === "on" || mode === "observe" ? mode : "off";
  } catch { return "off"; }
}

/** Queued would-be records by dedup key; `true` = already written by this process. Bounded, so an undrained queue stays small. */
const observed = new Map<string, ObservedAction | true>();
/** The ledger each pending record was noted against (the scheduler's own connection), read again at drain for its card. */
const notedIn = new Map<string, Database>();
/** Drains that found the record's card missing; the second miss drops it (a start rolled back after placement never creates the card). */
const misses = new Map<string, number>();
const QUEUE_MAX = 500;

/**
 * Queue observe's would-be record (`wouldBe` = peer:<name> or 等) for the card; absent card = nothing (a capacity simulation).
 * The scheduler's ledger connection is query_only, so records wait here for the scheduler's lease-bound writer
 * (scheduler-autostart-deps.ts flushReviewLocal -> drainPrivateStartObserved -> `ledger scheduler-recovery-observe`); the ledger's
 * dedup key and this process's map keep one record per card and spec revision. Only the scheduler process drains: a bridge
 * start_node has no scheduler identity, so what it queues is never written (bounded by QUEUE_MAX).
 */
export function notePrivateStart(db: Database, project: string, card: string | undefined, actual: string, wouldBe: string, reason: string): void {
  if (!card) return;
  let specRev = 1; // a card not created yet starts at specRev 1 (ledger-write createTask)
  try { specRev = getTask(db, card)?.specRev ?? 1; } catch { /* unreadable: the new card's revision */ }
  const actionKey = `private-start:s${specRev}`;
  const key = JSON.stringify([project, card, actionKey]);
  if (observed.has(key)) return;
  if (observed.size >= QUEUE_MAX * 10) for (const [k, v] of observed) if (v === true) observed.delete(k);
  if (privateStartPending().length >= QUEUE_MAX) return; // nobody is draining: drop it unmarked
  observed.set(key, { project, mechanism: PRIVATE_KEY, target: card, actionKey,
    action: `私仓卡只放 peer 时放到 ${wouldBe}（现在放 ${actual}）：${reason}`.slice(0, 400), data: { actual, wouldBe, specRev } });
  notedIn.set(key, db);
}

export const privateStartPending = (): ObservedAction[] => [...observed.values()].filter((v): v is ObservedAction => v !== true);

/**
 * Writes each queued record once; one that throws stays queued for the next drain. The observe write scopes the note by the card
 * (scheduler-recovery-write.ts writeRecoveryObserve: no card = not_found), so a record whose card is not in its ledger yet waits one drain
 * (autostart creates the card later in the tick that queued it) and is dropped on the second miss; a card of another project is
 * dropped at once. Returns how many were written.
 */
export async function drainPrivateStartObserved(write: (a: ObservedAction) => void | Promise<void>): Promise<number> {
  let written = 0;
  for (const [key, a] of [...observed]) {
    if (a === true) continue;
    let task: { project: string } | null;
    try { task = getTask(notedIn.get(key)!, a.target); } catch { task = null; /* unreadable (a closed ledger) counts as a miss */ }
    if (!task || task.project !== a.project) {
      const n = (misses.get(key) ?? 0) + 1;
      if (task || n >= 2) { observed.delete(key); misses.delete(key); notedIn.delete(key); } else misses.set(key, n);
      continue;
    }
    try {
      await write(a);
      observed.set(key, true);
      misses.delete(key);
      notedIn.delete(key);
      written++;
    } catch { /* stays queued */ }
  }
  return written;
}

/** Tests only. */
export function resetPrivateStartObserved(): void { observed.clear(); misses.clear(); notedIn.clear(); }

const PEER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `auto` | `local` | `peer:<name>`; anything else is null (start_node refuses it as invalid). */
export function parseStartPlacement(raw: unknown): "auto" | "local" | `peer:${string}` | null {
  if (raw === undefined || raw === "auto") return "auto";
  if (raw === "local") return "local";
  return typeof raw === "string" && raw.startsWith(PEER_PLACEMENT) && PEER_NAME.test(raw.slice(PEER_PLACEMENT.length)) ? raw as `peer:${string}` : null;
}

/** Review sessions affect placement load independently; only local writing consumes the worker-slot cap. */
function localLoad(db: Database, project: string, maxWorkers: number, remote: RemotePolicy | null = null) {
  const pool = poolLocalFacts(db, project, remote);
  if (pool) return pool;
  const slots = writeSlotFacts(db, project);
  return { running: localWriterCount(db, project, null) + localReviewerCount(db, project, null), room: newLocalWriteRoom(slots.workerCount, maxWorkers, slots.waitingFix) };
}

function locksFree(db: Database, project: string, globs: readonly string[], taskId?: string): boolean {
  const mine = globs.map(resourceKey);
  const held = db.query("SELECT resource FROM scheduler_resources WHERE project = ? AND (? IS NULL OR taskId != ?)")
    .all(project, taskId ?? null, taskId ?? null) as { resource: string }[];
  return !mine.includes(null) && !held.some((h) => mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())));
}

export async function startPlacement(db: Database, io: StartPlacementIO,
  q: { project: string; repoDir: string; fileGlobs: readonly string[]; want: "auto" | `peer:${string}`; taskId?: string; card?: string },
  finishFirst = false): Promise<StartPlacement> {
  const pin = q.want === "auto" ? null : q.want;
  const priv = privateStartMode(q.project, q.fileGlobs, io.recovery);
  const card = q.card ?? q.taskId;
  const policy = io.policy(q.project);
  const reservations = typeof io.reservations === "function" ? io.reservations(q.project) : io.reservations;
  let borrow: readonly BorrowEntry[] = [];
  let repo: string | null = null;
  try {
    [borrow, repo] = await Promise.all([io.borrow(), io.originRepo(q.repoDir)]);
  } catch (e) {
    if (pin) return { where: "refused", reason: `读借入名单 / 仓库地址失败：${(e as Error).message}` };
    if (priv === "on") return { where: "refused", reason: `${PRIVATE_ONLY_PEER}：读借入名单 / 仓库地址失败：${(e as Error).message}` };
    const refusal = localFamilyRefusal({ remote: policy?.remote ?? null }, "write", "claude");
    if (refusal && !policy?.remote?.agents) return { where: "refused", reason: refusal };
    if ((!policy?.remote?.agents && policy?.remote?.localPriority === "off")) return { where: "refused", reason: `本机不写代码，读借入名单失败：${(e as Error).message}` };
    if (!localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null).room) return { where: "refused", reason: "本机写槽已满，且无法确认 peer 空位" };
    if (priv === "observe") notePrivateStart(db, q.project, card, "local", "等", `读借入名单 / 仓库地址失败：${(e as Error).message}`);
    return { where: "local", reason: `读借入名单 / 仓库地址失败，放本机：${(e as Error).message}` };
  }
  const all: PlacementFacts = {
    remote: policy?.remote ?? null,
    peers: borrowPeers(db, q.project, borrow, io.now(), !!policy?.remote?.agents, { exceptTask: q.taskId, enforce: reservations?.mode === "on" }).map(peerFacts),
    repo, local: localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null), pin, tried: [], lastPeer: null, writeLeasePeer: null,
    locksFree: locksFree(db, q.project, q.fileGlobs, q.taskId),
  };
  // on: placement, finishing reservation and the reservations shadow all see peers only (an explicit peer pin is the PM's choice).
  const peersFirst = priv === "on" && !pin;
  const facts = peersFirst ? peersOnly(all) : all;
  // Only automatic admission opts in; the PM's manual start_node placement keeps its explicit choice.
  const placed = finishFirst && policy?.remote?.agents ? reservedStartPlacement(facts, reserveFinishing(db, q.project, facts, q.taskId)) : placeFor(facts, "write", "claude");
  const mode = reservations?.mode ?? "observe";
  if (mode === "observe") {
    const shadow = { ...facts, peers: borrowPeers(db, q.project, borrow, io.now(), !!policy?.remote?.agents, { exceptTask: q.taskId, observe: true }).map(peerFacts) };
    const proposed = finishFirst && policy?.remote?.agents ? reservedStartPlacement(shadow, reserveFinishing(db, q.project, shadow)) : placeFor(shadow, "write", "claude");
    reservations?.observe?.({ actual: placed.kind === "peer" ? `peer:${placed.peer}` : placed.kind,
      proposed: proposed.kind === "peer" ? `peer:${proposed.peer}` : proposed.kind });
  }
  // observe: only a start that goes ahead is recorded (PM 10:5x); a refused one waits on peers only too, so there is nothing to compare.
  const observeStart = (r: StartPlacement): StartPlacement => {
    if (priv !== "observe" || pin || r.where === "refused") return r;
    const only = peersOnly(all);
    const would = finishFirst && policy?.remote?.agents ? reservedStartPlacement(only, reserveFinishing(db, q.project, only, q.taskId)) : placeFor(only, "write", "claude");
    notePrivateStart(db, q.project, card, r.where === "peer" ? `peer:${r.peer}` : "local", would.kind === "peer" && repo ? `peer:${would.peer}` : "等", would.reason);
    return r;
  };
  if (peersFirst && !(placed.kind === "peer" && repo)) {
    return { where: "refused", reason: `${PRIVATE_ONLY_PEER}：${placed.kind === "peer" ? "项目目录 origin 不是 GitHub 仓库" : placed.reason}` };
  }
  if (placed.kind === "peer" && repo) return observeStart({ where: "peer", peer: placed.peer, repo, reason: placed.reason,
    ...(mode === "off" ? {} : { reservation: { mode, family: placed.family, maxOpen: policy?.remote?.agents ? null : borrow.find((b) => b.peer === placed.peer)!.maxOpen } }) });
  if (placed.kind === "wait") return { where: "refused", reason: placed.reason };
  if ((!policy?.remote?.agents && policy?.remote?.localPriority === "off") || !localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null).room) {
    return { where: "refused", reason: "本机不写代码或写槽已满，peer 写单名额已满或不可用" };
  }
  return observeStart({ where: "local", reason: placed.reason });
}
