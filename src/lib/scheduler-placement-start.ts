/**
 * start_node's placement (i28-W5): where a new card's writing goes, by the same placeFor the planner uses. `auto` picks
 * by load and lands local whenever no peer qualifies (before W8 always: remote.roles never holds write); `peer:<name>` is
 * a pin that must pass every hard constraint now or start_node refuses. Reading the config / borrow / origin repo is
 * injected; a failed read means no peer, never a guess. tests/dag-tools-placement.test.ts.
 */
import type { Database } from "bun:sqlite";
import { resourceKey, resourcesOverlap } from "./ledger-scheduler.js";
import type { BorrowEntry } from "./lend-config.js";
import type { RemotePolicy } from "./scheduler-config.js";
import { placeFor, PEER_PLACEMENT } from "./scheduler-placement.js";
import { borrowPeers, localReviewerCount, localWriterCount } from "./scheduler-pool-facts.js";

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

/** Load counts working executors (as the planner does); room is the worker-slot cap, which a card in review still holds. */
function localLoad(db: Database, project: string, maxWorkers: number) {
  const slots = db.query("SELECT DISTINCT taskId FROM scheduler_resources WHERE project = ? AND resource LIKE 'slot:%'").all(project).length;
  return { running: localWriterCount(db, project, null) + localReviewerCount(db, project, null), room: slots < maxWorkers };
}

function locksFree(db: Database, project: string, globs: readonly string[]): boolean {
  const mine = globs.map(resourceKey);
  const held = db.query("SELECT resource FROM scheduler_resources WHERE project = ?").all(project) as { resource: string }[];
  return !mine.includes(null) && !held.some((h) => mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())));
}

export async function startPlacement(db: Database, io: StartPlacementIO,
  q: { project: string; repoDir: string; fileGlobs: readonly string[]; want: "auto" | `peer:${string}` }): Promise<StartPlacement> {
  const pin = q.want === "auto" ? null : q.want;
  const policy = io.policy(q.project);
  let borrow: readonly BorrowEntry[] = [];
  let repo: string | null = null;
  try {
    [borrow, repo] = await Promise.all([io.borrow(), io.originRepo(q.repoDir)]);
  } catch (e) {
    if (pin) return { where: "refused", reason: `读借入名单 / 仓库地址失败：${(e as Error).message}` };
    return { where: "local", reason: `读借入名单 / 仓库地址失败，放本机：${(e as Error).message}` };
  }
  const placed = placeFor({
    remote: policy?.remote ?? null, peers: borrowPeers(db, q.project, borrow, io.now()).map((p) => ({ peer: p.peer, roles: p.roles ?? ["review"], open: p.open, v2: p.v2 ?? null })),
    repo, local: localLoad(db, q.project, policy?.maxWorkers ?? 0), pin, tried: [], lastPeer: null, writeLeasePeer: null, locksFree: locksFree(db, q.project, q.fileGlobs),
  }, "write", "claude");
  if (placed.kind === "peer" && repo) return { where: "peer", peer: placed.peer, repo, reason: placed.reason };
  if (placed.kind === "wait") return { where: "refused", reason: placed.reason };
  return { where: "local", reason: placed.reason };
}
