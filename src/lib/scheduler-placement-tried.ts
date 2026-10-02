/** Temporary push refusals are waits, not spent attempts; ledger events also cover orders cancelled before this code shipped. */
import { isTemporaryLendRefusal } from "./ledger-lend-queue.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { isPoolIntent, POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { placeFor, type PlacementFacts, type PlaceRole } from "./scheduler-family-pick.js";
import type { Placement } from "./scheduler-placement.js";
import type { AuthorFamily } from "./ledger-scheduler.js";

/** Only the exact unclaimed push-withdrawal receipt qualifies; arbitrary cancellation text or a claimed order does not. */
function refusedAt(s: PlannerSnapshot, i: SchedulerIntent, peer: string): number | null {
  if (i.status !== "cancelled") return null;
  const link = s.events.find((e) => e.kind === "scheduler" && e.dedupKey === `scheduler:${i.id}:pool` &&
    e.data.id === i.id && e.data.peer === peer);
  const orderId = link?.data.orderId;
  if (typeof orderId !== "string") return null;
  const notes = s.events.filter((e) => e.kind === "note" && e.target === i.taskId &&
    (e.data.lend as Record<string, unknown> | undefined)?.orderId === orderId);
  if (notes.some((e) => (e.data.lend as Record<string, unknown>).op === "claim")) return null;
  const cancelled = notes.findLast((e) => {
    const lend = e.data.lend as Record<string, unknown>;
    return lend.op === "cancel" && lend.from === "pooled" && lend.peer === peer;
  });
  const prefix = `出借：撤单（原状态 pooled）：推送被 ${peer} 拒收（`;
  if (!cancelled || !cancelled.text.startsWith(prefix) || !cancelled.text.endsWith("）")) return null;
  const code = cancelled.text.slice(prefix.length, -1);
  return isTemporaryLendRefusal(code) ? cancelled.ts : null;
}

interface Retry { peer: string; gate: string | null }
export interface RetryPlacementFacts extends PlacementFacts { retries: Retry[] }

/** A permanent/claimed attempt wins over any temporary ones; repeated refusals restart the delay at the latest receipt. */
export function placementHistory(s: PlannerSnapshot, since: number): Pick<RetryPlacementFacts, "tried" | "retries"> {
  const tried = new Set<string>(), temporary = new Map<string, number>();
  for (const i of s.intents) {
    if (!isPoolIntent(i) || i.causalSeq < since || i.head !== s.task.headSHA) continue;
    const peer = i.recipient!.slice(POOL_RECIPIENT.length);
    const knownClock = s.pool?.now !== undefined && s.pool.peers.some((p) => p.peer === peer && p.helloAt !== undefined);
    const at = knownClock ? refusedAt(s, i, peer) : null;
    if (at === null) tried.add(peer);
    else temporary.set(peer, Math.max(temporary.get(peer) ?? -Infinity, at));
  }
  for (const peer of tried) temporary.delete(peer);
  const retries = [...temporary].map(([peer, at]) => {
    const helloAt = s.pool!.peers.find((p) => p.peer === peer)!.helloAt!;
    const gate = s.pool!.now! - at < 120_000 ? "临时拒收后至少等 2 分钟" : helloAt <= at ? "等拒收后的新 hello" : null;
    return { peer, gate };
  });
  return { tried: [...tried], retries };
}

/** Apply debounce before ranking (including pins); when no remote can take a retry, keep placement waiting for capacity. */
export function placeWithRetries(f: RetryPlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  const peers = f.peers.map((p) => {
    const gate = f.retries.find((r) => r.peer === p.peer)?.gate;
    return gate && p.v2 ? { ...p, v2: { ...p.v2, why: gate } } : p;
  });
  const facts = { ...f, peers };
  const placed = placeFor(facts, role, family);
  if (!f.remote || f.remote.mode === "off" || !f.remote.roles.includes(role === "review" ? "review" : "write")) return placed;
  if (placed.kind === "peer" || !f.retries.length) return placed;
  // An eligible remote losing to the local tier is normal placement, not a capacity wait.
  if (placeFor({ ...facts, remote: { ...f.remote, localPriority: "off" } }, role, family).kind === "peer") return placed;
  return { kind: "wait", reason: f.retries.map((r) => `等 ${r.peer} 空位${r.gate ? `（${r.gate}）` : "（临时拒收，等可用 hello）"}`).join("；") };
}
