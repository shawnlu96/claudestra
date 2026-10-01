/**
 * The planner's two placement hooks (i28-W5): a review node goes to the slot pool's pick, a card pinned to a peer never
 * starts writing anywhere else. Facts come from the snapshot; the decision itself is placeFor (scheduler-placement.ts).
 * Proto-1 peers keep the i28-R9 rule unchanged (poolTarget in overflow mode: only when local reviewers are full, Codex
 * only, one attempt per round), with its exact intent text, so a machine with no v2 peer plans as it did before W5.
 * tests/scheduler-placement-plan.test.ts, tests/scheduler-no-peer-parity.test.ts.
 */
import { resourceKey, resourcesOverlap, type AuthorFamily } from "./ledger-scheduler.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { lendRoleOf, PEER_PLACEMENT, placeFor, type PlaceRole, type PlacementFacts } from "./scheduler-placement.js";
import { isPoolIntent, POOL_RECIPIENT, poolTarget, type PoolFacts } from "./scheduler-pool-plan.js";
import { cardWorkerSlots } from "./scheduler-worker-slot.js";

const otherFamily = (f: AuthorFamily): AuthorFamily => f === "claude" ? "codex" : "claude";

/** The card's pin as start_node wrote it (`extra.placement`); anything but a `peer:<name>` string is no pin. */
export function cardPin(extra: Record<string, unknown> | undefined): string | null {
  const v = extra?.placement;
  return typeof v === "string" && v.startsWith(PEER_PLACEMENT) && v.length > PEER_PLACEMENT.length ? v : null;
}

function locksFree(s: PlannerSnapshot): boolean {
  const mine = s.fileGlobs.map(resourceKey);
  return !mine.includes(null) && !s.heldResources.some((h) => h.taskId !== s.task.id &&
    mine.some((r) => resourcesOverlap(r as string, resourceKey(h.resource) ?? h.resource.toLowerCase())));
}

export function snapshotPlacementFacts(s: PlannerSnapshot, since: number): PlacementFacts {
  const p = s.pool ?? null;
  const own = cardWorkerSlots(s.heldResources, s.task.id).length ? 1 : 0;
  const reviewers = p?.localReviewers ?? 0;
  // Before a PR exists (a pinned card's writing) the repo is the one start_node checked the grant against.
  const repo = p?.repo ?? (typeof s.task.extra?.repo === "string" ? s.task.extra.repo : null);
  return {
    remote: p?.remote ?? null, repo, pin: cardPin(s.task.extra), lastPeer: p?.lastPeer ?? null, writeLeasePeer: p?.writeLeasePeer ?? null,
    peers: (p?.peers ?? []).map((x) => ({ peer: x.peer, roles: x.roles ?? ["review"], open: x.open, v2: x.v2 ?? null })),
    local: { running: Math.max(0, s.workerCount - own) + reviewers, room: reviewers < s.maxWorkers },
    tried: s.intents.filter((i) => isPoolIntent(i) && i.causalSeq >= since && i.head === s.task.headSHA).map((i) => i.recipient!.slice(POOL_RECIPIENT.length)),
    locksFree: locksFree(s),
  };
}

/** i28-R9 for proto-1 peers only, as it was: the overflow rule whatever the configured mode now says. */
function legacyPool(s: PlannerSnapshot, p: PoolFacts, since: number): { peer: string; reason: string } | null {
  const peers = p.peers.filter((x) => !x.v2 && (x.roles ?? ["review"]).includes("review")).map(({ peer, open, maxOpen }) => ({ peer, open, maxOpen }));
  const t = poolTarget({ ...s, pool: { ...p, peers, remote: { ...p.remote, mode: "overflow" } } }, since);
  return t && { peer: t.peer, reason: `挂池：对抗式跨模型审查挂给 ${t.peer} 的 ${t.family} worker${t.rereview ? "（复验，同一 peer）" : ""}` };
}

/** Where this round's review goes when it is not local: `{peer, reason}` becomes a `peer:<name>` pool intent; null = local. */
export function reviewPlacement(s: PlannerSnapshot, since: number): { peer: string; reason: string } | null {
  const p = s.pool;
  if (!p || p.remote.mode === "off" || !p.remote.roles.includes("review")) return null;
  if (!s.workflow || s.workflow.template === "security" || s.reviewer || !s.task.headSHA) return null;
  const family = otherFamily(s.workflow.authorFamily);
  const placed = placeFor(snapshotPlacementFacts(s, since), "review", family);
  if (placed.kind === "peer") return { peer: placed.peer, reason: `挂池：对抗式跨模型审查挂给 ${placed.peer} 的 ${family} worker（${placed.reason}）` };
  return legacyPool(s, p, since);
}

/** A card pinned to a peer never gets a local author session or work order; until the peer can take it, it waits. */
export function pinnedWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">): PlannerDecision | null {
  if (!cardPin(s.task.extra) || !s.workflow) return null;
  const placed = placeFor(snapshotPlacementFacts(s, since), role, s.workflow.authorFamily);
  // Handing writing to a peer is W8's lend-dispatch path; until it exists a placeable pin waits rather than going local.
  const why = placed.kind === "peer" ? `${lendRoleOf(role)} 单还不能派给 peer（远端写代码等 W8）` : placed.reason;
  return { kind: "wait", code: "placement_pinned", reason: why };
}

/**
 * Read-only view for `ledger lend-orders` (i28-W5): where the card's current node would be placed now and why. Same hooks
 * as the planner, so it cannot disagree with what the next pass does; stages without a placement say so.
 */
export function explainPlacement(s: PlannerSnapshot): { role: PlaceRole | null; where: string; reason: string } {
  const since = s.events.findLast((e) => e.kind === "stage" && e.data.to === s.task.stage)?.seq ?? s.events.find((e) => e.kind === "task")?.seq ?? 0;
  if (!s.workflow) return { role: null, where: "local", reason: "不是自动卡，PM 手动派" };
  if (s.task.stage === "review") {
    const peer = reviewPlacement(s, since);
    if (peer) return { role: "review", where: `${POOL_RECIPIENT}${peer.peer}`, reason: peer.reason };
    const why = !s.pool ? "没有借入信息" : s.reviewer ? "本卡已有审查 session，复审沿用" : s.workflow.template === "security" ? "安全卡只在本机审"
      : placeFor(snapshotPlacementFacts(s, since), "review", otherFamily(s.workflow.authorFamily)).reason;
    return { role: "review", where: "local", reason: why };
  }
  if (!["spec", "build", "fix"].includes(s.task.stage)) return { role: null, where: "-", reason: `${s.task.stage} 阶段不放置` };
  const role = s.task.stage === "fix" ? "fix" : "write";
  const pinned = pinnedWork(s, since, role);
  if (pinned && pinned.kind === "wait") return { role, where: cardPin(s.task.extra) as string, reason: `等：${pinned.reason}` };
  return { role, where: "local", reason: placeFor(snapshotPlacementFacts(s, since), role, s.workflow.authorFamily).reason };
}
