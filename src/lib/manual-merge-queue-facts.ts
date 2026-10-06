/**
 * Manual merge queue facts (dispatch-recovery-MQ1): a PM's explicit request to merge a workflow-manual card is its own decision
 * event (op manual_merge_request), bound to task / head / specRev / round, the review event it relies on (seq + the reviewer,
 * session, family and report that event wrote) and, for ui cards, the screenshots digest PM accepted. It never writes an engine
 * review dispatch, ack, session bind or verdict, so the auto merge gate (merge_review_unproven) stays as strict as it was.
 * This file only reads: whether a request may still merge (refusal), and the ledger side of a claimed run (scheduler-merge.ts
 * asks manualRunDrift / manualRunReviewer for intents whose node is MANUAL_MERGE_NODE). docs/design/manual-merge-queue.md.
 */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getAsk, ownerAnswered, type Ask } from "./ledger-asks.js";
import { getFeature } from "./ledger-feature.js";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask, listDeps, listEvents, listTasks, toEvent } from "./ledger-store.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { openSafetyHold } from "./scheduler-review-swap.js";
import { UI_ASK_ACTION, uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

export const MANUAL_MERGE_NODE = "manual_merge";
export const REQUEST_OP = "manual_merge_request", REVOKE_OP = "manual_merge_revoke", CLAIM_OP = "manual_merge_claim";
/** One intent per request, keyed by the request's event seq: a second claim of the same request collides on the primary key. */
export const manualIntentId = (seq: number): string => `mmq:${seq}`;
export const requestSeqOf = (intentId: string): number | null => (/^mmq:(\d+)$/.exec(intentId) ? Number(intentId.slice(4)) : null);
export const SHA = /^[a-f0-9]{40}$/i;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

/** The effective manualMergeQueue mode through CFG's RecoveryPolicyPort, read right before each use; a read that throws is off. */
export function manualQueueMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): "on" | "observe" | "off" {
  try {
    const m = policy(project, "manualMergeQueue").mode;
    return m === "on" || m === "observe" ? m : "off";
  } catch (e) {
    console.error(`⚠️ [manual-merge] ${project} 读恢复策略失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

export interface ManualRequest {
  seq: number; ts: number; project: string; taskId: string; requestedBy: string; reason: string;
  head: string; specRev: number; round: number; uiDigest: string | null;
  review: { seq: number; actor: string; reviewer: string; sessionId: string; family: AuthorFamily; reportPath: string; verdict: string };
}

const asRequest = (e: LedgerEvent): ManualRequest => {
  const d = e.data as Record<string, unknown>, r = (d.review ?? {}) as Record<string, unknown>;
  return { seq: e.seq, ts: e.ts, project: e.project, taskId: e.target, requestedBy: e.actor, reason: e.text,
    head: String(d.head), specRev: Number(d.specRev), round: Number(d.round), uiDigest: typeof d.uiDigest === "string" ? d.uiDigest : null,
    review: { seq: Number(r.seq), actor: String(r.actor), reviewer: String(r.reviewer), sessionId: String(r.sessionId),
      family: String(r.family) as AuthorFamily, reportPath: String(r.reportPath), verdict: String(r.verdict) } };
};

// prepare, not query: SELECT * must see columns a newer CLI migrated in (as scheduler-merge.ts getMergeRun says).
const eventsWhere = (db: Database, where: string, ...args: (string | number)[]): LedgerEvent[] =>
  (db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq`).all(...args) as Parameters<typeof toEvent>[0][]).map(toEvent);
export const eventAt = (db: Database, seq: number): LedgerEvent | null => eventsWhere(db, "seq = ?", seq)[0] ?? null;

/** Every request of a project in queue order (event seq = persistent arrival order, survives restarts). */
export function listRequests(db: Database, project: string, taskId?: string): ManualRequest[] {
  const byTask = taskId ? " AND target = ?" : "";
  return eventsWhere(db, `project = ? AND kind = 'decision' AND json_extract(data, '$.op') = '${REQUEST_OP}'${byTask}`,
    ...(taskId ? [project, taskId] : [project])).map(asRequest);
}

export function requestAt(db: Database, seq: number): ManualRequest | null {
  const e = eventAt(db, seq);
  return e && e.kind === "decision" && e.data.op === REQUEST_OP ? asRequest(e) : null;
}

/** The revoke event of a request, if any. */
export const revokeOf = (db: Database, req: ManualRequest): LedgerEvent | null =>
  eventsWhere(db, `project = ? AND target = ? AND kind = 'decision' AND json_extract(data, '$.op') = '${REVOKE_OP}'
    AND json_extract(data, '$.request') = ?`, req.project, req.taskId, req.seq)[0] ?? null;

export const intentOf = (db: Database, req: ManualRequest): SchedulerIntent | null =>
  db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(manualIntentId(req.seq)) as SchedulerIntent | null;

/** void = can never merge as bound (a new request is needed); wait = may merge once this clears (holds its queue place). */
export interface Refusal { kind: "void" | "wait"; why: string }

const authorFamilyOf = (db: Database, task: LedgerTask): AuthorFamily | null =>
  remoteHeadFamily(db, task) ?? getWorkflow(db, task.id)?.authorFamily ?? null;

/**
 * The review this request binds must still be the card's current structured review, from another family than the author, passing
 * (pass, or changes with only P2) with no P0/P1. Who wrote the event is part of the proof: the reviewer it names, the scheduler for
 * a pool result, or — the official manual path, `ledger review <task> --reviewer … --session … --family … --findings … --path …`,
 * which on a manual card only a project PM / master / owner may run — a project PM other than the dispatcher / master / owner
 * recording that reviewer's report. Anyone else (the author, the dispatcher, another agent) naming a reviewer is refused.
 * Neither the requester nor the author is the reviewer. Nothing here accepts a review the engine did not see as a dispatch proof.
 */
function reviewRefusal(db: Database, task: LedgerTask, events: readonly LedgerEvent[], req: Pick<ManualRequest, "review" | "requestedBy">): string | null {
  const read = currentReviewFacts(task, events);
  if (read.kind !== "facts") return read.kind === "none" ? "本轮没有结构化审查结论（未审）" : `审查结论不合格：${read.reason}`;
  const f = read.facts, r = req.review;
  if (f.eventSeq !== r.seq) return `本轮审查结论已换成 #${f.eventSeq}（请求绑定 #${r.seq}）`;
  const ev = events.find((e) => e.seq === f.eventSeq);
  if (!ev || ev.actor !== r.actor) return "审查事件的写入人与请求绑定不一致";
  if (ev.actor !== f.reviewer && ev.actor !== "scheduler" && !actorMayConfigure(db, ev.actor, task.project)) {
    return "审查事件不是 reviewer 本人、调度服务（池单）或项目 PM（调度助理除外）/ master / owner 经 ledger review 登记的";
  }
  if (f.reviewer === req.requestedBy) return "请求人不能是自己这张卡的审查人";
  if (task.agent && (f.reviewer === task.agent || ev.actor === task.agent)) return "作者不能审查 / 登记自己这张卡的审查";
  if (f.reviewer !== r.reviewer || f.reviewerSessionId !== r.sessionId || f.reviewerFamily !== r.family || f.reportPath !== r.reportPath) {
    return "审查人 / session / 家族 / 报告与请求绑定不一致";
  }
  const author = authorFamilyOf(db, task);
  if (!author || f.reviewerFamily === author) return `审查人家族 ${f.reviewerFamily} 与作者家族 ${author ?? "未知"} 不是跨模型`;
  if (f.findings.some((x) => x.severity === "P0" || x.severity === "P1")) return "审查仍有 P0 / P1";
  if (f.verdict === "block" || (f.verdict === "changes" && !f.findings.some((x) => x.severity === "P2"))) return `审查结论 ${f.verdict} 未通过合并闸`;
  return null;
}

/** The answer picked a button the binding lists as approval (lib/ask-bind.ts checkAsk's button rule). */
const pickedApprove = (a: Ask): boolean => {
  const picked = new Set((a.answer?.choices ?? []).map((c) => /^\[button:(.+)\]$/.exec(c)?.[1]).filter(Boolean));
  return !!a.bind && a.bind.approve.some((id) => picked.has(id));
};
/** Approved = answered with an approve button and still inside the approval window (checkAsk's rule, minus the caller / hash). */
const approvedAsk = (a: Ask, now: number): boolean => a.state === "answered" && a.expiresAt > now && pickedApprove(a);

/**
 * One owner decision across its re-asks is its asker + ask key (the bound action when none, as reply defaults it) + binding hash
 * (action, version, asker and the complete params — ask-bind.ts bindHash, what checkAsk compares): an ask under another key, with
 * other params or from another asker is another decision, whose approval says nothing about this one. An owner_action has no
 * binding (the owner's answer is the act): asker + ask key, else asker + title. The scheduler's screenshot ask is the UI gate's
 * business (uiMergeRefusal reads it, expiry included), not a second judgement here.
 */
const decisionKey = (a: Ask): string | null => {
  if (a.bind?.action === UI_ASK_ACTION) return null;
  const by = a.fromAgent ?? a.createdBy ?? "-";
  if (a.kind !== "authorize") return `${a.kind}:${by}:${a.askKey ?? a.title}`;
  return a.bind ? `authorize:${by}:${a.askKey ?? a.bind.action}:${a.bind.paramsHash}` : `authorize:${a.id}`;
};

/** The latest version of the decision stands: approved inside its window (authorize) or answered by the owner (owner_action). */
const decisionStands = (a: Ask, now: number): boolean => a.kind === "owner_action" ? a.state === "answered" && ownerAnswered(a.answer) : approvedAsk(a, now);

/**
 * Every owner decision ever asked on the card (authorize / owner_action) must stand in its latest version. A closed version without
 * a verifiable approval — expired, cancelled, answered without an approve button, or approved but past its window (checkAsk's rule:
 * the window runs from the ask, an answer does not extend it) — is a wait, however old the ask is and whenever PM queued: the
 * request keeps its place, nothing merges, and the lift is the owner approving that same decision re-asked (authorize: same asker,
 * key and binding) or answering it (owner_action) — never a newer request, its reason, or the approval of another decision. A
 * version superseded before its deadline was never decided; its recorded replacement is judged in its place. supersedeIn can
 * supersede an already overdue open row before the expiry scan runs: its terminal updatedAt records that transition, so such a
 * row retains its decision's wait. Otherwise approval would depend on scan order. An open version waits in requestRefusal.
 */
function authorizationRefusal(db: Database, taskId: string, now: number): string | null {
  const rows = db.query("SELECT id FROM asks WHERE taskId = ? AND kind IN ('authorize','owner_action') ORDER BY createdAt, id").all(taskId) as { id: string }[];
  const asks = rows.map(({ id }) => getAsk(db, id)).filter((a): a is Ask => !!a);
  const replaced = new Set(asks.filter((a) => a.state === "superseded" && a.updatedAt < a.expiresAt).map((a) => a.id));
  const latest = new Map<string, Ask>(); // createdAt order: the last version seen of each decision is its newest
  for (const a of asks) {
    const key = decisionKey(a);
    if (key && !(replaced.has(a.id) && asks.some((b) => b.supersedes === a.id))) latest.set(key, a);
  }
  for (const a of latest.values()) {
    if (a.state === "open" || decisionStands(a, now)) continue;
    if (a.state === "answered" && a.kind === "authorize" && pickedApprove(a)) {
      return `授权 ${a.id} 的批准已过有效期（有效期从开出算，答了也不延长）：等 owner 在重新问的授权上批准`;
    }
    return `授权 ${a.id} ${a.state === "answered" ? "的答复不是批准" : `未获答复即 ${a.state}`}（过期 / 撤销不是批准）：等 owner 在重新问的授权上批准`;
  }
  return null;
}

/** A workflow event that switched the card to manual on purpose to keep it there (PM / owner hold). */
const holdOf = (events: readonly LedgerEvent[]): LedgerEvent | null => {
  const t = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow");
  return t?.data.hold ? t : null;
};

/** A run of this request carried the review to the card's current head (scheduler-merge.ts carryReview, scheduler identity only). */
const carriedTo = (events: readonly LedgerEvent[], intentId: string, head: string | null): boolean =>
  !!head && events.some((e) => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === "review_carry" && e.data.intentId === intentId && e.data.to === head);

/**
 * Why this request may not merge now; null = it may. `run` = the request's own claimed intent is asking (begin / drift): its own
 * intent is not "another open intent", and a head its run carried counts as the bound head. Re-read on every call.
 */
export function requestRefusal(db: Database, req: ManualRequest, now: number, run = false): Refusal | null {
  const task = getTask(db, req.taskId), wf = task ? getWorkflow(db, task.id) : null;
  if (!task || task.project !== req.project) return { kind: "void", why: "卡不存在或已换项目" };
  if (revokeOf(db, req)) return { kind: "void", why: "请求已撤销" };
  if (!wf || wf.mode !== "manual") return { kind: "void", why: `流程是 ${wf?.mode ?? "缺流程"}，不是 manual（自动卡走自动合并闸）` };
  if (task.kind !== "code" || task.stage !== "merge") return { kind: "void", why: `卡在 ${task.stage}（${task.kind}），不在 merge` };
  const events = listEvents(db, { project: task.project, target: task.id });
  const id = manualIntentId(req.seq);
  if (task.headSHA !== req.head && !(run && carriedTo(events, id, task.headSHA))) return { kind: "void", why: `head 已变成 ${task.headSHA?.slice(0, 12) ?? "空"}` };
  if (task.specRev !== req.specRev || wf.specRev !== task.specRev || task.round !== req.round) return { kind: "void", why: "规格版本或轮次已变" };
  if (!SHA.test(task.headSHA ?? "") || !PR_URL.test(task.pr ?? "") || !task.branch) return { kind: "void", why: "卡缺完整 head / PR URL / 分支" };
  const review = reviewRefusal(db, task, events, req);
  if (review) return { kind: "void", why: review };
  if (wf.template === "ui") {
    if (task.extra.screenshotsDigest !== req.uiDigest) return { kind: "void", why: "UI 截图摘要已变" };
    const ui = uiMergeRefusal(db, task, now);
    if (ui) return { kind: "void", why: `UI 验收：${ui}` };
  }
  const frozen = getMeta(db, task.project).queueFrozen;
  if (frozen.frozen) return { kind: "wait", why: `项目合并队列已冻结：${frozen.reason || "无原因"}` };
  const hold = holdOf(events);
  if (hold) return { kind: "wait", why: `卡被明确留在人工（#${hold.seq}）` };
  const safety = openSafetyHold(events);
  if (safety) return { kind: "wait", why: `安全留证 #${safety.seq} 未处置` };
  const feature = task.featureId ? getFeature(db, task.featureId) : null;
  if (feature?.status === "paused") return { kind: "wait", why: `feature ${feature.id} 已暂停` };
  const asks = db.query("SELECT id FROM asks WHERE taskId = ? AND state = 'open'").all(task.id) as { id: string }[];
  if (asks.length) return { kind: "wait", why: `审批未答：${asks.map((a) => a.id).join("、")}` };
  const auth = authorizationRefusal(db, task.id, now);
  if (auth) return { kind: "wait", why: auth };
  const open = (db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')")
    .all(task.id) as { id: string; status: string }[]).filter((i) => !(run && i.id === id));
  if (open.length) return { kind: "wait", why: `卡有未结调度意图：${open.map((i) => `${i.id}(${i.status})`).join("、")}` };
  const deps = blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project)));
  if (deps.length) return { kind: "wait", why: `前置未完成：${deps.map((d) => d.from).join("、")}` };
  return null;
}

/** Phases in which nothing irreversible was sent. The `merging` claim is unsent too, but only its sender knows (`beforeSend`). */
const UNSENT: readonly string[] = ["ready", "updating", "await_ci"];
/** The driver's receipt prefix when its last check before the merge call refused: nothing went out (scheduler-merge-driver.ts). */
export const MERGE_NOT_SENT = "合并未发出";

/**
 * mergeRunDrift's manual branch: the run stops (and, before any merge was sent, ends cancelled) once its request no longer holds,
 * or — while nothing irreversible is out: `phase` ready / updating / await_ci, and the committed `merging` claim on the driver's last
 * check before the merge call (`beforeSend`, the only read that still knows nothing was sent) — once the manualMergeQueue policy is no
 * longer on (off, observe, or unreadable = off). A `merging` row seen anywhere else (restart, receipt) may have sent: its journal is
 * only verified, never re-sent, an unknown result stays unknown, and the policy is not asked.
 */
export function manualRunDrift(db: Database, intent: Pick<SchedulerIntent, "id">, now: number, phase?: string, beforeSend = false): string | null {
  const seq = requestSeqOf(intent.id), req = seq === null ? null : requestAt(db, seq);
  if (!req) return "人工合并请求缺失";
  const r = requestRefusal(db, req, now, true);
  if (r) return `人工合并请求已失效：${r.why}`;
  if (phase !== undefined && (UNSENT.includes(phase) || (phase === "merging" && beforeSend))) {
    const mode = manualQueueMode(req.project);
    if (mode !== "on") return `人工合并排队策略已是 ${mode}（不是 on），未发出的合并不再执行`;
  }
  return null;
}

/**
 * advanceMergeRun's `merging → unknown` on a manual card: a MERGE_NOT_SENT receipt is the sending controller itself saying its last
 * check refused and nothing went out, so the run ends cancelled with the slot freed (as any unsent manual run) instead of freezing the
 * queue. Any other receipt at `merging` is a result it could not verify and stays unknown.
 */
export function manualUnsentAtSend(db: Database, row: { phase: string; taskId: string }, receipt: string | undefined): boolean {
  return row.phase === "merging" && !!receipt?.startsWith(MERGE_NOT_SENT) && getWorkflow(db, row.taskId)?.mode === "manual";
}

/** beginMergeRun's reviewer for a manual run: the one its request bound, only while the request is valid. */
export function manualRunReviewer(db: Database, intent: Pick<SchedulerIntent, "id">, now: number): { agent: string; sessionId: string; family: AuthorFamily } | null {
  const seq = requestSeqOf(intent.id), req = seq === null ? null : requestAt(db, seq);
  if (!req || requestRefusal(db, req, now, true)) return null;
  return { agent: req.review.reviewer, sessionId: req.review.sessionId, family: req.review.family };
}
