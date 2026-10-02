/** Temporary push refusals are waits, not spent attempts; ledger events also cover orders cancelled before this code shipped. */
import { isTemporaryLendRefusal } from "./ledger-lend-queue.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import { isPoolIntent, POOL_RECIPIENT } from "./scheduler-pool-plan.js";
import { placeFor, peerFamily, type PlacementFacts, type PlaceRole } from "./scheduler-family-pick.js";
import { peerRefusal, type PeerFacts, type Placement } from "./scheduler-placement.js";
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

/** Spent attempts exclude unpinned candidates; the latest outcome independently gates pins after a temporary refusal. */
export function placementHistory(s: PlannerSnapshot, since: number): Pick<RetryPlacementFacts, "tried" | "retries"> {
  const tried = new Set<string>(), temporary = new Map<string, number>();
  for (const i of [...s.intents].sort((a, b) => a.eventSeq - b.eventSeq)) {
    if (!isPoolIntent(i) || i.causalSeq < since || i.head !== s.task.headSHA) continue;
    const peer = i.recipient!.slice(POOL_RECIPIENT.length);
    const knownClock = s.pool?.now !== undefined && s.pool.peers.some((p) => p.peer === peer && p.helloAt !== undefined);
    const at = knownClock ? refusedAt(s, i, peer) : null;
    if (at === null) {
      tried.add(peer);
      temporary.delete(peer);
    } else temporary.set(peer, at);
  }
  const retries = [...temporary].map(([peer, at]) => {
    const helloAt = s.pool!.peers.find((p) => p.peer === peer)!.helloAt!;
    const gate = s.pool!.now! - at < 120_000 ? "临时拒收后至少等 2 分钟" : helloAt <= at ? "等拒收后的新 hello" : null;
    return { peer, gate };
  });
  return { tried: [...tried], retries };
}

/** Capacity's human-readable reasons originate in peerCapacity; unknown reasons must retain the normal fallback. */
function capacityReason(why: string | null): boolean {
  return why === "对方今天的单数用完了" || /^hello 超过 \d+ 秒没更新$/.test(why ?? "");
}

/** Check permissions without capacity masking a revoked role/repo, and keep family selection identical to placement. */
function retryPeer(f: PlacementFacts, p: PeerFacts | undefined, role: PlaceRole, family: AuthorFamily): PeerFacts | null {
  if (!p?.v2) return null;
  // Old snapshots only carry free slots: zero there could mean busy or paused, so keep treating it as capacity.
  if (p.v2.familyTotals && !peerFamily({ ...p, v2: { ...p.v2, slots: p.v2.familyTotals } }, role, family, f.remote?.writeFamilies)) return null;
  const policy = { ...p, v2: { ...p.v2, slots: { claude: 1, codex: 1 }, why: capacityReason(p.v2.why) ? null : p.v2.why } };
  if (peerRefusal({ ...f, locksFree: true }, policy, role, family)) return null;
  const selected = peerFamily(p, role, family, f.remote?.writeFamilies);
  return { ...p, v2: { ...p.v2, slots: { claude: selected === "claude" ? p.v2.slots.claude : 0,
    codex: selected === "codex" ? p.v2.slots.codex : 0 } } };
}

/** Apply debounce before ranking (including pins); when no remote can take a retry, keep placement waiting for capacity. */
export function placeWithRetries(f: RetryPlacementFacts, role: PlaceRole, family: AuthorFamily): Placement {
  const retryable = f.retries.flatMap((r) => {
    const p = retryPeer(f, f.peers.find((p) => p.peer === r.peer), role, family);
    return p ? [{ ...r, why: peerRefusal({ ...f, locksFree: true }, p, role, family) }] : [];
  });
  const peers = f.peers.map((p) => {
    const r = retryable.find((r) => r.peer === p.peer);
    const why = r?.gate ? [r.why, r.gate].filter(Boolean).join("；") : null;
    return why && p.v2 ? { ...p, v2: { ...p.v2, why } } : p;
  });
  const tried = [...new Set([...f.tried, ...f.retries.filter((r) => !retryable.some((x) => x.peer === r.peer)).map((r) => r.peer)])];
  const facts = { ...f, peers, tried };
  const placed = placeFor(facts, role, family);
  if (!f.remote || f.remote.mode === "off" || !f.remote.roles.includes(role === "review" ? "review" : "write")) return placed;
  if (placed.kind === "peer") return placed;
  const pinned = f.pin && role !== "review";
  const waiting = retryable.filter((r) => pinned ? f.pin === `peer:${r.peer}` : !tried.includes(r.peer));
  if (!waiting.length) return placed;
  if (role !== "review" && !f.locksFree) return { kind: "wait", reason: "文件锁被别的卡占着" };
  // An eligible remote losing to the local tier is normal placement, not a capacity wait.
  if (placeFor({ ...facts, remote: { ...f.remote, localPriority: "off" } }, role, family).kind === "peer") return placed;
  const blocked = waiting.filter((r) => r.why || r.gate);
  return blocked.length ? { kind: "wait", reason: blocked.map((r) => `等 ${r.peer} 空位（${[r.why, r.gate].filter(Boolean).join("；")}）`).join("；") } : placed;
}
