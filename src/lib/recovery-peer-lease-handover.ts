/**
 * dispatch-recovery-PEERLEASE1 · peerLeaseRecovery, the local takeover's handover: before this machine creates a fix author for a card
 * whose write work PM formally reclaimed from a peer, the card's old peer author binding leaves `active` in one replayable scheduler
 * transaction. Only the card's current author row, transport peer, the exact session and lease generation the tick assessed, and only
 * on the existing proofs: lend-reborrow-facts.ts captureReborrowFacts (a real PM's reclaim of this exact ended lease, no live order or
 * unknown result, no open step or intent, the previous order terminal and no write order since) — preparation only — plus the lender's
 * own end fact for every write order of that lease generation (recovery-peer-lease-stop.ts). A borrower-side cancel or time offline is
 * never a stop proof. Not here: archive / kill receipts (nothing is faked, nothing remote is touched), recordSessionRetirement's
 * finished-card rule (unchanged), the old row's family. The runtime this machine will create the author in is frozen on the event;
 * scheduler-auto-snapshot.ts trusts it only while the new local binding confirms it (recovery-peer-lease-family.ts).
 * tests/recovery-peer-lease-handover.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWriteLease } from "./ledger-lend-lease.js";
import { getWorkflow, type AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { captureReborrowFacts } from "./lend-reborrow-facts.js";
import { getSchedulerSession, preserveSessionHistory } from "./scheduler-sessions.js";
import { PEER_LEASE_KEY, peerLeaseMode } from "./recovery-peer-lease.js";
import { PEER_HANDOVER_OP } from "./recovery-peer-lease-family.js";
import { peerStopProofs, type StopProof } from "./recovery-peer-lease-stop.js";

/** What the handover stands on; the tick passes session + lease generation, the transaction re-reads all of it. */
export interface HandoverEvidence {
  specRev: number; round: number; head: string; agent: string; sessionId: string; family: AuthorFamily;
  peer: string; leaseAt: number; reclaimSeq: number; previousOrder: string; fingerprint: string; stops: StopProof[];
}
/** relevant = an active peer author row on an auto fix card: its block is worth one observe note; otherwise nothing to say. */
export type HandoverCheck = { evidence: HandoverEvidence } | { why: string; relevant: boolean };

const handoverKey = (taskId: string, sessionId: string): string => `scheduler:peer-lease-handover:${taskId}:${sessionId}`;

export function handoverCheck(db: Database, task: LedgerTask): HandoverCheck {
  const workflow = getWorkflow(db, task.id);
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || task.stage !== "fix") return { why: "不是当前规格的自动修复卡", relevant: false };
  const row = getSchedulerSession(db, task.id, "author");
  if (!row || row.state !== "active" || row.transport !== "peer") return { why: "本卡没有 active 的 peer 作者绑定", relevant: false };
  const lease = getWriteLease(db, task.id);
  if (!lease) return { why: "台账没有这张卡的写租约记录：peer 作者来源核不了", relevant: true };
  if (lease.state === "held") return { why: `写租约仍在 ${lease.peer}：等 PM 正规 ledger lend-reclaim，离线时长不算停止证明`, relevant: true };
  if (!row.agent.endsWith(`@${lease.peer}`)) return { why: `peer 作者 ${row.agent} 不是原租约方 ${lease.peer} 的 worker`, relevant: true };
  let facts: ReturnType<typeof captureReborrowFacts>;
  try { facts = captureReborrowFacts(db, task.id, lease.peer, lease.repo); }
  catch (e) { if (e instanceof LedgerError) return { why: e.message, relevant: true }; throw e; }
  if (row.createdAt > facts.lease.updatedAt) return { why: "peer 作者绑定晚于收回：代次不符", relevant: true };
  if (!task.headSHA) return { why: "卡上没有 head", relevant: true };
  const stops = peerStopProofs(db, task.id, lease.peer, facts.lease.branch, facts.reclaim.seq, row.agent); // the lender's own end facts, not the reclaim
  if (typeof stops === "string") return { why: stops, relevant: true };
  return { evidence: { specRev: task.specRev, round: task.round, head: task.headSHA, agent: row.agent, sessionId: row.sessionId, family: row.family,
    peer: lease.peer, leaseAt: facts.lease.updatedAt, reclaimSeq: facts.reclaim.seq, previousOrder: facts.previous.orderId, fingerprint: facts.fingerprint, stops } };
}

/**
 * The snapshot's read (scheduler-auto-snapshot.ts): under on, with every proof in place, the binding this tick's handover retires is
 * not planned on — otherwise the old peer row would make the plan escalate the card to manual before the handover runs. The plan
 * made on it is refused by the rev the handover moves; a refused handover leaves the row, and the next snapshot sees it again.
 */
export function handoverDue(db: Database, task: LedgerTask): boolean {
  return task.stage === "fix" && peerLeaseMode(db, task.project) === "on" && "evidence" in handoverCheck(db, task);
}

/** The observe / dedup key of one would-be handover (or of one block): card, session, lease generation and outcome. */
export function handoverObserveKey(taskId: string, c: HandoverCheck): string {
  const body = "evidence" in c ? [c.evidence.sessionId, c.evidence.leaseAt, c.evidence.fingerprint] : [c.why];
  return `handover:${createHash("sha256").update(JSON.stringify([taskId, ...body])).digest("hex").slice(0, 32)}`;
}

export interface HandoverInput { taskId: string; rev: number; sessionId: string; leaseAt: number; runtime: string }

/**
 * The transaction (`ledger scheduler-fix-relay --op peer-handover`, scheduler identity only). CAS on the task rev, the exact session
 * and lease generation, the switch read again (on), the proofs re-captured. The row leaves active (state retired, no receipts), the
 * task rev moves (any plan made before it is refused), and the old binding's agent is cleared from the card if it was named there.
 * A replay with the same session returns the recorded event; a different input for it is refused.
 */
export function applyPeerHandover(db: Database, ctx: WriteCtx, input: HandoverInput): { duplicate: boolean; seq: number; runtime: AuthorFamily } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "peer 作者交接只由调度服务记账");
  if (input.runtime !== "claude" && input.runtime !== "codex") throw new LedgerError("invalid", "--runtime 只能是 claude / codex");
  const runtime: AuthorFamily = input.runtime;
  return tx(db, () => {
    const task = mustTask(db, input.taskId), key = handoverKey(task.id, input.sessionId);
    const prior = getEventByDedup(db, key);
    if (prior) {
      if (prior.target !== task.id || prior.data.leaseAt !== input.leaseAt || prior.data.runtime !== runtime) throw new LedgerError("dedup_mismatch", "这次交接已按另一组证据记过");
      return { duplicate: true, seq: prior.seq, runtime };
    }
    if (task.rev !== input.rev) throw new LedgerError("conflict", "卡在评估之后变了，交接重算");
    if (peerLeaseMode(db, task.project) !== "on") throw new LedgerError("conflict", `${PEER_LEASE_KEY} 已不是 on，不交接`);
    const check = handoverCheck(db, task);
    if (!("evidence" in check)) throw new LedgerError("conflict", `交接证据不全：${check.why}`);
    const ev = check.evidence;
    if (ev.sessionId !== input.sessionId || ev.leaseAt !== input.leaseAt) throw new LedgerError("conflict", "peer 作者 session 或写租约代次已变，交接重算");
    const now = ctx.now ?? Date.now();
    preserveSessionHistory(db);
    const moved = db.prepare(`UPDATE scheduler_sessions SET state = 'retired', updatedAt = ? WHERE taskId = ? AND role = 'author' AND sessionId = ?
      AND state = 'active' AND transport = 'peer'`).run(now, task.id, ev.sessionId).changes;
    if (moved !== 1) throw new LedgerError("conflict", "peer 作者绑定已不是 active，交接重算");
    const clear = task.agent === ev.agent;
    db.prepare(`UPDATE tasks SET rev = rev + 1, updatedAt = ?${clear ? ", agent = NULL" : ""} WHERE id = ? AND rev = ?`).run(now, task.id, task.rev);
    const e = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, {
      project: task.project, target: task.id, kind: "scheduler",
      text: `peer 作者交接：${ev.agent}（${ev.family}）的绑定退出 active（PM 已收回 ${ev.peer} 的写租约，旧单已结清）；本机按 ${runtime} 建修复作者`,
      data: { op: PEER_HANDOVER_OP, mechanism: PEER_LEASE_KEY, ...ev, runtime, clearedAgent: clear },
    }, true);
    return { duplicate: false, seq: e.seq, runtime };
  });
}

/** The CLI half of `scheduler-fix-relay --op peer-handover` (lend-fix-reassign-tick.ts): flags in, the transaction's answer out. */
export function peerHandoverCommand(c: { db: Database; ctx(): WriteCtx; need(flag: string): string; task(id: string | undefined): LedgerTask; p: { pos: string[] } }) {
  return applyPeerHandover(c.db, c.ctx(), { taskId: c.task(c.p.pos[1]).id, rev: Number(c.need("rev")), sessionId: c.need("session"),
    leaseAt: Number(c.need("lease-at")), runtime: c.need("runtime") });
}
