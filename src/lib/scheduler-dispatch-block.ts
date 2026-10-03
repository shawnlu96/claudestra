/**
 * Gate refusals persist across scheduler restarts. Only changed outbound material gets one more full-gate attempt;
 * assignment and workflow edits are not proof of takeover. Claims, reclaim and settled local dispatch are evidence.
 * Planner, placement and patrol share these event-derived facts. See tests/scheduler-dispatch-block.test.ts.
 */
import { restateFacts } from "./ledger-lend-relay.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import type { PlaceRole } from "./scheduler-placement.js";
import { explainPlacement, remoteWork, type Away } from "./scheduler-placement-plan.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";

/** Bump when the gate or forPeer (order-gate-heads.ts) can pass material it used to refuse: each standing block retries once. */
const GATE_HANDLER_VERSION = 3;
const GATE_BLOCK_CODE = "dispatch_blocked_gate";
const BLOCK_STAGES: readonly string[] = ["build", "fix"];
/** The pool step's receipt for an offer the ledger refused (ledger-scheduler-pool.ts refuse); only the gate's wording counts. */
const isGateReceipt = (r: string | null): boolean => !!r?.startsWith("未投递：出单被拒：") && r.includes("外发闸");

type Ev = LedgerEvent;
type Task = Pick<LedgerTask, "id" | "stage" | "round" | "specRev" | "headSHA">;

/** The seq the card entered its current stage (the planner's `since`); its creation when it never moved. */
const stageWindow = (task: Pick<LedgerTask, "stage">, events: readonly Ev[]): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? events.find((e) => e.kind === "task")?.seq ?? 0;

/** What a write order is made of, as far as the ledger records it; base-branch commits are deliberately not part of it. */
function gateMaterial(task: Task, events: readonly Ev[]): string {
  const review = events.findLast((e) => e.kind === "review")?.seq ?? 0;
  const facts = task.stage === "build" ? restateFacts(events, task.specRev) : null;
  const carried = facts && !facts.answered && facts.text ? facts.seq : 0;
  return `g${GATE_HANDLER_VERSION}:s${task.specRev}:r${task.round}:h${(task.headSHA ?? "-").slice(0, 12)}:v${review}${facts?.text ? `:t${carried}` : ""}`;
}

/** Facts the pool step stores on its gate_refused event so the block can be scoped and compared later. */
export function gateRefusalFacts(task: Task, events: readonly Ev[], intentId: string): Record<string, unknown> & { intentId: string } {
  return { intentId, stage: task.stage, round: task.round, head: task.headSHA, window: stageWindow(task, events),
    material: gateMaterial(task, events), handler: GATE_HANDLER_VERSION };
}

export interface GateBlock {
  taskId: string;
  seq: number;
  ts: number;
  stage: string;
  round: number;
  reason: string;
  /** blocked = this material was refused; retry = it changed, one full-gate offer may go; retrying = a later offer passed the gate. */
  state: "blocked" | "retry" | "retrying";
  material: string;
}

const lendOp = (e: Ev): string | undefined => (e.data.lend as { op?: string } | undefined)?.op;
const lendOrder = (e: Ev): unknown => (e.data.lend as { orderId?: unknown } | undefined)?.orderId;

/** Explicit, legal ways the card's work moved on after the refusal; anything else (notes, memory, hello) leaves the block. */
function closedBy(e: Ev, events: readonly Ev[], window: number): boolean {
  if (e.kind === "note" && lendOp(e) === "claim") {
    return events.some((o) => o.kind === "note" && lendOp(o) === "offer" && lendOrder(o) === lendOrder(e) && o.seq > window);
  }
  if (e.kind === "note" && lendOp(e) === "reclaim") return true;
  if (e.kind !== "scheduler") return false;
  // submitted is only the pre-send claim; rejected or unknown delivery must keep the standing block visible.
  if (e.data.op !== "settle" || e.data.to !== "done") return false;
  const plan = events.find((p) => p.kind === "scheduler" && p.data.op === "plan" && p.data.id === e.data.id);
  return plan?.data.action === "dispatch" && typeof plan.data.recipient === "string" && !isPoolIntent({ action: "dispatch", recipient: plan.data.recipient });
}

/**
 * This window's standing gate block, or null. Refusals of an earlier window or round (late events included) never apply; a head
 * or rev moved in the same window (FB1 adopting a fix start) is a material change, never a success: it allows one more offer only.
 */
export function gateBlock(task: Task, events: readonly Ev[]): GateBlock | null {
  if (!BLOCK_STAGES.includes(task.stage)) return null;
  const window = stageWindow(task, events);
  const refusals = events.filter((e) => e.kind === "scheduler" && e.data.op === "gate_refused" && e.seq > window &&
    (e.data.window === undefined || (e.data.window === window && e.data.round === task.round)));
  const last = refusals.at(-1);
  if (!last || events.some((e) => e.seq > last.seq && closedBy(e, events, window))) return null;
  const material = gateMaterial(task, events);
  const passed = events.some((e) => e.seq > last.seq && e.kind === "scheduler" && e.data.op === "pool_offer");
  const state = passed ? "retrying" : refusals.some((e) => e.data.material === material) ? "blocked" : "retry";
  return { taskId: task.id, seq: last.seq, ts: last.ts, stage: task.stage, round: task.round, reason: String(last.data.reason ?? ""), state, material };
}

/** The safe next step for PM: nothing here rewrites the untrusted text, waives the gate, or takes a live lease. */
function blockReason(b: GateBlock): string {
  const bare = b.reason.replace(/^.*?外发闸（[^）]*）：/, "");
  const why = bare.length > 200 ? `${bare.slice(0, 200)}…` : bare;
  const head = `安全材料阻塞（第 ${b.round} 轮 ${b.stage}，外发闸拒收：${why}）`;
  if (b.state === "retry") return `${head}；材料或外发闸处理器版本已变，auto 卡会再外发一次（仍完整过闸）`;
  return `${head}；同一份材料不再外发、不改写原文、不豁免。下一步：PM 修订规格（spec-set）或重出审查报告后自动再试一次，或 ledger lend-reclaim ${b.taskId} 收回本机做`;
}

/** Placement facts without this window's gate-refused offers: a changed material is not a spent attempt for any peer. */
function withoutGateRefused(s: PlannerSnapshot, since: number): PlannerSnapshot {
  const spent = (i: SchedulerIntent) => isPoolIntent(i) && i.status === "cancelled" && i.causalSeq >= since && isGateReceipt(i.receipt);
  return { ...s, intents: s.intents.filter((i) => !spent(i)) };
}

/** Planner hook around remoteWork for build / fix: same material → a block wait instead of another peer or a capacity wait. */
export function blockedRemoteWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">): Away {
  const b = gateBlock(s.task, s.events);
  if (b?.state === "blocked") return remoteWork(s, since, role) && { code: GATE_BLOCK_CODE, wait: blockReason(b) };
  const away = remoteWork(b?.state === "retry" ? withoutGateRefused(s, since) : s, since, role);
  const down = away && "wait" in away && CAPACITY.test(away.wait) ? peerDown(s) : null;
  return down && away && "wait" in away ? { ...away, wait: `${away.wait}（不是容量：${down}）` } : away;
}

/** The peer this card's writing must go to (pin, else the fix's lease holder), else every borrowed peer. */
function targetPeers(s: PlannerSnapshot): NonNullable<PlannerSnapshot["pool"]>["peers"] {
  const peers = s.pool?.peers ?? [];
  const pin = typeof s.task.extra?.placement === "string" && s.task.extra.placement.startsWith("peer:") ? s.task.extra.placement.slice(5) : null;
  const only = pin ?? (s.task.stage === "fix" ? s.pool?.writeLeasePeer ?? null : null);
  return only ? peers.filter((p) => p.peer === only) : peers;
}

/** Every peer the card could go to is offline, unauthorised or expired (not merely full): the wait is the peer, not capacity. */
function peerDown(s: PlannerSnapshot): string | null {
  const peers = targetPeers(s);
  const down = peers.filter((p) => !p.v2 || (p.v2.why !== null && !CAPACITY.test(p.v2.why)));
  return peers.length && down.length === peers.length ? down.map((p) => `${p.peer} ${p.v2?.why ?? "没有 hello"}`).join("；") : null;
}

/** Why a card gets no new order, kept apart: idle for want of ready work is not a bug, capacity is not a security refusal. */
export type DispatchCategory = "security_material" | "capacity" | "peer_unavailable" | "no_ready_work" | "in_flight" | "dispatchable" | "pm";
const CAPACITY = /空位|空闲|槽|名额|已满|单数用完/;

function dispatchCategory(d: PlannerDecision): DispatchCategory {
  if (d.kind === "intent") return "dispatchable";
  if (d.kind === "escalate") return "pm";
  if (d.code === GATE_BLOCK_CODE) return "security_material";
  if (d.code === "in_flight" || d.code === "intent_in_flight" || d.code === "unknown_effect") return "in_flight";
  if (d.code === "capacity") return "capacity";
  if (d.code === "placement" || d.code === "placement_pinned") return CAPACITY.test(d.reason) && !d.reason.includes("不是容量") ? "capacity" : "peer_unavailable";
  return "no_ready_work";
}

/** The placement view with the block taken into account: the planner's own decision decides, so the two never disagree. */
export function explainWithBlock(s: PlannerSnapshot, decision: PlannerDecision) {
  const b = gateBlock(s.task, s.events);
  const category = dispatchCategory(decision);
  const block = b && b.state !== "retrying" ? { state: b.state, round: b.round, stage: b.stage, seq: b.seq, reason: blockReason(b) } : null;
  if (decision.kind === "wait" && decision.code === GATE_BLOCK_CODE) {
    return { role: (s.task.stage === "fix" ? "fix" : "write") as PlaceRole, where: "-", reason: `等：${decision.reason}`, category, block };
  }
  const view = explainPlacement(b?.state === "retry" ? withoutGateRefused(s, stageWindow(s.task, s.events)) : s);
  return { ...view, category, block };
}

/** Audit rows (ledger-audit.ts dispatch_blocked): one per standing block and state, from events only, no local session needed. */
export function blockFindings(task: Task, events: readonly Ev[]): { since: number; keyParts: (string | number)[]; detail: string; suggestion: string } | null {
  const b = gateBlock(task, events);
  if (!b || b.state === "retrying") return null;
  return { since: b.ts, keyParts: [task.id, b.seq, b.state], detail: `${task.id} ${blockReason(b)}`,
    suggestion: b.state === "retry" ? "材料已变：auto 卡下个调度轮自动再外发一次（仍过闸）；observe / manual 卡由 PM 决定"
      : `PM 处理材料（修订规格或重出审查报告，调度自动再外发一次、仍过闸），或 ledger lend-reclaim ${task.id} 收回本机做；别改写原文、别豁免` };
}
