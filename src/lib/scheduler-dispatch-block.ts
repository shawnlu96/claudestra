/**
 * Gate refusals persist across scheduler restarts. Only changed outbound material gets one more full-gate attempt;
 * assignment and workflow edits are not proof of takeover. Claims, reclaim and settled local dispatch are evidence.
 * The material includes the SHA-256 of the spec body the offer actually sends (MATFP1): an edit of the spec text under the same
 * specRev re-arms one attempt, while an unreadable spec or a missing digest is unknown and never counts as a change.
 * Planner, placement and patrol share these event-derived facts. See tests/scheduler-dispatch-block*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { convergenceSpec } from "./fix-strategy-order.js";
import { getWriteLease, heldLease, lastReviewOf } from "./ledger-lend-lease.js";
import { restateFacts } from "./ledger-lend-relay.js";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, listEvents } from "./ledger-store.js";
import { uiRejectLend } from "./ledger-ui-approve-verdict.js";
import { stepOfStage } from "./lend-git.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";
import { fixBounce } from "./scheduler-merge-conflict.js";
import type { PlaceRole } from "./scheduler-placement.js";
import { explainPlacement, remoteWork, type Away } from "./scheduler-placement-plan.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { specPathFor } from "./task-spec.js";

/** Bump when the gate or forPeer (order-gate-heads.ts) can pass material it used to refuse: each standing block retries once. */
const GATE_HANDLER_VERSION = 4;
const GATE_BLOCK_CODE = "dispatch_blocked_gate";
/** GateBlock.material when the current spec digest is unknown; refusal facts store null there, so it never matches one. */
const UNKNOWN = "unknown";
const BLOCK_STAGES: readonly string[] = ["build", "fix"];
/** The pool step's receipt for an offer the ledger refused (ledger-scheduler-pool.ts refuse); only the gate's wording counts. */
const isGateReceipt = (r: string | null): boolean => !!r?.startsWith("未投递：出单被拒：") && r.includes("外发闸");

type Ev = LedgerEvent;
type Task = Pick<LedgerTask, "id" | "stage" | "round" | "specRev" | "headSHA">;

/**
 * What the block reads outside the events: the digest of the spec body an offer would send now (null = unknown: missing spec,
 * a read failure, a broken fix material, an unreadable fix report) and the card's write lease ("none" only when the lease table has no row for the card;
 * a missing table, a read error, an illegal state or a row of another card is "unknown"). The gate absent as a whole = unknown.
 */
export interface GateInputs { specDigest: string | null; lease: { state: "held" | "ended"; peer: string } | "none" | "unknown" }

/** Deterministic SHA-256 of the whole outbound text as UTF-8; only a digest ever lands in events and diagnostics. */
export const specDigestOf = (text: string | null | undefined): string | null =>
  typeof text === "string" ? createHash("sha256").update(text, "utf8").digest("hex") : null;

/** readTextSoft's read (existsSync, then utf-8) without its log line, which would print the private path. */
function readSilent(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  // Unreadable is the whole answer here (unknown, blocked); the OS error would only carry the private path.
  try { return readFileSync(path, "utf-8"); } catch { return null; }
}

/**
 * Whether a fix order's report can be read through the chain lend-write-materials.ts writeMaterials uses (merge bounce: ledger
 * evidence; UI-only reject: no file; else the UI code report or the last review's path). Its seq is already in the material;
 * an unreadable report makes the material unknown, so the offer that would fail on it never spends the re-armed attempt.
 */
function fixReportReadable(db: Database, task: LedgerTask): boolean {
  if (stepOfStage(task.stage) !== "fix" || fixBounce(listEvents(db, { project: task.project, target: task.id }), task.stage)) return true;
  const ui = uiRejectLend(db, task);
  if (ui && !ui.codeReportPath) return true;
  return !!readSilent(ui?.codeReportPath ?? lastReviewOf(db, task).path);
}

function leaseOf(db: Database, task: LedgerTask): GateInputs["lease"] {
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_write_leases'").get()) return "unknown";
    const row = getWriteLease(db, task.id);
    if (!row) return "none";
    if (row.taskId !== task.id || row.project !== task.project || typeof row.peer !== "string") return "unknown";
    if (row.state === "held") return { state: heldLease(db, task) ? "held" : "ended", peer: row.peer };
    return row.state === "ended" ? { state: "ended", peer: row.peer } : "unknown";
  } catch {
    // A broken lease read is reported as the "unknown" lease category (advice: check lend-orders, no reclaim); the error itself
    // may name the ledger file and is not needed to keep the block conservative.
    return "unknown";
  }
}

/**
 * The text `ledger scheduler-pool` sends (ledger-scheduler-cmds.ts specOf: convergenceSpec over the spec specPathFor locates,
 * the fix strategy material included), digested whole. A missing spec or fix report is unknown, never `convergenceSpec(null)`'s
 * stitched text.
 */
export function gateInputs(db: Database, task: LedgerTask): GateInputs {
  let specDigest: string | null = null;
  try {
    const spec = readSilent(specPathFor(task, getMeta(db, task.project).docsDir));
    specDigest = spec === null || !fixReportReadable(db, task) ? null : specDigestOf(convergenceSpec(db, task, spec));
  } catch {
    // A broken material chain (convergenceSpec throws on a bad strategy material) is the unknown category, shown as
    // "material unreadable / digest unknown" in the advice; its message can quote material paths, so it is not kept.
    specDigest = null;
  }
  return { specDigest, lease: leaseOf(db, task) };
}

/** The seq the card entered its current stage (the planner's `since`); its creation when it never moved. */
const stageWindow = (task: Pick<LedgerTask, "stage">, events: readonly Ev[]): number =>
  events.findLast((e) => e.kind === "stage" && e.data.to === task.stage)?.seq ?? events.find((e) => e.kind === "task")?.seq ?? 0;

/**
 * What a write order is made of: handler version, specRev, round, full head, report / restate sources and the spec body's
 * digest, each bound separately; base-branch commits are deliberately not part of it. No digest = no material (unknown).
 */
function gateMaterial(task: Task, events: readonly Ev[], digest: string | null | undefined): string | null {
  if (!digest) return null;
  const review = events.findLast((e) => e.kind === "review")?.seq ?? 0;
  const facts = task.stage === "build" ? restateFacts(events, task.specRev) : null;
  const carried = facts && !facts.answered && facts.text ? facts.seq : 0;
  return `g${GATE_HANDLER_VERSION}:s${task.specRev}:r${task.round}:h${task.headSHA ?? "-"}:v${review}${facts?.text ? `:t${carried}` : ""}:d${digest}`;
}

/**
 * Facts the pool step stores on its gate_refused event so the block can be scoped and compared later. `spec` is the exact text
 * the refused offer carried; without it the refusal is recorded with digest null and its material can never match (unknown).
 */
export function gateRefusalFacts(task: Task, events: readonly Ev[], intentId: string, spec?: string | null): Record<string, unknown> & { intentId: string } {
  const digest = specDigestOf(spec);
  return { intentId, stage: task.stage, round: task.round, head: task.headSHA, window: stageWindow(task, events),
    material: gateMaterial(task, events, digest), digest, handler: GATE_HANDLER_VERSION };
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
  /** The current material, or "unknown" when the spec body's digest is (unreadable, missing, not supplied): blocked, never a change. */
  material: string;
  /** The write lease as gateInputs read it; "unknown" when the caller has no lease facts. */
  lease: GateInputs["lease"];
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
export function gateBlock(task: Task, events: readonly Ev[], gate?: GateInputs | null): GateBlock | null {
  if (!BLOCK_STAGES.includes(task.stage)) return null;
  const window = stageWindow(task, events);
  const refusals = events.filter((e) => e.kind === "scheduler" && e.data.op === "gate_refused" && e.seq > window &&
    (e.data.window === undefined || (e.data.window === window && e.data.round === task.round)));
  const last = refusals.at(-1);
  if (!last || events.some((e) => e.seq > last.seq && closedBy(e, events, window))) return null;
  const material = gateMaterial(task, events, gate?.specDigest);
  const passed = events.some((e) => e.seq > last.seq && e.kind === "scheduler" && e.data.op === "pool_offer");
  // A refusal without a digest (before MATFP1, or the material went unrecorded) matches nothing: one full re-check of the
  // readable spec, whose own refusal then carries the digest. Unknown current content never spends that attempt.
  const state = passed ? "retrying" : material === null || refusals.some((e) => e.data.material === material) ? "blocked" : "retry";
  return { taskId: task.id, seq: last.seq, ts: last.ts, stage: task.stage, round: task.round, reason: String(last.data.reason ?? ""), state,
    material: material ?? UNKNOWN, lease: gate?.lease ?? "unknown" };
}

/** Where the lease stands, from the lend_write_leases row only: reclaim is suggested only for a live held lease. */
function leaseStep(b: GateBlock): string {
  const orders = `ledger lend-orders ${b.taskId}`;
  if (b.lease === "unknown") return `写租约状态读不到：先用 ${orders} 核对出借单真实来源与结果，再走正式接续，不用 reclaim、改 stage 或补租约`;
  if (b.lease === "none") return `卡上没有写租约：用 ${orders} 核对真实来源与结果后正式接续，不用 reclaim、改 stage 或补租约`;
  if (b.lease.state === "held") return `写租约仍 held 在 ${b.lease.peer}：确需接回本机做时，PM 用 ledger lend-reclaim ${b.taskId} --reason <原因>`;
  return `写租约已结束：别再 reclaim、改 stage、raw SQL 或补租约，先用 ${orders} 核对真实结果，再正式接续`;
}

/**
 * The safe next step for PM, from real commands only: nothing here rewrites the untrusted text, waives the gate, or takes a live
 * lease. A fix card has no entry to file a replacement report (`ledger review` records verdicts in review only), so the advice
 * says so instead of naming a command the fix stage refuses or a stage change around it.
 */
function nextStep(b: GateBlock): string {
  const spec = `PM 修订本卡规格正文（直接改规格文件，或 ledger task-set ${b.taskId} --rev <n> --spec <规格绝对路径>）`;
  const report = b.stage === "fix" ? "；fix 阶段没有登记替代审查报告的正式入口（ledger review 只在 review 阶段记结论），报告原件照旧保留，不改 stage 绕过" : "";
  return `下一步：${spec}${report}；规格正文摘要变了，auto 卡自动再完整过闸一次（observe / manual 卡不自动重派）；${leaseStep(b)}`;
}

function blockReason(b: GateBlock): string {
  const bare = b.reason.replace(/^.*?外发闸（[^）]*）：/, "");
  const why = bare.length > 200 ? `${bare.slice(0, 200)}…` : bare;
  const head = `安全材料阻塞（第 ${b.round} 轮 ${b.stage}，外发闸拒收：${why}）`;
  if (b.state === "retry") return `${head}；材料（规格正文摘要 / 报告 / 复述 / head）或外发闸处理器版本已变，auto 卡会再外发一次（仍完整过闸）`;
  const unknown = b.material === UNKNOWN ? "当前规格正文 / 修复报告读不到或摘要未知，不算材料变化、不再外发；先让材料可读。" : "";
  return `${head}；${unknown}同一份材料不再外发；这不是自动改写外来原文，也不是豁免。${nextStep(b)}`;
}

/** Placement facts without this window's gate-refused offers: a changed material is not a spent attempt for any peer. */
function withoutGateRefused(s: PlannerSnapshot, since: number): PlannerSnapshot {
  const spent = (i: SchedulerIntent) => isPoolIntent(i) && i.status === "cancelled" && i.causalSeq >= since && isGateReceipt(i.receipt);
  return { ...s, intents: s.intents.filter((i) => !spent(i)) };
}

/** Planner hook around remoteWork for build / fix: same material → a block wait instead of another peer or a capacity wait. */
export function blockedRemoteWork(s: PlannerSnapshot, since: number, role: Exclude<PlaceRole, "review">): Away {
  const b = gateBlock(s.task, s.events, s.gate);
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
  const b = gateBlock(s.task, s.events, s.gate);
  const category = dispatchCategory(decision);
  const block = b && b.state !== "retrying" ? { state: b.state, round: b.round, stage: b.stage, seq: b.seq, reason: blockReason(b) } : null;
  if (decision.kind === "wait" && decision.code === GATE_BLOCK_CODE) {
    return { role: (s.task.stage === "fix" ? "fix" : "write") as PlaceRole, where: "-", reason: `等：${decision.reason}`, category, block };
  }
  const view = explainPlacement(b?.state === "retry" ? withoutGateRefused(s, stageWindow(s.task, s.events)) : s);
  return { ...view, category, block };
}

/** Audit rows (ledger-audit.ts dispatch_blocked): one per standing block and state, from events plus the card's gate inputs. */
export function blockFindings(task: Task, events: readonly Ev[], gate?: GateInputs | null): { since: number; keyParts: (string | number)[]; detail: string; suggestion: string } | null {
  const b = gateBlock(task, events, gate);
  if (!b || b.state === "retrying") return null;
  return { since: b.ts, keyParts: [task.id, b.seq, b.state], detail: `${task.id} ${blockReason(b)}`,
    suggestion: b.state === "retry" ? "材料已变：auto 卡下个调度轮自动再外发一次（仍过闸）；observe / manual 卡由 PM 决定"
      : `${b.material === UNKNOWN ? "规格正文 / 修复报告读不到或摘要未知：先让材料可读；" : ""}这不是自动改写外来原文，也不是豁免。${nextStep(b)}` };
}
