/**
 * PM's notice when a card hits the review round cap (review-converge.ts roundCap): the card holds (no new work, mode stays
 * auto) and PM hears once per verdict, with every round's blocking P1s. The sent receipt survives restarts; a failed send
 * is retried next tick. The planner re-derives the hold from the ledger every pass. tests/scheduler-plan-converge.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask, listEvents, toEvent } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { MAX_REVIEW_ROUND, ROUND_CAP_CODE } from "./review-converge.js";
import { convergeReview } from "./review-converge.js";
import { convergeFollowUp, escalationFollowUp } from "./review-converge-followup.js";
import { fixDiffOf } from "./review-converge-scope.js";
import { convergeNoticeKey, followUpFailureText, isFailedFollowUp } from "./review-converge-notice-write.js";
import { createRetryDelay } from "./scheduler-create-retry.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { SchedulerLeaseLost } from "./scheduler-lease-env.js";
import { countsAsP1, currentReviewFacts, type ReviewFinding } from "./scheduler-review.js";

export const isRoundCap = (code: string): boolean => code === ROUND_CAP_CODE;
const PER_ROUND = 6;

/** One line per round: the P1s that still blocked then (named a basis, not demoted). */
export function p1Summary(events: readonly LedgerEvent[], upTo: number): string[] {
  const byRound = new Map<number, ReviewFinding[]>();
  for (const e of events) {
    if (e.kind === "review" && typeof e.data.round === "number" && e.data.round <= upTo && Array.isArray(e.data.findings)) {
      byRound.set(e.data.round, (e.data.findings as ReviewFinding[]).filter((f) => f && typeof f === "object" && countsAsP1(events, e.data.round as number, f)));
    }
  }
  return [...byRound.entries()].sort(([a], [b]) => a - b).map(([round, rows]) => {
    const names = rows.slice(0, PER_ROUND).map((f) => `${f.findingId}（${f.family}）`);
    return `r${round}：${rows.length ? names.join("、") + (rows.length > PER_ROUND ? ` 等 ${rows.length} 项` : "") : "无"}`;
  });
}

export function roundCapText(task: Pick<LedgerTask, "id" | "round">, events: readonly LedgerEvent[]): string {
  return `[调度引擎] ${task.id} 审查到第 ${task.round} 轮仍有挂验收线的 P1（上限 ${MAX_REVIEW_ROUND} 轮），已停下：不派新活，流程仍是 auto。` +
    `每轮 P1：${p1Summary(events, task.round).join("；")}。请拆卡或改规格后 workflow-resume 交回（规格不变时先 workflow-set --mode manual 再交回）。`;
}

/** Tell PM once per capped verdict; returns the card outcome detail. */
export async function roundCapNotice(db: Database, task: LedgerTask, notifyPm: (t: LedgerTask, text: string) => Promise<void>): Promise<string> {
  let events = listEvents(db, { project: task.project, target: task.id });
  const review = currentReviewFacts(task, events);
  if (review.kind === "facts") {
    const { downgrade } = convergeReview(events, review.facts, fixDiffOf(task, events));
    // A capped verdict has no stage move to carry its nonblocking findings; keep their drafts here instead.
    if (downgrade) tx(db, () => convergeFollowUp(db, { actor: "scheduler" }, task, downgrade));
    events = listEvents(db, { project: task.project, target: task.id });
  }
  const verdict = events.findLast((e) => e.kind === "review" && e.data.round === task.round)?.seq ?? 0;
  const key = `scheduler:review-cap:${task.id}:${verdict}`;
  if (getEventByDedup(db, key)) return `第 ${task.round} 轮到上限，等 PM 交回（已通知）`;
  const text = roundCapText(task, events);
  try {
    await notifyPm(task, text);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e; // a lost lease ends the pass, like every other notice in scheduler-auto-tick.ts
    console.error(`⚠️ [scheduler] 轮次上限通知没发出去（下个 tick 重发）：${(e as Error).message}`);
    return `第 ${task.round} 轮到上限，通知 PM 没发出去，下个 tick 重发`;
  }
  tx(db, () => {
    if (!getEventByDedup(db, key)) insertEvent(db, { actor: "scheduler", dedupKey: key }, {
      project: task.project, target: task.id, kind: "scheduler", text,
      data: { op: "review_round_hold", round: task.round, reviewSeq: verdict, informed: true },
    }, true);
  });
  return `第 ${task.round} 轮到上限，已通知 PM`;
}

/** What the failed follow-up notice needs: the PM channel, the scheduler-identity ledger CLI that records "informed", a clock. */
export interface FollowUpNoticeDeps {
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  manager(...args: string[]): Promise<Record<string, unknown>>;
  now(): number;
}
/** A sent notice whose "informed" record failed: what the CLI needs, and its createRetryDelay streak (2 → 15 min). */
interface Unrecorded { args: string[]; n: number; last: number }
/** Per ledger. Retried at the start of every auto pass (retryUnrecordedNotices), whatever the card's mode or stage. */
const unrecorded = new WeakMap<Database, Map<string, Unrecorded>>();

/** One record attempt. A lost lease ends the pass; any other refusal or throw (spawn / pipe) keeps it pending and backs off. */
async function recordInformed(db: Database, key: string, deps: FollowUpNoticeDeps): Promise<void> {
  const pending = unrecorded.get(db)?.get(key);
  if (!pending) return;
  if (getEventByDedup(db, key)) { unrecorded.get(db)!.delete(key); return; }
  if (pending.n > 0 && deps.now() - pending.last < createRetryDelay(pending.n)) return;
  let error: string;
  try {
    const r = await deps.manager("ledger", "scheduler-converge-notice", ...pending.args);
    if (r.code === "lease-lost") throw new SchedulerStopped(`scheduler-converge-notice: ${String(r.error)}`);
    if (r.ok === true) { unrecorded.get(db)!.delete(key); return; }
    error = String(r.error ?? r.code);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof SchedulerLeaseLost) throw new SchedulerStopped(`scheduler-converge-notice: ${e.message}`);
    error = (e as Error).message;
  }
  pending.n += 1; pending.last = deps.now();
  console.error(`⚠️ [scheduler] 后续节点失败通知已发出但未记账（第 ${pending.n} 次），${Math.round(createRetryDelay(pending.n) / 60_000)} 分钟后重试：${error}`);
}

/** A candidate source, kept raw: it is parsed inside its own card's isolation, so one bad row cannot hide the others. */
type SourceRow = Record<string, unknown> & { seq: number; project: string; target: string };
/** Per connection: every event up to `cursor` is swept; `open` holds the failed sources not yet seen informed. */
const sweeps = new WeakMap<Database, { cursor: number; open: Map<number, SourceRow> }>();

const RANGE = (p: string): string => `${p}dedupKey >= 'scheduler:converge:' AND ${p}dedupKey < 'scheduler:converge;' AND ${p}kind = 'scheduler'`;
// CASE (not OR) keeps json_* off a malformed row: it stays a candidate and fails in its own card instead of failing the query.
const MAYBE_FAILED = `CASE WHEN json_valid(data) THEN json_extract(data, '$.op') = 'review_downgrade'
  AND json_type(data, '$.followUpFailure') = 'text' ELSE 1 END`;

/**
 * Failed follow-ups with no "informed" record yet, all projects. A connection's first sweep (process start, a swapped ledger
 * file) reads the review_downgrade dedupKey range once, anti-joined with the notice key; later sweeps read only the events after
 * the cursor (`+` keeps the planner on the rowid range) and the open set shrinks as notices land, so a tick costs pending
 * sources plus new events, not the history. A throw leaves cursor and set unchanged. Mode / stage are not filtered.
 * tests/review-converge-notice-readonly.test.ts sweep-cost.
 */
function sweepFollowUpSources(db: Database): void {
  const sweep = sweeps.get(db);
  const cursor = (db.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m;
  if (!sweep) {
    const rows = db.query(`SELECT * FROM events d WHERE ${RANGE("d.")} AND d.seq <= ? AND ${MAYBE_FAILED}
      AND NOT EXISTS (SELECT 1 FROM events n WHERE n.dedupKey = 'scheduler:converge-notice:' || d.target || ':' || d.seq)`).all(cursor) as SourceRow[];
    sweeps.set(db, { cursor, open: new Map(rows.map((r) => [r.seq, r])) });
  } else if (cursor > sweep.cursor) {
    const rows = db.query(`SELECT * FROM events WHERE seq > ? AND seq <= ? AND ${RANGE("+")} AND ${MAYBE_FAILED}`).all(sweep.cursor, cursor) as SourceRow[];
    for (const r of rows) sweep.open.set(r.seq, r);
    sweep.cursor = cursor;
  }
}

/** One card's swept rows → its failed follow-ups still owed a notice. Informed / foreign rows leave the set for good. */
function cardSources(db: Database, task: LedgerTask, rows: readonly SourceRow[], failed: PassFailure[]): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const row of rows) {
    let e: LedgerEvent;
    try { e = toEvent(row); } catch (error) {
      // a corrupt source row is this card's read error: reported every pass, its other sources still go out
      const message = `后续节点失败通知：事件 ${row.seq} 读不出：${(error as Error).message}`;
      console.error(`⚠️ [scheduler] ${task.id} ${message}（下个 tick 重试）`);
      failed.push({ taskId: task.id, error: message });
      continue;
    }
    if (isFailedFollowUp(task, e) && !getEventByDedup(db, convergeNoticeKey(task.id, e.seq))) out.push(e);
    else sweeps.get(db)?.open.delete(e.seq);
  }
  return out;
}

type PassFailure = { taskId: string; error: string };
/** One card's notice work: a lost lease ends the pass; any other throw (a busy read, a bad row) is reported and the pass goes on. */
async function isolated(failed: PassFailure[], taskId: string, run: () => Promise<void>): Promise<void> {
  try { await run(); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    if (e instanceof SchedulerLeaseLost) throw new SchedulerStopped(`scheduler-converge-notice: ${e.message}`);
    const error = `后续节点失败通知：${(e as Error).message}`;
    console.error(`⚠️ [scheduler] ${taskId} ${error}（下个 tick 重试）`);
    failed.push({ taskId, error });
  }
}

/** The auto tick's per-pass retry of sent-but-unrecorded notices: a card that left auto / live still gets its record. */
export async function retryUnrecordedNotices(db: Database, deps: FollowUpNoticeDeps, projects: readonly string[]): Promise<PassFailure[]> {
  const failed: PassFailure[] = [];
  for (const [key, { args }] of [...(unrecorded.get(db) ?? [])]) await isolated(failed, args[0], () => recordInformed(db, key, deps));
  // The ledger is the durable pending source after a restart; mode/stage must not hide a failed follow-up.
  // With no in-memory send receipt, notify again before recording: absence of informed is not proof of delivery.
  // A failed sweep is reported as "*" and the sources swept before still go out: a busy read is not "no events".
  await isolated(failed, "*", async () => sweepFollowUpSources(db));
  const sources = [...(sweeps.get(db)?.open.values() ?? [])].filter((r) => projects.includes(r.project)).sort((a, b) => a.seq - b.seq);
  for (const [taskId, rows] of Map.groupBy(sources, (r) => r.target)) await isolated(failed, taskId, async () => {
    const task = getTask(db, taskId);
    if (task) await noticeSources(db, task, cardSources(db, task, rows, failed), deps);
  });
  return failed;
}

/**
 * Failed follow-ups stay visible to PM even after the original card advances to merge. The tick's connection is read-only:
 * once the notice is out, "informed" goes through `ledger scheduler-converge-notice` (review-converge-notice-write.ts). A failed
 * send records nothing and retries next tick; a sent one whose record fails is not re-sent in this process, only its record is
 * retried on backoff (also after the card leaves auto); a lost lease ends the pass.
 */
export async function followUpFailureNotice(db: Database, task: LedgerTask, deps: FollowUpNoticeDeps): Promise<void> {
  await noticeSources(db, task, listEvents(db, { project: task.project, target: task.id }).filter((e) => isFailedFollowUp(task, e)), deps);
}

async function noticeSources(db: Database, task: LedgerTask, failed: readonly LedgerEvent[], deps: FollowUpNoticeDeps): Promise<void> {
  const pending = unrecorded.get(db) ?? unrecorded.set(db, new Map()).get(db)!;
  for (const e of failed) {
    const key = convergeNoticeKey(task.id, e.seq);
    if (getEventByDedup(db, key)) { pending.delete(key); continue; }
    if (!pending.has(key)) {
      try { await deps.notifyPm(task, followUpFailureText(task.id, e)); }
      catch (error) {
        if (error instanceof SchedulerStopped) throw error;
        console.error(`[scheduler] 后续节点失败通知未发送，下个 tick 重试：${(error as Error).message}`);
        return;
      }
      pending.set(key, { args: [task.id, "--downgrade-seq", String(e.seq), "--round", String(e.data.round), "--head", String(e.data.head ?? "")], n: 0, last: 0 });
    }
    await recordInformed(db, key, deps);
  }
}

/** Review demotions survive automatic exits; failure informs are sent before the card stops receiving auto ticks. */
export async function escalationWithFollowUp<T>(db: Database, task: LedgerTask,
  plan: { code: string; reason: string; reviewSeq?: number; downgrade?: import("./review-converge.js").Downgrade },
  deps: FollowUpNoticeDeps, fallback: (reason: string) => Promise<T>): Promise<T> {
  escalationFollowUp(db, task, plan);
  await followUpFailureNotice(db, task, deps);
  return fallback(`${plan.code}：${plan.reason}`);
}
