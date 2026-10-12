/**
 * Unified merge queue facts (merge-arch-QUEUE1): one read-only view of every card of a project that waits to merge — auto cards
 * and PM's manual merge requests — as QueueEntry rows in one stable order: the seq at which the card's current version entered
 * the queue. ui is a flag on the entry (screenshots digest), not a third queue.
 *
 * Admission is never decided here. An auto entry is ready only when mergeCandidates (the train / auto gate's own filter, ui
 * included) lists it; a manual entry only when its request's own status (manualQueueView → requestStatus → requestRefusal) is
 * queued. Every other entry carries a reason code and text: blocked (may clear and keep its place) or excluded (not this
 * machine's queue, or already landed). "ready" is a fact, not an authorization: nothing here claims, moves a stage or writes.
 *
 * Queue place (versionSeq): auto = the latest `stage → merge` event (mergeEntry, the seq the auto tick orders by), kept across a
 * trusted scheduler review_carry (same round / specRev, with the net-diff digest it proved); any other head move after entry —
 * a carry without a digest (old records: the conservative head version, never guessed equal) or a hand `set` that really changes
 * headSHA — takes the place of that event; a `set` repeating the recorded head keeps the place. manual = the request's event seq. updatedAt and pass cursors play no part. WIPGATE1's depth stays
 * mergeQueueCards (ledger-merge-queue-view.ts); this view does not feed it.
 *
 * QueueEventFields / queueEventKey are the shape later action cards record (queue_enter / claim / landed / blocked / withdrawn);
 * an observe-mode record is marked predicted and keyed apart, so it never reads as a real queue event.
 */
import type { Database } from "bun:sqlite";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getMeta, getTask, listEvents } from "./ledger-store.js";
import { manualQueueView, type ManualQueueRow } from "./manual-merge-queue.js";
import { configHandoff, listRequests, SHA, type HandoffPort, type ManualRequest } from "./manual-merge-queue-facts.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { getMergeRun } from "./scheduler-merge.js";
import { mergeEntry } from "./scheduler-merge-order.js";
import { mergeCandidates } from "./scheduler-merge-train-tick.js";
import { cardRepo, foreignRepoOf, projectRepoFor } from "./scheduler-foreign-repo.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";

type QueueSource = "auto" | "manual";
/** ready = the existing gate admits it now; running = its merge run holds the slot; blocked = waits in place; excluded = not queued. */
type QueueState = "ready" | "running" | "blocked" | "excluded";
type QueueReasonCode =
  | "shared_ledger_skip" | "merge_handoff" | "foreign_repo" | "landed" | "missing_evidence" | "frozen" | "owner_hold" | "unknown_run"
  | "not_candidate" | "manual_no_request" | "manual_waiting" | "manual_void" | "withdrawn" | "manual_ended" | "duplicate_request";

export interface QueueEntry {
  /** owner/repo, lowercased: the card's PR repository, else the project's; null = unknown */
  repository: string | null;
  project: string; taskId: string; pr: string | null; source: QueueSource;
  /** the version this entry is about: the card's for auto, the request's binding for manual */
  head: string | null; specRev: number; round: number;
  /** the structured review event the entry stands on (the request's bound one for manual) */
  reviewSeq: number | null;
  ui: { template: boolean; digest: string | null };
  manualRequestSeq: number | null;
  /** queue place; null = none (no stage entry event, or a manual card without a valid request): after every placed entry */
  versionSeq: number | null;
  state: QueueState;
  reason: { code: QueueReasonCode; why: string } | null;
  /** merge run phase when a run exists */
  phase: string | null;
}

export interface QueueFactsPorts {
  handoff?: HandoffPort;
  /** shared-ledger route: the card belongs to another authority this pass (S2D2 skip) */
  skip?: (db: Database, taskId: string) => boolean;
  repo?: (project: string) => string | null;
}

/** What every entry of one read shares: the ledger, the ports and the project's repository. */
interface Read { db: Database; ports: Required<QueueFactsPorts>; repo: string | null }

interface HeadMove { seq: number; from: string | null; to: string; trusted: boolean }

/** A carry the scheduler wrote for this round / specRev with the net-diff digest it proved (scheduler-merge.ts carryReview). */
const trustedCarry = (e: LedgerEvent, task: Pick<LedgerTask, "round" | "specRev">): boolean =>
  e.actor === "scheduler" && e.data.round === task.round && e.data.specRev === task.specRev &&
  typeof e.data.diffHash === "string" && e.data.diffHash.length > 0 && SHA.test(String(e.data.from));

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * The card head an event records: written by it (task new / set, deliver, carry, fix start / relay, stage) or, for a review, the
 * head that review judged (the version the merge gate binds to).
 */
function headOnRecord(e: LedgerEvent): string | null {
  const d = e.data;
  if (e.kind === "task" && (d.op === "new" || d.op === "set")) return str((d.patch as Record<string, unknown> | undefined)?.headSHA);
  if (e.kind === "deliver") return str(d.headSHA);
  if (e.kind === "stage" || e.kind === "review") return str(d.head);
  if (e.kind !== "scheduler") return null;
  return d.op === "review_carry" ? str(d.to) : d.op === "fix_start_moved" ? str(d.newHead) : d.op === "fix_relay" ? str(d.head) : null;
}

/**
 * Head moves after `after`. A `set` naming the head the card already had (the last head on record before it) moves nothing;
 * a `set` whose preceding head is not on record is a new version (conservative, never guessed equal).
 */
function headMoves(events: readonly LedgerEvent[], task: LedgerTask, after: number): HeadMove[] {
  let prev: string | null = null;
  const out: HeadMove[] = [];
  for (const e of events) {
    const to = headOnRecord(e);
    if (to === null) continue;
    const before = prev;
    prev = to;
    if (e.seq <= after) continue;
    if (e.kind === "scheduler" && e.data.op === "review_carry") out.push({ seq: e.seq, from: String(e.data.from), to, trusted: trustedCarry(e, task) });
    else if (e.kind === "task" && e.data.op === "set" && before?.toLowerCase() !== to.toLowerCase()) out.push({ seq: e.seq, from: null, to, trusted: false });
  }
  return out;
}

/**
 * The seq at which the card's current head version entered the merge queue: walk back from the current head through the head
 * moves after `entry`; a trusted carry hands the place to its `from`, anything else is a new version queued at its own seq.
 */
export function versionSeqOf(task: LedgerTask, events: readonly LedgerEvent[], entry: number | null): number | null {
  if (entry === null) return null;
  const moves = headMoves(events, task, entry);
  let head = task.headSHA, bound = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const m = moves.findLast((x) => x.seq < bound && x.to.toLowerCase() === head?.toLowerCase());
    if (!m) return entry;
    if (!m.trusted) return m.seq;
    head = m.from; bound = m.seq;
  }
}

/** Facts every entry of a card shares, judged before its source's own gate (first match wins). */
function cardExclusion({ db, ports, repo }: Read, task: LedgerTask): QueueEntry["reason"] {
  if (ports.skip(db, task.id)) return { code: "shared_ledger_skip", why: "共享台账路由：这张卡此刻不归本机调度" };
  if (ports.handoff(task.project)) return { code: "merge_handoff", why: `项目 ${task.project} 是仓库方交接（mergeHandoff），本机不排合并` };
  const foreign = foreignRepoOf(task, repo);
  if (foreign) return { code: "foreign_repo", why: `卡在 ${foreign}，不是项目自动合并的仓库` };
  if (task.headSHA && db.query("SELECT 1 FROM scheduler_merges WHERE taskId = ? AND lower(reviewedHead) = lower(?) AND phase = 'merged'").get(task.id, task.headSHA)) {
    return { code: "landed", why: "本 head 已合并，等部署 / PM 收尾，不在待合队列" };
  }
  return null;
}

/** The card-level wait reasons both sources share, in the order a reader should see them. */
function cardWait(db: Database, task: LedgerTask, events: readonly LedgerEvent[]): QueueEntry["reason"] {
  if (!SHA.test(task.headSHA ?? "") || !task.pr || !task.branch) return { code: "missing_evidence", why: "卡缺完整 head / PR / 分支" };
  const frozen = getMeta(db, task.project).queueFrozen;
  if (frozen.frozen) return { code: "frozen", why: `项目合并队列已冻结：${frozen.reason || "无原因"}` };
  const wf = events.findLast((e) => e.kind === "scheduler" && e.data.op === "workflow");
  if (wf?.data.hold) return { code: "owner_hold", why: `卡被明确留在人工（#${wf.seq}）` };
  const unknown = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'merge' AND status = 'unknown'").get(task.id) as { id: string } | null;
  if (unknown) return { code: "unknown_run", why: `合并运行 ${unknown.id} 结果不明，等 PM 核对` };
  return null;
}

const openMergeRun = (db: Database, taskId: string): { id: string; phase: string | null } | null => {
  const i = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND action = 'merge' AND status IN ('pending','submitted')").get(taskId) as { id: string } | null;
  return i ? { id: i.id, phase: getMergeRun(db, i.id)?.phase ?? null } : null;
};

const currentReviewSeq = (events: readonly LedgerEvent[], round: number): number | null =>
  events.findLast((e) => e.kind === "review" && e.data.round === round)?.seq ?? null;

function baseEntry(task: LedgerTask, repo: string | null, template: string | undefined, source: QueueSource): QueueEntry {
  const digest = task.extra.screenshotsDigest;
  return { repository: cardRepo(task) ?? repo?.toLowerCase() ?? null, project: task.project, taskId: task.id, pr: task.pr, source,
    head: task.headSHA, specRev: task.specRev, round: task.round, reviewSeq: null, ui: { template: template === "ui", digest: typeof digest === "string" ? digest : null },
    manualRequestSeq: null, versionSeq: null, state: "blocked", reason: null, phase: null };
}

function autoEntry(r: Read, task: LedgerTask, base: QueueEntry, events: readonly LedgerEvent[], candidates: ReadonlySet<string>): QueueEntry {
  const db = r.db;
  const e = { ...base, reviewSeq: currentReviewSeq(events, task.round), versionSeq: versionSeqOf(task, events, mergeEntry(db, task.id)?.seq ?? null) };
  const excluded = cardExclusion(r, task);
  if (excluded) return { ...e, state: "excluded", reason: excluded };
  const run = openMergeRun(db, task.id);
  if (run) return { ...e, state: "running", phase: run.phase };
  const wait = cardWait(db, task, events);
  if (wait) return { ...e, reason: wait };
  if (candidates.has(task.id)) return { ...e, state: "ready" };
  return { ...e, reason: { code: "not_candidate", why: "未过自动合并准入（mergeCandidates：审查结论 / UI 验收 / 规格版本 / 未结合并运行）" } };
}

const MANUAL_OPEN: readonly string[] = ["queued", "waiting", "running", "unknown"];

/** A manual request's entry, its state read from the request's own status (never re-judged here). */
function requestEntry(r: Read, task: LedgerTask, base: QueueEntry, req: ManualRequest, row: ManualQueueRow, first: boolean): QueueEntry {
  const e = { ...base, head: req.head, specRev: req.specRev, round: req.round, reviewSeq: req.review.seq, manualRequestSeq: req.seq, versionSeq: req.seq,
    ui: { ...base.ui, digest: req.uiDigest }, phase: row.phase };
  const open = MANUAL_OPEN.includes(row.state);
  if (open && !first) return { ...e, state: "excluded", reason: { code: "duplicate_request", why: "同卡已有更早的未结人工合并请求" } };
  const excluded = cardExclusion(r, task);
  // a running request keeps its card-level visibility, except once its head has landed (merged, awaiting deploy / cleanup)
  if (excluded && (row.state !== "running" || excluded.code === "landed")) return { ...e, state: "excluded", reason: excluded };
  const why = row.why ?? "";
  switch (row.state) {
    case "queued": return { ...e, state: "ready" };
    case "running": return { ...e, state: "running" };
    case "unknown": return { ...e, reason: { code: "unknown_run", why: `人工合并结果不明，等 PM 核对：${why}` } };
    case "waiting": return { ...e, reason: cardWait(r.db, task, listEvents(r.db, { project: task.project, target: task.id })) ?? { code: "manual_waiting", why } };
    case "revoked": return { ...e, state: "excluded", reason: { code: "withdrawn", why } };
    case "void": return { ...e, state: "excluded", reason: { code: "manual_void", why } };
    default: return { ...e, state: "excluded", reason: { code: "manual_ended", why: `${row.state}：${why}` } };
  }
}

function manualEntries(r: Read, task: LedgerTask, base: QueueEntry, rows: readonly ManualQueueRow[], reqs: ReadonlyMap<number, ManualRequest>): QueueEntry[] {
  const mine = rows.filter((r) => r.task === task.id);
  let seenOpen = false;
  const out = mine.map((row) => {
    const first = !seenOpen;
    if (MANUAL_OPEN.includes(row.state)) seenOpen = true;
    return requestEntry(r, task, base, reqs.get(row.request)!, row, first);
  });
  if (seenOpen) return out;
  const events = listEvents(r.db, { project: task.project, target: task.id });
  const excluded = cardExclusion(r, task);
  const reason = excluded ?? cardWait(r.db, task, events) ?? { code: "manual_no_request", why: "人工卡没有有效的 PM 合并请求，不排队" };
  return [...out, { ...base, reviewSeq: currentReviewSeq(events, task.round), state: excluded ? "excluded" : "blocked", reason }];
}

/** Placed entries by versionSeq, then the unplaced ones; ties by source then task id, so the order never depends on read order. */
const compareEntries = (a: QueueEntry, b: QueueEntry): number =>
  (a.versionSeq ?? Number.MAX_SAFE_INTEGER) - (b.versionSeq ?? Number.MAX_SAFE_INTEGER) || a.source.localeCompare(b.source) ||
  a.taskId.localeCompare(b.taskId) || (a.manualRequestSeq ?? 0) - (b.manualRequestSeq ?? 0);

/** The unified read-only queue of one project. Pure reads only. */
export function mergeQueueFacts(db: Database, project: string, now: number, ports: QueueFactsPorts = {}): QueueEntry[] {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return [];
  const p: Required<QueueFactsPorts> = { handoff: configHandoff, skip: schedulerV2SkipTask, repo: projectRepoFor, ...ports };
  const repo = p.repo(project), r: Read = { db, ports: p, repo };
  const cards = db.query(`SELECT t.id, w.mode, w.template FROM tasks t JOIN task_workflows w ON w.taskId = t.id
    WHERE t.project = ? AND t.kind = 'code' AND t.stage = 'merge' ORDER BY t.id`).all(project) as { id: string; mode: string; template: string }[];
  const candidates = new Set(mergeCandidates(db, project, { now }).map((c) => c.taskId));
  const rows = manualQueueView(db, project, "none", now).rows;
  const reqs = new Map(listRequests(db, project).map((r) => [r.seq, r]));
  const out: QueueEntry[] = [];
  for (const { id, mode, template } of cards) {
    const task = getTask(db, id)!, base = baseEntry(task, repo, template, mode === "manual" ? "manual" : "auto");
    if (mode === "manual") out.push(...manualEntries(r, task, base, rows, reqs));
    else out.push(autoEntry(r, task, base, listEvents(db, { project, target: id }), candidates));
  }
  // a request whose card left merge or manual mode still reads (void / ended) so PM sees why it no longer queues
  const listed = new Set(out.map((e) => e.manualRequestSeq));
  for (const row of rows.filter((r) => !listed.has(r.request))) {
    const req = reqs.get(row.request)!, task = getTask(db, req.taskId);
    if (task) out.push(requestEntry(r, task, baseEntry(task, repo, getWorkflow(db, task.id)?.template, "manual"), req, row, true));
  }
  return out.sort(compareEntries);
}

// ── event fields for the later action cards ──

const QUEUE_EVENT_OP = "merge_queue";
export const QUEUE_EVENT_KINDS = ["queue_enter", "claim", "landed", "blocked", "withdrawn"] as const;
export type QueueEventKind = (typeof QUEUE_EVENT_KINDS)[number];

export interface QueueEventFields {
  op: typeof QUEUE_EVENT_OP; event: QueueEventKind;
  /** true = observe mode: what would happen, not a queue event */
  predicted: boolean;
  repository: string | null; taskId: string; source: QueueSource; head: string | null; specRev: number; round: number;
  versionSeq: number | null; reviewSeq: number | null; manualRequestSeq: number | null; reason: QueueReasonCode | null;
}

/** The unifiedMergeQueue switch for the later action cards (CFG's RecoveryPolicyPort, default observe); a read that throws is off. */
export function unifiedQueueMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { return policy(project, "unifiedMergeQueue").mode; } catch { return "off"; }
}

export function queueEventFields(entry: QueueEntry, event: QueueEventKind, mode: "on" | "observe"): QueueEventFields {
  return { op: QUEUE_EVENT_OP, event, predicted: mode !== "on", repository: entry.repository, taskId: entry.taskId, source: entry.source,
    head: entry.head, specRev: entry.specRev, round: entry.round, versionSeq: entry.versionSeq, reviewSeq: entry.reviewSeq,
    manualRequestSeq: entry.manualRequestSeq, reason: entry.reason?.code ?? null };
}

/** One event per (prediction?, kind, repository, card, source, version, request, reason): a replay of the same fact dedups. */
export const queueEventKey = (f: QueueEventFields): string =>
  [f.predicted ? "mq-observe" : "mq", f.event, f.repository ?? "-", f.taskId, f.source, f.versionSeq ?? "-", f.manualRequestSeq ?? "-", f.reason ?? "-"].join(":");
