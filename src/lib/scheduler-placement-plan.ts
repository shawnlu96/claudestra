/**
 * The planner's two placement hooks (i28-W5): a review node and a build / fix node (i28-W9) go to the slot pool's pick; a
 * card pinned to a peer never starts writing anywhere else. Facts come from the snapshot; the decision is placeFor
 * (scheduler-placement.ts). Each hook answers a peer, a wait (pin / write lease / local tier off), or null = local as before.
 * Proto-1 peers keep the i28-R9 rule unchanged (poolTarget in overflow mode: only when local reviewers are full, Codex
 * only, one attempt per round), with its exact intent text, so a machine with no v2 peer plans as it did before W5.
 * tests/scheduler-placement-plan.test.ts, tests/scheduler-no-peer-parity.test.ts.
 */
import { resourceKey, resourcesOverlap, type AuthorFamily } from "./ledger-scheduler.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { PEER_PLACEMENT, peerFamily, placeFor, type PeerFacts, type PlaceRole, type PlacementFacts } from "./scheduler-placement.js";
import { isPoolIntent, POOL_RECIPIENT, poolTarget, type PoolFacts } from "./scheduler-pool-plan.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";

const otherFamily = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";

/** The card's pin as start_node wrote it (`extra.placement`); anything but a `peer:<name>` string is no pin. */
function cardPin(extra: Record<string, unknown> | undefined): string | null {
  const v = extra?.placement;
  return typeof v === "string" && v.startsWith(PEER_PLACEMENT) && v.length > PEER_PLACEMENT.length ? v : null;
}

function locksFree(s: PlannerSnapshot): boolean {
  const mine = s.fileGlobs.map(resourceKey);
  return !mine.includes(null) && !s.heldResources.some((h) => h.taskId !== s.task.id &&
    mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())));
}

/** borrowPeers' row as placeFor reads it; start_node uses it too, so neither entry can drop a field (the tier) the other keeps. */
export const peerFacts = (x: PoolFacts["peers"][number]): PeerFacts =>
  ({ peer: x.peer, roles: x.roles ?? ["review"], open: x.open, v2: x.v2 ?? null, ...(x.priority ? { priority: x.priority } : {}) });

/** room per role: a review needs a reviewer under the cap; writing needs the card's own worker slot or a free one (dispatchWork's gate). */
function snapshotPlacementFacts(s: PlannerSnapshot, since: number, role: PlaceRole): PlacementFacts {
  const p = s.pool ?? null;
  const own = cardWorkerSlots(s.heldResources, s.task.id).length ? 1 : 0;
  const reviewers = p?.localReviewers ?? 0;
  // Before a PR exists (a pinned card's writing) the repo is the one start_node checked the grant against.
  const repo = p?.repo ?? (typeof s.task.extra?.repo === "string" ? s.task.extra.repo : null);
  return {
    remote: p?.remote ?? null, repo, pin: cardPin(s.task.extra), lastPeer: p?.lastPeer ?? null, writeLeasePeer: p?.writeLeasePeer ?? null,
    peers: (p?.peers ?? []).map(peerFacts),
    local: { running: (p?.localWriters ?? Math.max(0, s.workerCount - own)) + reviewers,
      room: role === "review" ? reviewers < s.maxWorkers : !!own || (s.workerCount < s.maxWorkers && !!s.freeWorkerSlot) },
    tried: s.intents.filter((i) => isPoolIntent(i) && i.causalSeq >= since && i.head === s.task.headSHA).map((i) => i.recipient!.slice(POOL_RECIPIENT.length)),
    locksFree: locksFree(s),
  };
}

/**
 * i28-R9 for proto-1 peers only, as it was: the overflow rule whatever the configured mode now says. An `off` peer is out here
 * too, and with this machine `off` its reviewers count as full, so the overflow is the only way a review leaves.
 */
function legacyPool(s: PlannerSnapshot, p: PoolFacts, since: number): { peer: string; reason: string } | null {
  const peers = p.peers.filter((x) => !x.v2 && x.priority !== "off" && (x.roles ?? ["review"]).includes("review")).map(({ peer, open, maxOpen }) => ({ peer, open, maxOpen }));
  const localReviewers = p.remote.localPriority === "off" ? Math.max(p.localReviewers, s.maxWorkers) : p.localReviewers;
  const t = poolTarget({ ...s, pool: { ...p, peers, localReviewers, remote: { ...p.remote, mode: "overflow" } } }, since);
  return t && { peer: t.peer, reason: `挂池：对抗式跨模型审查挂给 ${t.peer} 的 ${t.family} worker${t.rereview ? "（复验，同一 peer）" : ""}` };
}

/** Not local: a peer (becomes a `peer:<name>` pool intent) or a wait; null = this machine, as before W5. */
/** escalate = the write-lease holder already failed this fix once: only PM can move it (reclaim or re-offer). */
export type Away = { peer: string; reason: string } | { wait: string; code?: string } | { escalate: string } | null;

const LOCAL_OFF = "scheduler.json remote.localPriority = off：本机不接审查（已有的审查 session 留着），等本机重新启用或 peer 接";

/**
 * Where this round's review goes when it is not local. With this machine `off` a review that would stay here (a bound
 * reviewer's re-review, a security card, no review role lent) waits instead; remote.mode off still means local only.
 */
export function reviewPlacement(s: PlannerSnapshot, since: number): Exclude<Away, { escalate: string }> {
  const p = s.pool;
  if (!p || p.remote.mode === "off") return null;
  return poolReview(s, p, since) ?? (p.remote.localPriority === "off" && s.workflow ? { wait: LOCAL_OFF } : null);
}

function poolReview(s: PlannerSnapshot, p: PoolFacts, since: number): Exclude<Away, { escalate: string }> {
  if (!p.remote.roles.includes("review")) return null;
  if (!s.workflow || s.workflow.template === "security" || s.reviewer || !s.task.headSHA) return null;
  const family = otherFamily(s.workflow.authorFamily);
  const placed = placeFor(snapshotPlacementFacts(s, since, "review"), "review", family);
  if (placed.kind === "peer") return { peer: placed.peer, reason: `挂池：对抗式跨模型审查挂给 ${placed.peer} 的 ${family} worker（${placed.reason}）` };
  const legacy = legacyPool(s, p, since);
  if (placed.kind === "wait") return legacy ?? { wait: placed.reason };
  return legacy && p.remote.reviewFirst?.length ? { ...legacy, reason: `${legacy.reason}（${placed.reason}）` } : legacy;
}

/**
 * With this machine `off` an unpinned card's restate waits wherever its writing would not land here: no peer takes a restate
 * order (take_order is build / fix only) and v3 needs the restate text, so it can neither go along nor be skipped.
 * placeFor's local (remote.mode off) still restates here, as build would write here. tests/scheduler-placement-off-restate.test.ts.
 */
function offRestate(facts: PlacementFacts, family: AuthorFamily): Away {
  const placed = placeFor(facts, "write", family);
  if (placed.kind === "local") return null;
  return { code: "placement", wait: placed.kind === "wait" ? placed.reason
    : `${LOCAL_OFF_RESTATE}；写单可派给 ${placed.peer}，但 peer 不接复述单：等本机重新启用，或 PM 用 start_node placement=peer:${placed.peer} 固定放置` };
}

const LOCAL_OFF_RESTATE = "scheduler.json remote.localPriority = off：本机不复述新卡";

/**
 * Where a build / fix order goes when it is not local (i28-W9). A pinned card never gets a local author session or work
 * order: until its peer can take it, it waits (spec stage included: restate is skipped for it, start_node is the approval).
 */
export function remoteWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">): Away {
  if (!s.workflow) return null;
  const pinned = cardPin(s.task.extra);
  if (!pinned && s.task.stage === "spec") {
    return s.pool?.remote.localPriority === "off" ? offRestate(snapshotPlacementFacts(s, since, "write"), s.workflow.authorFamily) : null;
  }
  if (!pinned && s.task.stage !== "build" && s.task.stage !== "fix") return null;
  const facts = snapshotPlacementFacts(s, since, role);
  const lease = role === "fix" && facts.remote?.mode !== "off" && facts.remote?.roles.includes("write") ? facts.writeLeasePeer : null;
  if (lease && facts.tried.includes(lease)) {
    return { escalate: `修复单派回写租约方 ${lease} 这一轮没成（撤回 / 退回 / 拒挂），写租约还在它那里：PM 核对后 ledger lend-reclaim ${s.task.id} 或 lend-reoffer` };
  }
  const placed = placeFor(facts, role, s.workflow.authorFamily);
  const code = pinned ? "placement_pinned" : "placement";
  if (pinned && s.task.stage === "spec") return { code, wait: placed.kind === "peer" ? "固定放在 peer 的卡不在本机复述，等 start_node 把它推过复述" : placed.reason };
  if (placed.kind === "peer") return { peer: placed.peer, reason: `挂池：${role === "fix" ? "修复" : "开工"}单派给 ${placed.peer} 的 ${placed.family} worker（${placed.reason}）` };
  return placed.kind === "wait" ? { code, wait: placed.reason } : null;
}

/** The family a pool intent's order runs in: review = across from the head's writer, writing = the peer's first free family. */
export function orderFamily(s: PlannerSnapshot, peer: string, role: PlaceRole): AuthorFamily | null {
  if (!s.workflow) return null;
  if (role === "review") return otherFamily(s.workflow.authorFamily);
  const p = s.pool?.peers.find((x) => x.peer === peer);
  return p ? peerFamily(peerFacts(p), role, s.workflow.authorFamily) : null;
}

/**
 * Read-only view for `ledger lend-orders` (i28-W5): where the card's current node would be placed now and why. Same hooks
 * as the planner, so it cannot disagree with what the next pass does; stages without a placement say so.
 */
export function explainPlacement(s: PlannerSnapshot): { role: PlaceRole | null; where: string; reason: string } {
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? s.events.find((e) => e.kind === "task")?.seq ?? 0;
  if (!s.workflow) return { role: null, where: "local", reason: "不是自动卡，PM 手动派" };
  if (s.task.stage === "review") {
    // A live review intent is where the planner waits; recomputing would count its peer as tried and point elsewhere.
    const live = s.intents.filter((i) => i.action === "review" && i.causalSeq >= since).at(-1);
    if (live && live.status !== "cancelled") {
      const where = isPoolIntent(live) ? live.recipient! : "local";
      return { role: "review", where, reason: `已派给 ${live.recipient}，等台账结果（${live.status}）` };
    }
    const away = reviewPlacement(s, since);
    if (away && "peer" in away) return { role: "review", where: `${POOL_RECIPIENT}${away.peer}`, reason: away.reason };
    if (away) return { role: "review", where: "-", reason: `等：${away.wait}` };
    const why = !s.pool ? "没有借入信息" : s.reviewer ? "本卡已有审查 session，复审沿用" : s.workflow.template === "security" ? "安全卡只在本机审"
      : placeFor(snapshotPlacementFacts(s, since, "review"), "review", otherFamily(s.workflow.authorFamily)).reason;
    return { role: "review", where: "local", reason: why };
  }
  if (!["spec", "build", "fix"].includes(s.task.stage)) return { role: null, where: "-", reason: `${s.task.stage} 阶段不放置` };
  const role = s.task.stage === "fix" ? "fix" : "write";
  const sent = s.intents.filter((i) => i.action === "dispatch" && i.causalSeq >= since).at(-1);
  if (sent && sent.status !== "cancelled" && isPoolIntent(sent)) return { role, where: sent.recipient!, reason: `已派给 ${sent.recipient}，等台账结果（${sent.status}）` };
  const away = remoteWork(s, since, role);
  if (away && "peer" in away) return { role, where: `${POOL_RECIPIENT}${away.peer}`, reason: away.reason };
  if (away) return { role, where: cardPin(s.task.extra) ?? "-", reason: "wait" in away ? `等：${away.wait}` : `交 PM：${away.escalate}` };
  return { role, where: "local", reason: placeFor(snapshotPlacementFacts(s, since, role), role, s.workflow.authorFamily).reason };
}
