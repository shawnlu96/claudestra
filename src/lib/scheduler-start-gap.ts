/**
 * RESTATEGO1 · a card in build with no start order. approve_restate only moves the stage; the write order is the next node, so
 * "build" is no proof the executor was told to start. Every pass, after the planner decided (Card.step), this looks at an auto
 * card in build whose current specRev has no write dispatch that left pending: past START_GAP_MS it writes one note naming the
 * planner's wait code / reason and how long the card has sat in build (one per code, so a changed reason is a new note), and
 * once the gates clear and the planner emits the write intent, one note saying it was re-planned (the tick then drives it).
 * Still waiting after START_GAP_ESCALATE_MS: one PM todo per specRev. A done approve_restate never counts as delivery.
 * Recovery key startDeliveryConfirm: off = nothing; observe = notes only (no PM todo). tests/scheduler-start-gap.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { PlannerDecision, PlannerSnapshot } from "./scheduler-plan.js";

const START_GAP_KEY = "startDeliveryConfirm";
/** Longer than a normal pass-to-pass dispatch (seconds) and the create / bind round trips, shorter than the 15-minute idle audit. */
export const START_GAP_MS = 10 * 60_000;
export const START_GAP_ESCALATE_MS = 60 * 60_000;

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface StartGapCard {
  db: Database;
  task: LedgerTask;
  deps: { manager: Manager; now(): number; notifyPm(task: LedgerTask, text: string, level: PmNoticeLevel): Promise<void>; recoveryPolicy?: RecoveryPolicyPort };
}
export type StartGap =
  | { kind: "none" }
  | { kind: "gap"; since: number; waitedMs: number; code: string; reason: string }
  | { kind: "replanned"; since: number; waitedMs: number };

/** When the card last entered build for this specRev (the stage event), or null when it is not an auto card in build. */
function buildSince(s: PlannerSnapshot): number | null {
  if (s.task.stage !== "build" || s.workflow?.mode !== "auto") return null;
  return s.events.findLast((e) => e.kind === "stage" && e.data.to === "build")?.ts ?? null;
}

/** A write dispatch for this specRev that left pending (submitted / done / unknown): the start order exists, the gap is closed. */
const writeSent = (s: PlannerSnapshot): boolean => s.intents.some((i) => i.node === "write" && i.action === "dispatch" && i.specRev === s.task.specRev
  && i.status !== "pending" && i.status !== "cancelled");

/** Pure: is this pass's decision a start gap, and why. Intents of another node (an ensure_session first) still count as a gap. */
export function startGap(s: PlannerSnapshot, plan: PlannerDecision, now: number, gapMs = START_GAP_MS): StartGap {
  const since = buildSince(s);
  if (since === null || writeSent(s) || now - since < gapMs) return { kind: "none" };
  if (plan.kind === "intent" && plan.node === "write" && plan.action === "dispatch") return { kind: "replanned", since, waitedMs: now - since };
  if (plan.kind === "intent") return { kind: "gap", since, waitedMs: now - since, code: `next_${plan.action}`, reason: `先做 ${plan.node} 的 ${plan.action}：${plan.reason}` };
  return { kind: "gap", since, waitedMs: now - since, code: plan.code, reason: plan.reason };
}

const mins = (ms: number) => `${Math.floor(ms / 60_000)} 分钟`;
const safeCode = (code: string) => code.replace(/[^\w.:@/-]/g, "_").slice(0, 60) || "unknown";
const seen = (c: StartGapCard, actionKey: string) =>
  !!getEventByDedup(c.db, observeDedupKey({ project: c.task.project, mechanism: START_GAP_KEY, target: c.task.id, actionKey }));

async function note(c: StartGapCard, actionKey: string, action: string, data: Record<string, unknown>): Promise<void> {
  if (seen(c, actionKey)) return;
  const r = await c.deps.manager("ledger", "scheduler-recovery-observe", c.task.id, "--mechanism", START_GAP_KEY, "--action-key", actionKey,
    "--action", action, "--data", JSON.stringify(data));
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${c.task.id} 开工缺口记录没写上（下轮重试）：${String(r.error)}`);
}

/**
 * The tick's hook (Card.step, right after planScheduler). Notes are best effort and never change the decision: a gap note
 * says what the card waits for, a replanned note marks the self-heal, and the step goes on to plan / drive as before.
 */
export async function trackStartGap(c: StartGapCard, s: PlannerSnapshot, plan: PlannerDecision): Promise<void> {
  const mode = (c.deps.recoveryPolicy ?? recoveryPolicy)(c.task.project, START_GAP_KEY).mode;
  if (mode === "off") return;
  const g = startGap(s, plan, c.deps.now());
  if (g.kind === "none") return;
  const rev = `s${c.task.specRev}`;
  if (g.kind === "replanned") {
    if (!seen(c, `start-gap:${rev}:wait`)) return; // no gap was ever noted: an ordinary first dispatch, nothing to mark
    return note(c, `start-gap:${rev}:replanned`, `在 build ${mins(g.waitedMs)}后门槛已满足，重新规划开工单`, { since: g.since, waitedMs: g.waitedMs });
  }
  const data = { since: g.since, waitedMs: g.waitedMs, code: g.code, reason: g.reason.slice(0, 300) };
  await note(c, `start-gap:${rev}:wait`, `记录：在 build 已 ${mins(g.waitedMs)}没有开工单，等 ${g.code}：${g.reason.slice(0, 200)}`, data);
  await note(c, `start-gap:${rev}:wait:${safeCode(g.code)}`, `记录：开工单等待原因 ${g.code}（在 build ${mins(g.waitedMs)}）：${g.reason.slice(0, 200)}`, data);
  if (mode !== "on" || g.waitedMs < START_GAP_ESCALATE_MS || seen(c, `start-gap:${rev}:escalated`)) return;
  const text = `[调度引擎] ${c.task.id} 在 build 已 ${mins(g.waitedMs)}，还没有开工单：等 ${g.code}：${g.reason.slice(0, 300)}。` +
    "门槛满足后调度器会自动派；处理不了就 workflow-set --mode manual 接手";
  const r = await c.deps.manager("ledger", "scheduler-pm-todo", c.task.id, "--kind", "start_gap", "--text", text, "--dedup", `start-gap:${c.task.id}:${rev}`);
  if (r.ok !== true) { console.error(`⚠️ [scheduler] ${c.task.id} 开工缺口 PM 待办没写上（下轮重试）：${String(r.error)}`); return; }
  await note(c, `start-gap:${rev}:escalated`, `升级 PM：在 build ${mins(g.waitedMs)}没有开工单`, data);
}
