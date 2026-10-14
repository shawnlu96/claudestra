/**
 * Card ids the shared-ledger scrub would refuse (shared-ledger-scrub.ts sharedLedgerValueBlocked, no rule of its own).
 * Such an id is uploaded as sourceTaskId / bindings taskId, and a feature keeps every card it ever bound, so one bad id
 * would block that feature's mirror for good: start_node and new DAG nodes refuse it up front (tests/dag-tools-start-id-gate.test.ts).
 */
import { hostname, userInfo } from "node:os";
import type { DagNode } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { sharedLedgerValueBlocked, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

export const CARD_ID_BLOCKED_HINT = "会被外发闸当随机串，换一个更短的 key（卡号总长 31 以内，或去掉数字 / 大写）";

/** The identity part of the mirror loop's scrub context (dag-write-scrub.ts realScrub); heads never matter for an id. */
const localIdScrub = (): SharedLedgerScrubContext => ({ identity: { username: userInfo().username, hostname: hostname() } });

/** Whether an upload would be refused for carrying this card id. */
export const cardIdBlocked = (taskId: string, scrub: SharedLedgerScrubContext = localIdScrub()): boolean =>
  sharedLedgerValueBlocked(taskId, scrub, "sourceTaskId");

/** start_node: the refusal text for a card id an upload would refuse, else null. */
export function cardIdGate(taskId: string, scrub?: SharedLedgerScrubContext): string | null {
  return cardIdBlocked(taskId, scrub) ? `卡号 ${taskId} ${CARD_ID_BLOCKED_HINT}` : null;
}

/**
 * New DAG nodes (fresh, no card bound yet): the card start_node would open is `<cardSlug>-<key>`; refuse the whole write
 * when any of them would be refused. Bound nodes keep the card they have; carried-over nodes are not judged again.
 */
export function rejectBlockedNodeIds<T extends Pick<DagNode, "key" | "cardSlug" | "taskId">>(nodes: T[], fresh: (n: T) => boolean,
  scrub?: SharedLedgerScrubContext): T[] {
  const bad = nodes.filter((n) => fresh(n) && !n.taskId && n.cardSlug !== undefined && cardIdBlocked(`${n.cardSlug}-${n.key}`, scrub));
  if (bad.length) {
    throw new LedgerError("invalid", `新节点的卡号${CARD_ID_BLOCKED_HINT}，整次写入拒绝：${bad.map((n) => `节点 ${n.key}（卡号 ${n.cardSlug}-${n.key}）`).join("；")}`);
  }
  return nodes;
}
