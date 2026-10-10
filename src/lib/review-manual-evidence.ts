/**
 * dispatch-recovery-AUTOACK2 · the ledger's own record of a local manual review (an MCP review order `<task>:review|final_review:r<N>`
 * that PM assigned, no scheduler intent): who took it (manual_review_taken, written by the bridge as the reviewer after take_review) and
 * where it was checked out when the verdict came in (the review event's `checkout`). Both only record: a missing take or a bad checkout
 * never refuses the verdict; scheduler-manual-review-local.ts reads them when PM hands the card back to auto. Auto cards keep their own
 * gate (scheduler-auto-review.ts) and record neither. tests/scheduler-manual-review-local*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { getWorkflow } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { agentRuntime, readRegistryAgentsSync, type RegistryAgent } from "./registry.js";
import { slotByOrderId, taskByOrderId, type ReviewSlot } from "./review-order.js";
import { runtimeFamily } from "./scheduler-auto-review.js";
import { within } from "./scheduler-retire.js";
import { gitDirtySync, gitHeadSync } from "./scheduler-review-worktree.js";
import { MANUAL_TAKEN_OP, manualReviewOrder } from "./scheduler-manual-review-local.js";

const assignSeqOf = (db: Database, taskId: string, step: string, round: number): number | null =>
  (db.query(`SELECT MAX(seq) AS s FROM events WHERE target = ? AND kind = 'step' AND json_extract(data, '$.op') = 'assign'
    AND json_extract(data, '$.step') = ? AND json_extract(data, '$.round') = ?`).get(taskId, step, round) as { s: number | null }).s;

/** One take per order, assignment, session and material (head + spec rev): a re-take of the same order after any of them changed is new. */
const takenKey = (orderId: string, assignSeq: number, sessionId: string, head: string, specRev: number): string =>
  `${MANUAL_TAKEN_OP}:${orderId}:a${assignSeq}:${sessionId}:${head}:s${specRev}`;

/**
 * recordTaken's filter: true = this is a local manual review order and the session has no take recorded for its current assignment and
 * material yet (run the manager); false = not that shape, or already recorded (no manager). Reads only.
 */
export function manualReviewUntaken(db: Database, orderId: string, sessionId: string): boolean {
  const o = manualReviewOrder(orderId);
  const task = o ? taskByOrderId(db, orderId) : null;
  if (!o || !task || !task.headSHA) return !!o;
  const a = assignSeqOf(db, task.id, o.step, o.round);
  return a === null || !getEventByDedup(db, takenKey(orderId, a, sessionId, task.headSHA, task.specRev));
}

/** The take record to write (order-mark.ts writes it in its own transaction), or the earlier record of the same take. */
export type ManualTake = { prior: LedgerEvent } | { key: string; project: string; target: string; text: string; data: Record<string, unknown> };

/**
 * `ledger order-taken <manual review order>` as the reviewer: the card is a manual one in review, the order is the caller's own right now
 * (slotByOrderId), `--session` is the caller's current registry session, and its family is known. Refused otherwise (the bridge logs it).
 * Reads only; called inside markOrderTaken's transaction, which inserts the event (only the ledger write modules touch ledger-tx).
 */
export function manualReviewTake(db: Database, actor: string, input: { orderId: string; sessionId: string; registryPath?: string }): ManualTake {
  const o = manualReviewOrder(input.orderId)!;
  const task = taskByOrderId(db, input.orderId);
  if (!task || task.id !== o.taskId) throw new LedgerError("not_found", `没有审查单 ${input.orderId} 对应的卡`);
  if (task.stage !== "review" || getWorkflow(db, task.id)?.mode === "auto") throw new LedgerError("conflict", `${task.id} 不是在 review 的人工卡`);
  const slot = slotByOrderId(db, input.orderId, { agent: actor, sessionId: input.sessionId, family: null });
  if (!slot || slot.auto) throw new LedgerError("forbidden", `${input.orderId} 不是 ${actor} 现在手上的人工审查单`);
  const row = readRegistryAgentsSync(input.registryPath).find((a) => a.name === actor);
  if (!row || row.sessionId !== input.sessionId) throw new LedgerError("forbidden", `--session 不是 ${actor} 在 registry 里的当前会话`);
  const family = runtimeFamily(agentRuntime(row));
  if (!family) throw new LedgerError("forbidden", `认不出 ${actor} 的模型家族（${row.runtime}）`);
  const assignSeq = assignSeqOf(db, task.id, o.step, o.round);
  if (assignSeq === null) throw new LedgerError("conflict", `${input.orderId} 没有派活记录`);
  const key = takenKey(input.orderId, assignSeq, input.sessionId, slot.head, task.specRev);
  const prior = getEventByDedup(db, key);
  if (prior) return { prior };
  return {
    key, project: task.project, target: task.id, text: `${actor} 领人工审查单 ${input.orderId}`,
    data: { op: MANUAL_TAKEN_OP, orderId: input.orderId, step: o.step, round: o.round, specRev: task.specRev, head: slot.head,
      sessionId: input.sessionId, family, assignSeq },
  };
}

export type Checkout = { ok: true; dir: string; head: string } | { ok: false; why: string };
export interface CheckoutDeps {
  registryPath?: string;
  gitHead?(dir: string): string | null;
  gitDirty?(dir: string): string | null;
}

const resolvable = (p: string): boolean => {
  try { realpathSync(p); return true; } catch { return false; } // unresolvable = cannot prove the directories are apart; the caller says so
};

function authorDirRefusal(agents: readonly RegistryAgent[], authors: ReadonlySet<string>, dir: string): string | null {
  for (const name of authors) {
    const a = agents.find((x) => x.name === name);
    if (!a) return `作者 ${name} 在 registry 里没有记录，核不了目录是否独立`;
    if (!a.cwd) return `作者 ${name} 在 registry 里没有 cwd，核不了目录是否独立`;
    if (!resolvable(a.cwd)) return `作者 ${name} 的目录 ${a.cwd} 解析不了，核不了目录是否独立`;
    if (within(dir, a.cwd) || within(a.cwd, dir)) return `审查目录 ${dir} 与作者 ${name} 的目录 ${a.cwd} 相同或互相包含`;
  }
  return null;
}

/** The reviewer's checkout when the verdict came in: current session, a clean tree on the reviewed head, apart from every author's. */
function checkoutOf(slot: ReviewSlot, caller: { agent: string; sessionId: string }, authors: ReadonlySet<string>, deps: CheckoutDeps): Checkout {
  const agents = readRegistryAgentsSync(deps.registryPath);
  const row = agents.find((a) => a.name === caller.agent);
  if (!row || row.sessionId !== caller.sessionId) return { ok: false, why: `会话已换：${caller.agent} 在 registry 里的当前会话是 ${row?.sessionId ?? "无"}` };
  if (!row.cwd) return { ok: false, why: `registry 里没有 ${caller.agent} 的 cwd` };
  const head = (deps.gitHead ?? gitHeadSync)(row.cwd);
  if (head !== slot.head) return { ok: false, why: `审查目录 ${row.cwd} 停在 ${head ?? "（读不到）"}，不是被审的 head ${slot.head}` };
  const dirty = (deps.gitDirty ?? gitDirtySync)(row.cwd);
  if (dirty) return { ok: false, why: `审查目录 ${row.cwd} 有未提交的改动（${dirty}）` };
  if (!resolvable(row.cwd)) return { ok: false, why: `审查目录 ${row.cwd} 解析不了` };
  const shared = authorDirRefusal(agents, authors, row.cwd);
  return shared ? { ok: false, why: shared } : { ok: true, dir: row.cwd, head };
}

/** submit_verdict on a manual card records this; any read error becomes ok:false, never a refusal of the verdict. */
export function manualCheckout(slot: ReviewSlot, caller: { agent: string; sessionId: string }, authors: ReadonlySet<string>, deps: CheckoutDeps): Checkout {
  try {
    const all = new Set(authors);
    if (slot.task.agent) all.add(slot.task.agent);
    return checkoutOf(slot, caller, all, deps);
  } catch (e) {
    return { ok: false, why: `取证出错：${(e as Error).message}`.slice(0, 300) };
  }
}
