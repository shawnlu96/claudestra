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

export type StartPlacement = { where: "local"; reason: string } | { where: "peer"; peer: string; repo: string; reason: string } | { where: "refused"; reason: string };

export interface StartPlacementIO {
  /** scheduler.json's policy for the project; null = not listed. */
  policy(project: string): { remote: RemotePolicy | null; maxWorkers: number } | null;
  borrow(): Promise<readonly BorrowEntry[]>;
  /** GitHub owner/repo of the project directory's origin; null = not a GitHub remote. */
  originRepo(dir: string): Promise<string | null>;
  now(): number;
}

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

function locksFree(db: Database, project: string, globs: readonly string[]): boolean {
  const mine = globs.map(resourceKey);
  const held = db.query("SELECT resource FROM scheduler_resources WHERE project = ?").all(project) as { resource: string }[];
  return !mine.includes(null) && !held.some((h) => mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())));
}

export async function startPlacement(db: Database, io: StartPlacementIO,
  q: { project: string; repoDir: string; fileGlobs: readonly string[]; want: "auto" | `peer:${string}` }, finishFirst = false): Promise<StartPlacement> {
  const pin = q.want === "auto" ? null : q.want;
  const policy = io.policy(q.project);
  let borrow: readonly BorrowEntry[] = [];
  let repo: string | null = null;
  try {
    [borrow, repo] = await Promise.all([io.borrow(), io.originRepo(q.repoDir)]);
  } catch (e) {
    if (pin) return { where: "refused", reason: `读借入名单 / 仓库地址失败：${(e as Error).message}` };
    const refusal = localFamilyRefusal({ remote: policy?.remote ?? null }, "write", "claude");
    if (refusal && !policy?.remote?.agents) return { where: "refused", reason: refusal };
    if ((!policy?.remote?.agents && policy?.remote?.localPriority === "off")) return { where: "refused", reason: `本机不写代码，读借入名单失败：${(e as Error).message}` };
    if (!localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null).room) return { where: "refused", reason: "本机写槽已满，且无法确认 peer 空位" };
    return { where: "local", reason: `读借入名单 / 仓库地址失败，放本机：${(e as Error).message}` };
  }
  const facts: PlacementFacts = {
    remote: policy?.remote ?? null, peers: borrowPeers(db, q.project, borrow, io.now(), !!policy?.remote?.agents).map(peerFacts),
    repo, local: localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null), pin, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: locksFree(db, q.project, q.fileGlobs),
  };
  // Only automatic admission opts in; the PM's manual start_node placement keeps its explicit choice.
  const placed = finishFirst && policy?.remote?.agents ? reservedStartPlacement(facts, reserveFinishing(db, q.project, facts)) : placeFor(facts, "write", "claude");
  if (placed.kind === "peer" && repo) return { where: "peer", peer: placed.peer, repo, reason: placed.reason };
  if (placed.kind === "wait") return { where: "refused", reason: placed.reason };
  if ((!policy?.remote?.agents && policy?.remote?.localPriority === "off") || !localLoad(db, q.project, policy?.maxWorkers ?? 0, policy?.remote ?? null).room) {
    return { where: "refused", reason: "本机不写代码或写槽已满，peer 写单名额已满或不可用" };
  }
  return { where: "local", reason: placed.reason };
}
