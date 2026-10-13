/**
 * merge-arch-SLA1 bookkeeping, behind `ledger scheduler-manual-case-sla` (scheduler identity, leased writer). The durable reminder key
 * is project / task / episode (entry seq) and nothing else: head, notes, the responsible and the deadline may all change inside an
 * episode without a second reminder. claim re-reads the episode (VIEW1 row with OWN1's responsible and deadline), its recovery state and
 * the switch inside one immediate transaction and writes a note on the card carrying the snapshot the message is built from. The batch
 * outcome is one project-level note: sent, unknown (may have been delivered: never sent again) or unsent (definitely not delivered: the
 * episodes may be claimed again). A claim with no outcome reads as unknown. observe writes one project-level would-notify note per
 * episode and never a claim. Nothing here touches a workflow, a stage, a slot, a request or a recovery grant. tests/manual-case-sla*.test.ts.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { busyAsLedgerError, getEventByDedup, getMeta, getTask, LedgerError, listEvents } from "./ledger-store.js";
import { appendEvent } from "./ledger-write.js";
import { defaultOwner } from "./manual-case-defaults.js";
import { MANUAL_CASE_SLA_KEY, manualCaseSlaMode, SLA_BATCH_OP, SLA_CLAIM_OP, slaClaims, type SlaClaim } from "./manual-case-sla-compat.js";
import { manualCaseView } from "./manual-case-view.js";
import type { TrainSignal } from "./manual-merge-queue.js";
import type { ExplicitPolicyPort } from "./manual-recovery-policy.js";
import { USAGE_DB_PATH } from "./usage-store.js";

export type SlaOutcome = "sent" | "unknown" | "unsent";
export type SlaState = "none" | "claimed" | SlaOutcome;
export const SLA_OUTCOMES: readonly SlaOutcome[] = ["sent", "unknown", "unsent"];
const OBSERVE_OP = "recovery_observe";
const NOT_REMINDED: readonly string[] = ["verified", "done", "cancelled"];

const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
/** Hashed: the ledger takes any card id, a dedup key stays fixed-length and unambiguous. Attempt n ≥ 2 is `key#n`. */
const slaEpisodeKey = (project: string, taskId: string, entrySeq: number) => `manual-case-sla-v1:${hash([project, taskId, entrySeq])}`;
export const slaObserveKey = (project: string, taskId: string, entrySeq: number) => `${slaEpisodeKey(project, taskId, entrySeq)}:observe`;
const batchKey = (project: string, batchId: string) => `manual-case-sla-batch-v1:${hash([project, batchId])}`;
const iso = (ms: number) => new Date(ms).toISOString();
const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);
const tx = <T>(db: Database, fn: () => T): T => busyAsLedgerError("写入", () => db.transaction(fn).immediate());

/** One overdue manual episode as the reminder states it; the claim stores exactly this. */
export interface SlaCase {
  taskId: string; title: string; stage: string; entrySeq: number;
  /** the PM who gets the batch: the responsible when that is a valid PM, else the PM tracking the card (owner / executor are not woken) */
  pm: string;
  responsible: string; role: string; dueAt: number; overdueMin: number; ageMin: number | null;
  reason: string; next: string;
  /** looks recoverable on read-only facts but no recovery ran: said in the reminder, never acted on here */
  candidate: boolean;
}

/**
 * Overdue, still open manual episodes of the project, read after this round's recoveries: a card handed back is no longer manual, a
 * terminal / verified one or one whose manual merge request merged is left out, an episode without a formal entry or deadline has no SLA.
 */
export function slaCases(db: Database, project: string, now: number, train: TrainSignal): SlaCase[] {
  const meta = getMeta(db, project), out: SlaCase[] = [];
  for (const r of manualCaseView(db, project, train, now).active) {
    if (r.episodeId === null || r.due.at === null || now <= r.due.at || NOT_REMINDED.includes(r.stage) || r.request?.state === "merged") continue;
    const task = getTask(db, r.taskId);
    if (!task) continue;
    const tracker = defaultOwner(task, meta);
    const pm = r.owner.role === "pm" && r.owner.who ? r.owner.who : tracker.role === "pm" ? tracker.who : "master";
    const o = r.owner as typeof r.owner & { next?: string | null };
    out.push({ taskId: r.taskId, title: oneLine(r.title, 80), stage: r.stage, entrySeq: r.episodeId, pm, responsible: r.owner.who ?? pm, role: r.owner.role,
      dueAt: r.due.at, overdueMin: Math.floor((now - r.due.at) / 60_000), ageMin: r.ageMin,
      reason: oneLine(`${r.label}${r.reasonCode ? `（${r.reasonCode}${r.subreason ? `/${r.subreason}` : ""}）` : ""}`, 120),
      next: oneLine(o.next ? `${o.next}（PM 指派）` : r.nextStep, 300), candidate: r.candidate });
  }
  return out;
}

/** Where one episode stands: the outcome of the batch its latest claim went into; a claim without an outcome stays "claimed". */
export function slaEpisodeState(db: Database, project: string, events: readonly LedgerEvent[], entrySeq: number): { state: SlaState; claim: SlaClaim | null } {
  const claim = slaClaims(events, entrySeq).at(-1) ?? null;
  if (!claim) return { state: "none", claim };
  const state = getEventByDedup(db, batchKey(project, claim.batchId))?.data.state;
  return { state: SLA_OUTCOMES.includes(state as SlaOutcome) ? state as SlaOutcome : "claimed", claim };
}

/** When this PM was last claimed a batch in the project (sent or not): the next batch waits a window from it. */
export function slaLastClaimAt(db: Database, project: string, pm: string): number | null {
  const r = db.query("SELECT MAX(ts) AS ts FROM events WHERE project = ? AND kind = 'note' AND json_extract(data, '$.op') = ? AND json_extract(data, '$.pm') = ?")
    .get(project, SLA_CLAIM_OP, pm) as { ts: number | null };
  return r.ts;
}

interface EpisodeInput { phase: "claim" | "observe"; taskId: string; entrySeq: number; pm: string; batchId: string }
interface BatchInput { phase: SlaOutcome; taskId: string; pm: string; batchId: string; episodes: readonly (readonly [string, number])[]; receipt?: string; summary?: string }
export type ManualCaseSlaInput = EpisodeInput | BatchInput;

/** Re-read under the transaction; a card that is no longer an overdue open episode of this PM is refused (the tick drops it from the batch). */
function currentCase(db: Database, project: string, input: { taskId: string; entrySeq: number; pm: string }, now: number, train: TrainSignal): SlaCase {
  const c = slaCases(db, project, now, train).find((x) => x.taskId === input.taskId);
  if (!c) throw new LedgerError("conflict", `${input.taskId} 已不是逾期待处置的 manual 段（已恢复 / 终态 / 期限已改 / 人工合并已完成），不提醒`);
  if (c.entrySeq !== input.entrySeq) throw new LedgerError("conflict", `${input.taskId} 当前段是 #${c.entrySeq}（调用方读到 #${input.entrySeq}），新段按自己的期限算`);
  if (c.pm !== input.pm) throw new LedgerError("conflict", `${input.taskId} 现在归 ${c.pm} 汇总（调用方读到 ${input.pm}），下一轮重读`);
  return c;
}

function claimEpisode(db: Database, project: string, input: EpisodeInput, now: number, train: TrainSignal) {
  const c = currentCase(db, project, input, now, train);
  const st = slaEpisodeState(db, project, listEvents(db, { project, target: c.taskId }), c.entrySeq);
  if (st.state !== "none" && st.state !== "unsent") return { ok: true, recorded: false, state: st.state, batchId: st.claim!.batchId };
  const attempt = (st.claim?.attempt ?? 0) + 1, key = slaEpisodeKey(project, c.taskId, c.entrySeq);
  const ev = appendEvent(db, { actor: "scheduler", now, dedupKey: attempt === 1 ? key : `${key}#${attempt}` }, { project, target: c.taskId, kind: "note",
    text: oneLine(`人工卡逾期提醒已认领：段 #${c.entrySeq} 并入批次 ${input.batchId}（给 ${c.pm}${attempt > 1 ? `，第 ${attempt} 次` : ""}）；本段不再逐卡提醒`, 300),
    data: { op: SLA_CLAIM_OP, state: "claimed", batchId: input.batchId, attempt, ...c } });
  return ev.duplicate ? { ok: true, recorded: false, state: "claimed", batchId: String(ev.event.data.batchId) } : { ok: true, recorded: true, seq: ev.event.seq, attempt, snapshot: c };
}

function observeEpisode(db: Database, project: string, input: EpisodeInput, now: number, train: TrainSignal) {
  const c = currentCase(db, project, input, now, train);
  // project level (target ""): a note on the card would reset the idle clock of the older stall notices, which observe must not touch
  const ev = appendEvent(db, { actor: "scheduler", now, dedupKey: slaObserveKey(project, c.taskId, c.entrySeq) }, { project, target: "", kind: "note",
    text: oneLine(`恢复观察（${MANUAL_CASE_SLA_KEY}）：本会把 ${c.taskId} 段 #${c.entrySeq}（责任 ${c.responsible}，期限 ${iso(c.dueAt)}）并入给 ${c.pm} 的逾期提醒 ${input.batchId}`, 400),
    data: { op: OBSERVE_OP, mechanism: MANUAL_CASE_SLA_KEY, actionKey: `notify.${c.taskId}.${c.entrySeq}`,
      wouldNotify: { batchId: input.batchId, pm: c.pm, taskId: c.taskId, entrySeq: c.entrySeq, responsible: c.responsible, role: c.role, dueAt: c.dueAt, candidate: c.candidate } } });
  return { ok: true, recorded: !ev.duplicate, seq: ev.event.seq };
}

function settleBatch(db: Database, project: string, input: BatchInput, now: number) {
  const episodes: Record<string, unknown>[] = [];
  for (const [taskId, entrySeq] of input.episodes) {
    const claim = slaClaims(listEvents(db, { project, target: taskId }), entrySeq).findLast((c) => c.batchId === input.batchId);
    if (claim) episodes.push({ taskId, entrySeq, claimSeq: claim.seq, responsible: claim.responsible, role: claim.role, dueAt: claim.dueAt });
  }
  if (!episodes.length) throw new LedgerError("conflict", `批次 ${input.batchId} 没有已认领的段，不记结果`);
  const ev = appendEvent(db, { actor: "scheduler", now, dedupKey: batchKey(project, input.batchId) }, { project, target: "", kind: "note",
    text: oneLine(`人工卡逾期合并提醒 ${input.batchId} → ${input.pm}：${episodes.length} 段，${input.phase === "sent" ? "已送达" : input.phase === "unknown"
      ? "投递结果不明（不自动重发，待 PM 核对）" : "确定未发出（保留待发送）"}`, 300),
    data: { op: SLA_BATCH_OP, batchId: input.batchId, state: input.phase, pm: input.pm, count: episodes.length, episodes,
      receipt: input.receipt ? oneLine(input.receipt, 300) : null, summary: input.summary ? oneLine(input.summary, 300) : null } });
  // the first recorded outcome stands: a late "unsent" can never reopen a batch already recorded sent / unknown
  return { ok: true, recorded: !ev.duplicate, state: String(ev.event.data.state), seq: ev.event.seq };
}

/** The leased writer. `active` = lease held and the project under automatic dispatch, asked again inside the transaction. */
export function writeManualCaseSla(db: Database, ctx: WriteCtx, input: ManualCaseSlaInput, active: () => void, train: TrainSignal, port?: ExplicitPolicyPort) {
  return tx(db, () => {
    active();
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "逾期提醒记账只给调度服务");
    const task = getTask(db, input.taskId);
    if (!task) throw new LedgerError("not_found", `没有任务 ${input.taskId}`);
    const now = ctx.now ?? Date.now();
    if ("episodes" in input) return settleBatch(db, task.project, input, now); // an outcome is recorded whatever the switch says now
    const m = manualCaseSlaMode(task.project, port), want = input.phase === "claim" ? "on" : "observe";
    if (m.mode !== want) throw new LedgerError("forbidden", `${MANUAL_CASE_SLA_KEY} 当前是 ${m.mode}（${m.why}），不按 ${want} 写`);
    return input.phase === "claim" ? claimEpisode(db, task.project, input, now, train) : observeEpisode(db, task.project, input, now, train);
  });
}

// ── read side: `ledger manual-queue` shows it ──

interface BatchRow { batchId: string; state: SlaOutcome; pm: string; count: number; ts: number; episodes: { taskId: string; entrySeq: number }[]; receipt: string | null }
export interface ManualCaseSlaReport {
  batches: Record<SlaOutcome, number>;
  /** claims with no recorded outcome (crash / lost lease after the claim): unknown, not sent again */
  dangling: { taskId: string; entrySeq: number; batchId: string }[];
  /** episodes whose reminder may or may not have reached the PM: for the PM to check */
  unknown: { taskId: string; entrySeq: number; batchId: string }[];
  /** episodes that appear in more than one sent / unknown batch; the mechanism's own invariant is 0 */
  repeated: number;
  /** null = not linkable to usage rows: reported as unknown, never estimated */
  cost: { deliveries: number; wakeTurns: number | null; input: number | null; cacheRead: number | null; cacheCreation: number | null; output: number | null; unlinked: number; why: string | null };
}

function batchRows(db: Database, project: string, sinceMs: number): BatchRow[] {
  const rows = db.query("SELECT ts, data FROM events WHERE project = ? AND target = '' AND kind = 'note' AND ts >= ? AND json_extract(data, '$.op') = ? ORDER BY seq")
    .all(project, sinceMs, SLA_BATCH_OP) as { ts: number; data: string }[];
  return rows.map((r) => {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    return { batchId: String(d.batchId), state: d.state as SlaOutcome, pm: String(d.pm), count: Number(d.count), ts: r.ts,
      episodes: (Array.isArray(d.episodes) ? d.episodes : []) as BatchRow["episodes"], receipt: typeof d.receipt === "string" ? d.receipt : null };
  });
}

/** Usage rows are linked by the batch id the message starts with (the turn's trigger summary keeps it); no usage db or no such turn = unknown. */
function batchCost(woke: readonly BatchRow[], usage: Database | null | undefined): ManualCaseSlaReport["cost"] {
  const none = { wakeTurns: null, input: null, cacheRead: null, cacheCreation: null, output: null };
  let own: Database | null = null;
  try {
    const db = usage === undefined ? (existsSync(USAGE_DB_PATH) ? (own = new Database(USAGE_DB_PATH, { readonly: true })) : null) : usage;
    if (!db) return { deliveries: woke.length, ...none, unlinked: woke.length, why: "没有用量库，叫醒回合与 token 未知" };
    const sum = { wakeTurns: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
    let unlinked = 0;
    for (const b of woke) {
      const turns = db.query(`SELECT t.turn_id AS id, COALESCE(SUM(c.input), 0) AS i, COALESCE(SUM(c.cache_read), 0) AS r, COALESCE(SUM(c.cache_creation), 0) AS w,
        COALESCE(SUM(c.output), 0) AS o FROM turns t LEFT JOIN calls c ON c.turn_id = t.turn_id WHERE instr(t.trigger, ?) > 0 GROUP BY t.turn_id`)
        .all(b.batchId) as { id: string; i: number; r: number; w: number; o: number }[];
      if (!turns.length) { unlinked++; continue; }
      for (const t of turns) { sum.wakeTurns++; sum.input += t.i; sum.cacheRead += t.r; sum.cacheCreation += t.w; sum.output += t.o; }
    }
    if (unlinked === woke.length) return { deliveries: woke.length, ...none, unlinked, why: woke.length ? "用量库里关联不到这些批次的回合，叫醒回合与 token 未知" : null };
    return { deliveries: woke.length, ...sum, unlinked, why: unlinked ? `${unlinked} 个批次关联不到回合，合计只含可关联的` : null };
  } catch (e) {
    return { deliveries: woke.length, ...none, unlinked: woke.length, why: `用量库读不了，叫醒回合与 token 未知：${oneLine((e as Error).message, 120)}` };
  } finally { own?.close(); }
}

/** Batches, repeats, unknowns and the wake cost of the project's reminders since `sinceMs`; read-only. usage: undefined = the default usage db. */
export function manualCaseSlaReport(db: Database, project: string, sinceMs = 0, usage?: Database | null): ManualCaseSlaReport {
  const rows = batchRows(db, project, sinceMs), settled = new Set(batchRows(db, project, 0).map((b) => b.batchId));
  const batches: Record<SlaOutcome, number> = { sent: 0, unknown: 0, unsent: 0 };
  const seen = new Map<string, number>(), unknown: ManualCaseSlaReport["unknown"] = [];
  for (const b of rows) {
    if (!SLA_OUTCOMES.includes(b.state)) continue;
    batches[b.state]++;
    if (b.state === "unsent") continue;
    for (const e of b.episodes) {
      const k = JSON.stringify([e.taskId, e.entrySeq]);
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (b.state === "unknown") unknown.push({ taskId: e.taskId, entrySeq: e.entrySeq, batchId: b.batchId });
    }
  }
  const claims = db.query("SELECT target, data FROM events WHERE project = ? AND kind = 'note' AND ts >= ? AND json_extract(data, '$.op') = ? ORDER BY seq")
    .all(project, sinceMs, SLA_CLAIM_OP) as { target: string; data: string }[];
  const dangling = claims.map((c) => ({ taskId: c.target, ...(JSON.parse(c.data) as { entrySeq: number; batchId: string }) }))
    .filter((c) => !settled.has(c.batchId)).map((c) => ({ taskId: c.taskId, entrySeq: c.entrySeq, batchId: c.batchId }));
  return { batches, dangling, unknown, repeated: [...seen.values()].filter((n) => n > 1).length,
    cost: batchCost(rows.filter((b) => b.state === "sent" || b.state === "unknown"), usage) };
}

export function manualCaseSlaLines(r: ManualCaseSlaReport): string[] {
  const c = r.cost, n = (v: number | null) => (v === null ? "未知" : String(v));
  const list = (xs: readonly { taskId: string; entrySeq: number; batchId: string }[]) => xs.map((x) => `${x.taskId} 段#${x.entrySeq}（${x.batchId}）`).join("、");
  return [`逾期合并提醒：已送达 ${r.batches.sent} 批，结果不明 ${r.batches.unknown} 批，确定未发出 ${r.batches.unsent} 批；同段重复提醒 ${r.repeated}`,
    ...(r.unknown.length ? [`提醒结果不明、待 PM 核对（不自动重发）：${list(r.unknown)}`] : []),
    ...(r.dangling.length ? [`认领后没有结果记录、按结果不明待 PM 核对（不自动重发）：${list(r.dangling)}`] : []),
    `提醒成本：投递 ${c.deliveries} 批，PM 被叫醒回合 ${n(c.wakeTurns)}，输入 token ${n(c.input)}（另缓存读 ${n(c.cacheRead)} / 缓存写 ${n(c.cacheCreation)}），输出 token ${n(c.output)}${c.why ? `（${c.why}）` : ""}`];
}
