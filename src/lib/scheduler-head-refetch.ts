/**
 * SELFHEAL1 · head 没拉到，下一轮自己重取。The review head of a card is fetched right before the reviewer is created
 * (createReviewer → prepareReviewHead) or pinned (pinReview → peerPrHeadMissing / prepareReviewHead); a head still not here used
 * to go straight to PM. Under `selfHealBeforeManual`:
 * - off: unchanged (no write, the same reason).
 * - observe: unchanged, plus one `scheduler-recovery-observe` note per card + head (「本会自救：PR head 下一轮重取」).
 * - on: this pass's dispatch is already withdrawn by the caller (intent cancelled); one attempt note per miss is written and the card
 *   waits. headRefetchHold (asked before planning, through peerPrHold) holds it for 1, 2, 4, 8 … minutes after the latest miss, at
 *   most 30; the next plan fetches again. Six hours after this head's first miss the old escalation goes out, with that said.
 * Backoff state is only the ledger's attempt notes (keyed card + head + attempt number), so a restart keeps the rhythm and a new
 * head starts afresh. The switch is read on every use: the peer refs/pull fetch (peer-pr-hold.ts) and the hold below only run under on,
 * so turning it off (or observe) mid-backoff releases the card on the next pass and the old behaviour comes back unchanged.
 * observeFixSelfHeal: the execution side of scheduler-fix-selfheal.ts's observe mode (the planner stays pure; the sample is written
 * here, through the same note writer, right before the auto tick escalates). tests/scheduler-head-refetch.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { SELF_HEAL_OBSERVE } from "./scheduler-fix-selfheal.js";
import type { PlannerDecision } from "./scheduler-plan.js";

const KEY = "selfHealBeforeManual";
const MIN = 60_000;
export const REFETCH_MAX_WAIT_MS = 30 * MIN;
export const REFETCH_GIVE_UP_MS = 6 * 60 * MIN;
/** The two "head is not here and could not be fetched" reasons (prepareReviewHead / peerPrHeadMissing); every other refusal escalates as before. */
const UNFETCHED = /交付 head ([0-9a-f]{12}) 从项目仓库 origin 取不到|PR head ([0-9a-f]{12}) 不在本地仓库/;

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface RefetchCard { db: Database; task: LedgerTask; deps: { manager: Manager; now(): number; recoveryPolicy?: RecoveryPolicyPort } }

export const selfHealModeOf = (project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode => {
  try { const p = policy(project, KEY); return p.source === "error" ? "off" : p.mode; } catch { return "off"; }
};

/** Wait after the n-th miss (n ≥ 1): 1, 2, 4, 8 … minutes, capped at 30. */
export const refetchBackoffMs = (n: number): number => Math.min(2 ** Math.max(0, n - 1) * MIN, REFETCH_MAX_WAIT_MS);

/** This head's on-mode attempt notes, oldest first. */
export function refetchAttempts(events: readonly LedgerEvent[], head: string): LedgerEvent[] {
  return events.filter((e) => e.kind === "note" && e.data.op === "recovery_observe" && e.data.mechanism === KEY &&
    e.data.kind === "head_refetch" && e.data.mode === "on" && e.data.head === head);
}

/** Before planning: under on, a review-stage card whose current head missed less than its backoff ago waits; null = plan as usual. */
export function headRefetchHold(db: Database, task: LedgerTask, now: number, policy?: RecoveryPolicyPort): string | null {
  if (task.stage !== "review" || !task.headSHA) return null;
  const tries = refetchAttempts(listEvents(db, { project: task.project, target: task.id }), task.headSHA);
  const last = tries.at(-1);
  if (!last || selfHealModeOf(task.project, policy) !== "on") return null; // switched off / observe mid-backoff: no hold
  const left = last.ts + refetchBackoffMs(tries.length) - now;
  return left > 0 ? `PR head 还没取到，下一轮重取：head ${task.headSHA.slice(0, 12)} 已取 ${tries.length} 次，${Math.ceil(left / 1000)}s 后再取` : null;
}

async function note(c: RefetchCard, actionKey: string, action: string, data: Record<string, unknown>): Promise<boolean> {
  const r = await c.deps.manager("ledger", "scheduler-recovery-observe", c.task.id, "--mechanism", KEY, "--action-key", actionKey,
    "--action", action.slice(0, 500), "--data", JSON.stringify({ kind: "head_refetch", head: c.task.headSHA, ...data }));
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${c.task.id} ${KEY} 重取记录没记上：${String(r.error)}`);
  return r.ok === true;
}

/**
 * Called where a review dispatch / reviewer creation was refused, after the intent is settled. `{ wait }` = on, keep the card in
 * auto and retry later; `{ reason }` = escalate with this reason (unchanged unless the six hours are up).
 */
export async function headRefetch(c: RefetchCard, reason: string): Promise<{ wait: string } | { reason: string }> {
  const head = c.task.headSHA;
  if (!head || !UNFETCHED.test(reason)) return { reason };
  const mode = selfHealModeOf(c.task.project, c.deps.recoveryPolicy);
  if (mode === "off") return { reason };
  if (mode === "observe") {
    await note(c, `head-refetch:${head}:observe`, `自救：PR head ${head.slice(0, 12)} 下一轮重取（1、2、4… 分钟退避，最多 30 分钟一次，6 小时后退人工）`, { mode });
    return { reason };
  }
  const tries = refetchAttempts(listEvents(c.db, { project: c.task.project, target: c.task.id }), head);
  const since = tries[0]?.ts ?? c.deps.now(), n = tries.length + 1;
  if (c.deps.now() - since >= REFETCH_GIVE_UP_MS) {
    await note(c, `head-refetch:${head}:give-up`, `自救失败：PR head ${head.slice(0, 12)} 连续 6 小时取不到，退人工`, { mode: "gave_up", attempts: tries.length });
    return { reason: `${reason}（已按退避重取 ${tries.length} 次、连续 6 小时取不到）` };
  }
  const ok = await note(c, `head-refetch:${head}:${n}`, `自救：PR head ${head.slice(0, 12)} 第 ${n} 次没取到，${refetchBackoffMs(n) / MIN} 分钟后重取`, { mode, attempt: n });
  // An unrecorded attempt has no backoff to wait on; the next pass simply tries again (bounded by the dispatch backoff).
  return { wait: `PR head 还没取到，下一轮重取（第 ${n} 次${ok ? "" : "，记录没写上"}）：${reason}` };
}

/**
 * Auto tick, right before escalating a plan: a `fix_report` that scheduler-fix-selfheal.ts annotated under observe gets its one
 * recovery_observe sample (card + head + round, deduped by the action key). Every other plan: nothing. A failed write is logged and
 * the escalation goes on as before.
 */
export async function observeFixSelfHeal(c: RefetchCard, plan: PlannerDecision): Promise<void> {
  if (plan.kind !== "escalate" || plan.code !== "fix_report") return;
  const at = plan.reason.indexOf(SELF_HEAL_OBSERVE);
  if (at < 0) return;
  const head = c.task.headSHA ?? "-", what = plan.reason.slice(at + SELF_HEAL_OBSERVE.length).replace(/）$/, "");
  await note(c, `fix-selfheal:${head}:r${c.task.round}`, `自救：${what}`, { kind: "fix_selfheal", mode: "observe", round: c.task.round,
    basis: plan.reason.includes("缺上一轮完整审查报告") ? "report_missing" : "no_p1" });
}
