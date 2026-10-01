/**
 * Shared-pool choice for a review node (i28-R9), pure: which peer, if any, gets this round's review instead of a local
 * session. Called only when the node has no live intent. At most one pool attempt per card round and head: after a
 * timeout, a release or a refused offer the round goes local, so a peer that never claims cannot loop the card.
 * A re-review after a pooled round goes back to the same peer first (identity = peer name; each order is a fresh
 * one-shot worker); if that peer cannot take it, the planner falls through to a local cross-family session.
 * tests/scheduler-pool.test.ts.
 */
import type { LendRole } from "./lend-config.js";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { RemotePolicy } from "./scheduler-config.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import type { PeerFacts } from "./scheduler-placement.js";

/** Pool intents are review intents addressed to `peer:<name>`; the merge gate compares this exact string with the verdict's reviewer. */
export const POOL_RECIPIENT = "peer:";
export const isPoolIntent = (i: Pick<SchedulerIntent, "action" | "recipient">): boolean =>
  i.action === "review" && !!i.recipient?.startsWith(POOL_RECIPIENT);

/** Families a borrowed worker may review in (mirrors lend-offer's v1 slice: only Codex is lent). */
const LENDABLE_FAMILIES: readonly AuthorFamily[] = ["codex"];

/** `roles` absent = review only (how R9 built the list); `v2` absent or null = proto 1 (no hello on file), i28-W5. */
interface PoolPeer { peer: string; open: number; maxOpen: number; roles?: readonly LendRole[]; v2?: PeerFacts["v2"] }
export interface PoolFacts {
  remote: RemotePolicy;
  /** Active local reviewer sessions on the project's other cards; review holds no worker slot, so this is its capacity. */
  localReviewers: number;
  /** Valid borrow entries that take this project's review, in lend.json order, with their live order count. */
  peers: readonly PoolPeer[];
  /** GitHub owner/repo of the card's PR; the peer only gets coordinates, so no repo = no pool. */
  repo: string | null;
  /** Peer of the newest answered pool order on this card (a re-review goes back to it). */
  lastPeer: string | null;
  /** Peer of the card's newest claimed / answered write or fix order (a fix goes back to it first, i28-W5). */
  writeLeasePeer?: string | null;
}

export interface PoolTarget { peer: string; family: AuthorFamily; rereview: boolean }

const otherFamily = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";

/** `since` = the seq the card entered its current stage; intents before it belong to an earlier round. */
export function poolTarget(s: PlannerSnapshot, since: number): PoolTarget | null {
  const p = s.pool;
  if (!p || p.remote.mode === "off" || !p.remote.roles.includes("review")) return null;
  if (!s.workflow || s.workflow.template === "security" || s.reviewer || !p.repo) return null;
  const head = s.task.headSHA;
  if (!head || s.intents.some((i) => isPoolIntent(i) && i.causalSeq >= since && i.head === head)) return null;
  const family = otherFamily(s.workflow.authorFamily);
  if (!LENDABLE_FAMILIES.includes(family)) return null;
  const rereview = p.lastPeer !== null;
  if (!rereview && p.remote.mode === "overflow" && p.localReviewers < s.maxWorkers) return null;
  const pick = p.peers.find((x) => (!rereview || x.peer === p.lastPeer) && x.open < x.maxOpen);
  return pick ? { peer: pick.peer, family, rereview } : null;
}
