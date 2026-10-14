/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery, the planner's half (pure): in the agents pool a fix whose write-lease holder has
 * been unable to take it for remote.fixReassignMin (default 20) of continuous holder-wait is relayed to another lawful peer with a free
 * slot of the card's writing family — i28-RA1's relay (lend-fix-reassign.ts), which returned null for the pool. Nothing here relaxes a
 * gate: the candidate passes poolPeerRefusal as if it held the lease (hello, grant, repo, slots, file locks), the tried rule, the live
 * order / unknown effect hold, the one-relay-per-hour escalation and fixLocalSwap's priority (one handover per card and round). The
 * relay itself is the existing offer-side transaction (lend-fix-reassign-start.ts relayOffer: the old lease ends before the new peer's
 * order is cut, from the PR's verified head, on its own lend/ branch, base main), which re-plans with the switch read again.
 * Policy: recovery-policy key peerLeaseRecovery (off / observe / on; default observe). off = this branch is never taken (the pool
 * path is byte-for-byte the old one); observe = the holder-wait clock runs and the would-be relay (or why there is none) is tagged on
 * the wait so the tick records one deduplicated note; on = the relay. tests/recovery-peer-lease*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AuthorFamily, SchedulerIntent } from "./ledger-scheduler.js";
import type { PlannerSnapshot } from "./scheduler-plan.js";
import type { PeerFacts, PlacementFacts } from "./scheduler-placement.js";
import { poolPeerRefusal } from "./scheduler-agent-pool.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { FIX_LEASE_WAIT_CODE, FIX_RELAY_OP, FIX_RELAY_WINDOW_MS, leaseWaitOpen } from "./lend-fix-reassign-event.js";
import { FIX_REASSIGN_DEFAULT_MIN } from "./lend-fix-reassign-config.js";
import type { RelayAway } from "./lend-fix-reassign.js";
import type { LocalSwapFact } from "./recovery-fix-local-swap.js";
import type { RemoteHead } from "./order-deliver.js";

export const PEER_LEASE_KEY = "peerLeaseRecovery" as const;
const LIVE = ["pending", "submitted", "unknown"];

export interface PeerLeasePorts {
  policy?: RecoveryPolicyPort;
  /** The family a new local author would run in now (frozen at handover); absent = scheduler-local-author.ts launch's own choice. */
  authorRuntime?: (project: string) => AuthorFamily | Promise<AuthorFamily>;
  /** The lease branch's remote head before a handover (recovery-peer-lease-head.ts); absent = `git ls-remote`. */
  remoteHead?: (repo: string, branch: string) => Promise<RemoteHead>;
}
const ports = new WeakMap<Database, PeerLeasePorts>();
/** Same wiring pattern as setLocalSwapPorts: tests and the service inject ports per ledger. */
export const setPeerLeasePorts = (db: Database, p: PeerLeasePorts): void => void ports.set(db, p);
export const peerLeasePorts = (db: Database): PeerLeasePorts => ports.get(db) ?? {};
/** Read on every call (every snapshot, every tick, the offer's re-plan): switching back to off stops the next side effect. */
export const peerLeaseMode = (db: Database, project: string): RecoveryMode => (ports.get(db)?.policy ?? recoveryPolicy)(project, PEER_LEASE_KEY).mode;

/** What autoSnapshot attaches to a fix card: only the mode, so the planner stays pure and other snapshot builders mean off. */
interface PeerLeaseFact { mode: RecoveryMode }
export type PeerLeaseSnapshot = PlannerSnapshot & { peerLease?: PeerLeaseFact; localSwap?: LocalSwapFact };

/** Observe's tag on the holder wait; the tick turns it into one recovery_observe note (recovery-peer-lease-tick.ts). */
const OBSERVE_TAG = "［peerLeaseRecovery observe：";
const tag = (text: string): string => `${OBSERVE_TAG}${text}］`;
export function observedTag(reason: string): string | null {
  const at = reason.lastIndexOf(OBSERVE_TAG);
  return at < 0 || !reason.endsWith("］") ? null : reason.slice(at + OBSERVE_TAG.length, -1);
}

/** As if every peer had a free slot of the family: some other peer could take the fix once a slot frees up. */
const withRoom = (facts: PlacementFacts, family: AuthorFamily): PlacementFacts => ({ ...facts, peers: facts.peers.map((p) => p.v2
  ? { ...p, v2: { ...p.v2, slots: { ...p.v2.slots, [family]: Math.max(1, p.v2.slots[family] ?? 0) } } } : p) });

/** Why each other peer cannot take the relay, as poolPeerRefusal says it when it held the lease. */
function relayRefusals(facts: PlacementFacts, lease: string, family: AuthorFamily): { peer: string; why: string }[] {
  return facts.peers.filter((p) => p.peer !== lease).map((p) => ({ peer: p.peer,
    why: facts.tried.includes(p.peer) ? "本轮已试过" : poolPeerRefusal({ ...facts, writeLeasePeer: p.peer }, p, "fix", family) ?? "" }));
}

/** The pool peer the fix would be relayed to now in the card's family (least loaded, then borrow order), or null. */
function poolRelayCandidate(facts: PlacementFacts, lease: string, family: AuthorFamily): PeerFacts | null {
  const ok = new Set(relayRefusals(facts, lease, family).filter((r) => !r.why).map((r) => r.peer));
  const load = (p: PeerFacts) => p.v2?.familyBusy?.[family] ?? p.open;
  return facts.peers.map((p, order) => ({ p, order })).filter(({ p }) => ok.has(p.peer))
    .sort((a, b) => load(a.p) - load(b.p) || a.order - b.order)[0]?.p ?? null;
}

/** fixLocalSwap acting (or resuming) on this card under on: it owns the round's one handover. */
const localSwapOwns = (s: PeerLeaseSnapshot): boolean => !!s.localSwap?.candidate && s.localSwap.mode === "on" && (s.localSwap.ripe || s.localSwap.resumed);

/** A live intent of this fix window (any action: a local swap, a dispatch) or a stray pool order: no second writer. */
const liveWork = (s: PlannerSnapshot, since: number): boolean =>
  !!s.strayPoolOrders?.length || s.intents.some((i: SchedulerIntent) => i.causalSeq >= since && LIVE.includes(i.status));

/** Dedup key of one observed relay / refusal: card, spec, round, head, holder, the stretch's start and the outcome. */
export function relayObserveKey(taskId: string, s: { specRev: number; round: number; head: string }, lease: string, stretch: number, outcome: string): string {
  return `relay:${createHash("sha256").update(JSON.stringify([taskId, s.specRev, s.round, s.head, lease, stretch, outcome])).digest("hex").slice(0, 32)}`;
}

/**
 * agentPoolWork's hook when a fix with a write-lease holder must wait (scheduler-agent-pool-plan.ts). null = not this mechanism's
 * (off, no other borrowed peer, not a holder wait, no peer could ever take it): the caller's own wait stands unchanged. Otherwise relayAway's answers.
 */
export function poolRelayAway(s: PeerLeaseSnapshot, since: number, facts: PlacementFacts, lease: string, waitReason: string): RelayAway {
  const mode = s.peerLease?.mode ?? "off", now = s.pool?.now;
  if (mode === "off" || !s.workflow || !s.pool?.remote.agents || now === undefined || s.task.stage !== "fix" || !s.task.headSHA || !s.task.pr) return null;
  if (!facts.peers.some((p) => p.peer !== lease)) return null; // no other borrowed peer: nothing to relay to, the holder wait stands as is
  const family = s.workflow.authorFamily, tried = facts.tried.includes(lease);
  // A file lock blocks every peer alike: only the holder's own refusal (or its spent attempt this round) is a holder wait.
  if (!tried && !poolPeerRefusal({ ...facts, locksFree: true }, facts.peers.find((p) => p.peer === lease), "fix", family)) return null;
  const pick = poolRelayCandidate(facts, lease, family);
  if (tried && !pick && !poolRelayCandidate(withRoom(facts, family), lease, family)) return null;
  const hold = { code: FIX_LEASE_WAIT_CODE, wait: waitReason };
  const open = leaseWaitOpen(s.events, since);
  const min = s.pool.remote.fixReassignMin ?? FIX_REASSIGN_DEFAULT_MIN;
  if (!open || now - open.ts < min * 60_000) return hold;
  const waited = Math.floor((now - open.ts) / 60_000);
  const seen = (text: string) => mode === "observe" ? { ...hold, wait: `${waitReason}${tag(text)}` } : hold;
  if (!pick) {
    const why = relayRefusals(facts, lease, family).map((r) => `${r.peer}：${r.why}`).join("；") || "没有别的借入 peer";
    return seen(`等写租约方 ${lease} 已过阈值 ${min} 分钟，不改派——没有合法接力 peer（${why}）`);
  }
  if (liveWork(s, since)) return seen(`不改派——本卡还有未结的意图或池单（旧单活跃或效果不明）`);
  if (localSwapOwns(s)) return seen("不改派——fixLocalSwap 已接手本轮（同卡同轮只允许一个交接）");
  const last = s.events.findLast((e) => e.kind === "scheduler" && e.data.op === FIX_RELAY_OP && now - e.ts < FIX_RELAY_WINDOW_MS);
  if (last && mode === "observe") return seen(`本会交 PM——一小时内已自动改派过一次（${String(last.data.from)} → ${String(last.data.to)}）`);
  if (last) {
    return { escalate: `修复单等写租约方 ${lease} 已 ${waited} 分钟（${waitReason}），本卡一小时内已自动改派过一次（${String(last.data.from)} → ` +
      `${String(last.data.to)}），不再来回改派：PM 核对后 ledger lend-reclaim ${s.task.id} 或 lend-reoffer` };
  }
  if (mode === "observe") return seen(`本会改派给 ${pick.peer} 的 ${family}（写租约在 ${lease}，等待已过阈值 ${min} 分钟）`);
  return { peer: pick.peer, reason: `自动改派（池）：写租约在 ${lease}，它连续 ${waited} 分钟不能接（阈值 ${min}；${waitReason}）；` +
    `改派给 ${pick.peer} 的 ${family}，从 PR 当前 head 在它自己的出借分支上接力，新 PR 的 base 是 main` };
}
