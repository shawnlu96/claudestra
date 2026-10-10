/**
 * Manual merge queue (dispatch-recovery-MQ1): PM's explicit requests to merge workflow-manual cards wait in event-seq order and
 * get the project merge slot (`merge:<project>`) through one authoritative decision, manualTurn, read by both sides of the race:
 * - the pass's train formation (scheduler-merge-train-hold-slot.ts trainProjects): no new train while the queue head is due or
 *   its run is active, so the head gets the slot at the latest when the current train is done, before the next one forms;
 * - the claim (`ledger manual-merge-claim`, scheduler identity, between reclaimLentSlots and the auto tick): under BEGIN IMMEDIATE
 *   it decides again and, only when due and claimable, writes the intent, takes the slot and begins the run via beginMergeRun;
 *   a racing auto plan or second claimer loses on the slot's primary key / the transaction order, never on an unlocked flag.
 * A live train is never interrupted: no claim while it tests / settles; claimed during its cleanup, the run waits (mergeSlotTurn)
 * until it is done. A run that lent its slot to the last train (MTR1) gets it back first. After a manual run ends, a waiting auto
 * candidate gets one turn (a merge intent of its own) before the next manual claim, at most OWED_LIMIT_MS, so neither side starves.
 * Policy: CFG's RecoveryPolicyPort key manualMergeQueue; observe records one deduped would-be note and claims nothing.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { mustTask } from "./ledger-checks.js";
import { getWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import {
  CLAIM_OP, eventAt, intentOf, listRequests, manualIntentId, MANUAL_MERGE_NODE, manualQueueMode, REQUEST_OP, requestAt, requestRefusal, revokeOf, REVOKE_OP, SHA,
  type ManualRequest,
} from "./manual-merge-queue-facts.js";
import { recordObserved } from "./recovery-policy.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { beginMergeRun, getMergeRun } from "./scheduler-merge.js";
import { HOLD_LIMIT_MS, trainHolds } from "./scheduler-merge-train-hold.js";
import { lentSlotPending } from "./scheduler-merge-train-hold-slot.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { mergeCandidates } from "./scheduler-merge-train-tick.js";

/** What the pass read from the train file (its only writer is the same scheduler, so the claim child is handed it). */
export const TRAIN_SIGNALS = ["none", "holds", "cleanup", "corrupt"] as const;
export type TrainSignal = (typeof TRAIN_SIGNALS)[number];
/** How long a finished manual run makes the next manual claim give waiting auto cards a turn first. */
const OWED_LIMIT_MS = HOLD_LIMIT_MS;

/** A train past HOLD_LIMIT_MS still testing / settling is stuck: no wait (the driver gate voids it, as for any outsider). */
export function trainSignal(store: TrainStore | null, project: string, now: number): TrainSignal {
  if (!store) return "none";
  let s;
  try { s = store.load(project); } catch { return "corrupt"; } // never read a broken train file as "no train"
  if (!s || s.phase === "done") return "none";
  if (trainHolds(s, now)) return "holds";
  return s.phase === "cleanup" ? "cleanup" : "none";
}

type RequestState = "queued" | "waiting" | "void" | "revoked" | "running" | "merged" | "ended" | "unknown";
export interface RequestStatus { state: RequestState; why: string | null; phase: string | null }

/** Derived from the ledger every time (request, revoke, its intent and merge run), so a restart loses no place and no outcome. */
function requestStatus(db: Database, req: ManualRequest, now: number): RequestStatus {
  const intent = intentOf(db, req);
  if (intent) {
    const run = getMergeRun(db, intent.id), phase = run?.phase ?? null;
    if (intent.status === "pending" || intent.status === "submitted") return { state: "running", why: run?.reason ?? null, phase };
    if (intent.status === "done") return { state: "merged", why: intent.receipt, phase };
    if (intent.status === "unknown") return { state: "unknown", why: intent.receipt ?? run?.reason ?? null, phase };
    return { state: "ended", why: run?.reason ?? intent.receipt, phase };
  }
  const revoke = revokeOf(db, req);
  if (revoke) return { state: "revoked", why: revoke.text, phase: null };
  const r = requestRefusal(db, req, now);
  return r ? { state: r.kind === "void" ? "void" : "waiting", why: r.why, phase: null } : { state: "queued", why: null, phase: null };
}

/** Requests the claim step still has to look at: no intent yet, not revoked (a void one is judged inside the claim). */
export const listOpenRequests = (db: Database, project: string): ManualRequest[] =>
  db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_intents'").get()
    ? listRequests(db, project).filter((r) => !intentOf(db, r) && !revokeOf(db, r)) : [];

export type Turn =
  | { kind: "none" }
  | { kind: "active"; req: ManualRequest; intentId: string }
  | { kind: "owed"; req: ManualRequest; why: string }
  | { kind: "due"; req: ManualRequest; wait: string | null };

const manualIntents = (db: Database, project: string): SchedulerIntent[] => db.query(`SELECT * FROM scheduler_intents WHERE project = ?
  AND node = ? AND action = 'merge' ORDER BY eventSeq`).all(project, MANUAL_MERGE_NODE) as SchedulerIntent[];

/**
 * The last manual run ended while auto cards wait and none of them has had a merge intent since: they go first. "Auto cards" are
 * every card the auto tick may legally merge — ui cards with their screenshot acceptance included, not only the train's candidates.
 */
function owedToAuto(db: Database, project: string, now: number): string | null {
  const last = manualIntents(db, project).at(-1);
  if (!last || now - last.updatedAt >= OWED_LIMIT_MS || !mergeCandidates(db, project, { now }).length) return null;
  const since = db.query(`SELECT 1 FROM scheduler_intents WHERE project = ? AND action = 'merge' AND node != ? AND eventSeq > ? LIMIT 1`)
    .get(project, MANUAL_MERGE_NODE, last.eventSeq);
  return since ? null : `上一张人工合并（${last.taskId}）刚结束，等候中的自动卡先轮一趟`;
}

/** The single decision both the train formation and the claim read. Pure reads; the claim re-runs it inside its transaction. */
export function manualTurn(db: Database, project: string, train: TrainSignal, now: number): Turn {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return { kind: "none" };
  const live = manualIntents(db, project).find((i) => i.status === "pending" || i.status === "submitted");
  if (live) {
    const req = requestAt(db, Number(live.id.slice(4)));
    if (req) return { kind: "active", req, intentId: live.id };
  }
  const head = listRequests(db, project).find((r) => requestStatus(db, r, now).state === "queued");
  if (!head) return { kind: "none" };
  const owed = owedToAuto(db, project, now);
  if (owed) return { kind: "owed", req: head, why: owed };
  const holder = db.query("SELECT taskId FROM scheduler_resources WHERE project = ? AND resource = ?").get(project, `merge:${project}`) as
    { taskId: string } | null;
  const wait = train === "corrupt" ? "合并列车状态文件读不了，先不占槽"
    : train === "holds" ? "等当前列车合并 / 部署完（不打断活车）"
    : holder ? `合并槽在 ${holder.taskId} 手里，等它结清`
    : lentSlotPending(db, project) ? "让过路给上一辆车的自动卡先取回合并槽"
    : null;
  return { kind: "due", req: head, wait };
}

/** Trains must not form while the queue head is due or its run holds the slot (scheduler-pass.ts → trainProjects). */
export const blocksTrain = (t: Turn): boolean => t.kind === "active" || t.kind === "due";

export type ClaimResult = { claimed: true; intentId: string; taskId: string } | { claimed: false; observed?: boolean; turn: Turn["kind"]; why: string | null };

/**
 * `ledger manual-merge-claim`: the scheduler takes the slot for the due queue head. One immediate transaction: decide again →
 * observe (one deduped note) or intent (submitted: this is the merge controller claiming it) + slot + claim event + beginMergeRun,
 * which re-checks head / spec / UI / review / slot. Any refusal rolls all of it back, so nothing is half reserved.
 */
export function claimManualMerge(db: Database, ctx: WriteCtx, input: { project: string; mode: "on" | "observe"; train: TrainSignal; requiredChecks: readonly string[] }): ClaimResult {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "人工合并占槽只由调度服务做（它同时读列车状态）");
  const now = ctx.now ?? Date.now();
  return tx(db, () => {
    const turn = manualTurn(db, input.project, input.train, now);
    if (turn.kind !== "due" || turn.wait) {
      return { claimed: false, turn: turn.kind, why: turn.kind === "due" ? turn.wait : turn.kind === "owed" ? turn.why : null };
    }
    const req = turn.req;
    if (input.mode === "observe") {
      const r = recordObserved(db, { project: req.project, mechanism: "manualMergeQueue", target: req.taskId, actionKey: `claim:${req.seq}`,
        action: `给人工合并请求 #${req.seq}（${req.taskId} @ ${req.head.slice(0, 12)}）占合并槽并合并`, data: { request: req.seq } }, now);
      return { claimed: false, observed: r.recorded, turn: "due", why: "observe：只记录" };
    }
    // the child re-reads the policy inside the transaction: a switch away from on after the pass read it reserves nothing
    const mode = manualQueueMode(req.project);
    if (mode !== "on") return { claimed: false, turn: "due", why: `人工合并排队策略已是 ${mode}，不占槽` };
    const task = mustTask(db, req.taskId), wf = getWorkflow(db, req.taskId)!, id = manualIntentId(req.seq), lock = `merge:${req.project}`;
    const causal = (db.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE project = ?").get(req.project) as { seq: number }).seq;
    const reason = `人工合并请求 #${req.seq}（${req.requestedBy}）轮到合并槽`;
    db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion, status,
      attempts, reason, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'merge', NULL, ?, ?, ?, ?, ?, 'submitted', 1, ?, ?, ?)`)
      .run(id, task.id, task.project, MANUAL_MERGE_NODE, causal, task.rev, task.specRev, task.headSHA, wf.templateVersion, reason, now, now);
    db.prepare("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, ?, 'intent')")
      .run(task.project, lock, task.id, id, now);
    const ev = insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${id}` }, { project: task.project, target: task.id, kind: "scheduler",
      text: reason, data: { op: CLAIM_OP, id, request: req.seq, node: MANUAL_MERGE_NODE, action: "merge", resources: [lock], head: task.headSHA,
        specRev: task.specRev, round: task.round, causalSeq: causal } }, true);
    db.prepare("UPDATE scheduler_intents SET eventSeq = ? WHERE id = ?").run(ev.seq, id);
    beginMergeRun(db, ctx, id, input.requiredChecks);
    return { claimed: true, intentId: id, taskId: task.id };
  });
}

export interface RequestInput { taskId: string; head: string; specRev: number; round: number; reviewSeq: number; uiDigest?: string; reason: string }

const sameBinding = (a: ManualRequest, b: RequestInput): boolean => a.head === b.head && a.specRev === b.specRev && a.round === b.round &&
  a.review.seq === b.reviewSeq && a.uiDigest === (b.uiDigest ?? null);

/**
 * `ledger manual-merge-request`: PM (not the dispatcher) / master / owner queue a manual card for the merge slot. The binding must
 * equal the card now, the review event must be the current structured review (its reviewer / session / family / report are copied
 * from that event, never typed in), a ui card names the digest PM accepted. A request that could never merge is refused; one that
 * only has to wait (frozen queue, open ask, hold, unsettled intent) is queued and shown waiting. One open request per card: the same
 * binding again answers the existing one; a different one is refused until the open one is revoked or has ended.
 */
export function recordRequest(db: Database, ctx: WriteCtx, input: RequestInput): { request: ManualRequest; duplicate: boolean; status: RequestStatus } {
  const reason = textOneLine(input.reason, "原因", 600), now = ctx.now ?? Date.now();
  if (!SHA.test(input.head)) throw new LedgerError("invalid", "--head 要是完整 40 位 SHA");
  if (![input.specRev, input.round, input.reviewSeq].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new LedgerError("invalid", "--spec-rev / --round / --review-seq 要是非负整数");
  return tx(db, () => {
    const task = mustTask(db, input.taskId), wf = getWorkflow(db, task.id);
    if (!actorMayConfigure(db, ctx.actor, task.project)) throw new LedgerError("forbidden", `人工合并排队要项目 ${task.project} 的 PM（调度助理除外）/ master / owner（你是 ${ctx.actor}）`);
    if (task.headSHA !== input.head || task.specRev !== input.specRev || task.round !== input.round) {
      throw new LedgerError("conflict", `绑定与卡当前不一致：卡是 head ${task.headSHA?.slice(0, 12) ?? "空"} / specRev ${task.specRev} / 第 ${task.round} 轮`);
    }
    const ui = wf?.template === "ui";
    if (ui !== (input.uiDigest !== undefined)) throw new LedgerError("invalid", ui ? "ui 卡要带 --ui-digest（PM 验收过的截图摘要）" : "非 ui 卡不带 --ui-digest");
    const events = listEvents(db, { project: task.project, target: task.id });
    const read = currentReviewFacts(task, events, (a) => actorMayConfigure(db, a, task.project)), ev = eventAt(db, input.reviewSeq);
    if (read.kind !== "facts" || read.facts.eventSeq !== input.reviewSeq || ev?.target !== task.id) {
      throw new LedgerError("conflict", `--review-seq 要是本卡本轮当前的结构化审查事件${read.kind === "facts" ? `（现在是 #${read.facts.eventSeq}）` : "（本轮没有合格的）"}`);
    }
    const f = read.facts;
    for (const old of listRequests(db, task.project, task.id)) {
      const st = requestStatus(db, old, now);
      if (!["queued", "waiting", "running", "unknown"].includes(st.state)) continue;
      if (sameBinding(old, input)) return { request: old, duplicate: true, status: st };
      throw new LedgerError("conflict", `卡已有未结人工合并请求 #${old.seq}（${st.state}），先 manual-merge-revoke 或等它结束`);
    }
    const draft: ManualRequest = { seq: 0, ts: now, project: task.project, taskId: task.id, requestedBy: ctx.actor, reason, head: input.head,
      specRev: input.specRev, round: input.round, uiDigest: input.uiDigest ?? null,
      review: { seq: f.eventSeq, actor: ev.actor, reviewer: f.reviewer, sessionId: f.reviewerSessionId, family: f.reviewerFamily, reportPath: f.reportPath, verdict: f.verdict } };
    const refusal = requestRefusal(db, draft, now);
    if (refusal?.kind === "void") throw new LedgerError("conflict", `不能排人工合并：${refusal.why}`);
    const e = insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "decision", text: reason,
      data: { op: REQUEST_OP, head: draft.head, specRev: draft.specRev, round: draft.round, uiDigest: draft.uiDigest, review: draft.review,
        frozen: getMeta(db, task.project).queueFrozen.frozen } }, false);
    const request = { ...draft, seq: e.seq, ts: e.ts };
    return { request, duplicate: false, status: requestStatus(db, request, now) };
  });
}

/**
 * `ledger manual-merge-revoke`: the queue place goes away; a claimed run that has sent no merge stops at its next drift check and
 * ends cancelled with its slot freed (scheduler-merge-conflict.ts manualCancel). A merge already sent cannot be revoked here.
 */
export function revokeRequest(db: Database, ctx: WriteCtx, input: { taskId: string; seq: number; reason: string }): { duplicate: boolean; status: RequestStatus } {
  const reason = textOneLine(input.reason, "原因", 600), now = ctx.now ?? Date.now();
  return tx(db, () => {
    const req = requestAt(db, input.seq);
    if (!req || req.taskId !== input.taskId) throw new LedgerError("not_found", `${input.taskId} 没有人工合并请求 #${input.seq}`);
    if (!actorMayConfigure(db, ctx.actor, req.project)) throw new LedgerError("forbidden", `撤销人工合并请求要项目 ${req.project} 的 PM（调度助理除外）/ master / owner`);
    if (revokeOf(db, req)) return { duplicate: true, status: requestStatus(db, req, now) };
    const intent = intentOf(db, req), phase = intent ? getMergeRun(db, intent.id)?.phase : null;
    if (intent && (intent.status === "done" || intent.status === "cancelled" || intent.status === "unknown" || (phase && !["ready", "updating", "await_ci"].includes(phase)))) {
      throw new LedgerError("conflict", `请求 #${req.seq} 的合并已${phase === "merging" ? "发出" : "结束"}（${intent.status}/${phase ?? "-"}），撤不回；结果不明走 scheduler-merge-resolve`);
    }
    insertEvent(db, { actor: ctx.actor, now }, { project: req.project, target: req.taskId, kind: "decision", text: reason,
      data: { op: REVOKE_OP, request: req.seq, intent: intent?.id ?? null } }, false);
    return { duplicate: false, status: requestStatus(db, req, now) };
  });
}

export interface ManualQueueRow {
  request: number; task: string; requestedBy: string; requestedAt: string; head: string; state: RequestState; phase: string | null;
  turn: number | null; why: string | null; review: { seq: number; reviewer: string; family: string; report: string };
}

/** `ledger merge-queue`'s manual part: every request still worth reading (open ones and the latest outcome per card), queue order. */
export function manualQueueView(db: Database, project: string, train: TrainSignal, now: number): { rows: ManualQueueRow[]; turn: Turn } {
  const turn = manualTurn(db, project, train, now);
  if (turn.kind === "none" && !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return { rows: [], turn };
  let place = 0;
  const all = listRequests(db, project).map((r) => ({ r, st: requestStatus(db, r, now) }));
  const latest = new Map(all.map(({ r }) => [r.taskId, r.seq]));
  const rows = all.filter(({ r, st }) => ["queued", "waiting", "running", "unknown"].includes(st.state) || latest.get(r.taskId) === r.seq).map(({ r, st }) => {
    const queued = st.state === "queued" || st.state === "waiting";
    const why = turn.kind !== "none" && turn.req.seq === r.seq && turn.kind !== "active"
      ? turn.kind === "owed" ? turn.why : turn.wait ?? "轮到它：本轮占合并槽" : st.why;
    return { request: r.seq, task: r.taskId, requestedBy: r.requestedBy, requestedAt: new Date(r.ts).toISOString(), head: r.head.slice(0, 12),
      state: st.state, phase: st.phase, turn: queued ? ++place : null, why,
      review: { seq: r.review.seq, reviewer: r.review.reviewer, family: r.review.family, report: r.review.reportPath } };
  });
  return { rows, turn };
}
