/**
 * i28-STALELEASE1 · staleLeaseHandover, the judgment: a fix card whose write lease is still held by a peer although this machine's
 * own author session took the card over (the peer's order was cancelled, the build was redone here on the card's own branch and
 * delivered by that session). Without it the fix goes back to the lease holder, whose lend branch no longer is the card's branch:
 * ledger-lend-lease.ts writeOfferBranch refuses the order, the intent is cancelled and the next tick pools it again.
 * No lender stop proof is needed: the card's branch is the local author's, a returning lender could not push to it anyway.
 * Every condition is a positive proof; any miss is a reason and the existing path stays. Read here, re-read inside the handover
 * transaction (lend-local-continuity-tick.ts). Policy: recovery key staleLeaseHandover (off / observe / on; default observe).
 * tests/lend-local-continuity*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { listLendOrders, type LendOrder } from "./ledger-lend.js";
import { heldLease, type WriteLease } from "./ledger-lend-lease.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { isWriteStep } from "./lend-git.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { getSchedulerSession, type SchedulerSession } from "./scheduler-sessions.js";

export const STALE_LEASE_KEY = "staleLeaseHandover" as const;
export const STALE_LEASE_OP = "stale_lease_handover";
const LIVE_INTENT: readonly string[] = ["pending", "submitted", "unknown"];

/** What the handover stands on; the transaction re-derives it and compares session + lease generation. */
export interface ContinuityEvidence {
  peer: string; leaseBranch: string; leaseAt: number; branch: string; head: string; round: number; specRev: number;
  agent: string; sessionId: string; family: AuthorFamily; transport: string; deliverSeq: number; unpin: boolean;
}
export type Continuity = { ok: true; evidence: ContinuityEvidence } | { ok: false; why: string };

export interface ContinuityInput {
  task: Pick<LedgerTask, "id" | "stage" | "branch" | "headSHA" | "agent" | "assigneeKind" | "extra" | "round" | "specRev">;
  /** The card's workflow is auto and on the card's current spec revision. */
  auto: boolean;
  /** heldLease(): held and the card still in a lease stage; null = no lease to end. */
  lease: WriteLease | null;
  orders: readonly Pick<LendOrder, "orderId" | "step" | "status">[];
  intents: readonly Pick<SchedulerIntent, "id" | "status">[];
  events: readonly Pick<LedgerEvent, "seq" | "kind" | "actor" | "data">[];
  /** The card's latest author row (getSchedulerSession), whatever its state. */
  author: Pick<SchedulerSession, "agent" | "sessionId" | "family" | "transport" | "state"> | null;
}

const no = (why: string): Continuity => ({ ok: false, why });

/** Pure: the conditions of the spec's 「PM 定」2, plus what makes the existing FB1 path (lend-fix-start.ts localFixOwner) pick that author. */
export function assessContinuity(i: ContinuityInput): Continuity {
  const { task: t, lease, author } = i;
  if (!i.auto) return no("不是当前规格的自动卡");
  if (t.stage !== "fix") return no(`阶段 ${t.stage} 不是修复`);
  if (!lease) return no("没有 held 的写租约");
  if (!t.branch || lease.branch === t.branch) return no(`卡上分支 ${t.branch ?? "（空）"} 就是租约分支：租约方仍可接着写`);
  const live = i.orders.filter((o) => isWriteStep(o.step) && LEND_LIVE.includes(o.status));
  if (live.length) return no(`写单 ${live.map((o) => `${o.orderId}（${o.status}）`).join("、")} 未结`);
  const open = i.intents.filter((x) => LIVE_INTENT.includes(x.status));
  if (open.length) return no(`调度意图 ${open.map((x) => `${x.id}（${x.status}）`).join("、")} 未结或效果不明`);
  if (!author || author.state !== "active" || author.transport === "peer") return no("本卡没有 active 的本机作者会话");
  if (t.agent !== author.agent || t.assigneeKind === "peer_agent") return no(`卡的执行者 ${t.agent ?? "（空）"} 不是本机作者会话 ${author.agent}`);
  const pin = typeof t.extra?.placement === "string" && t.extra.placement.startsWith("peer:") ? t.extra.placement : null;
  if (pin && pin !== `peer:${lease.peer}`) return no(`卡固定放在 ${pin}，不是租约方`);
  const last = i.events.findLast((e) => e.kind === "deliver");
  if (!last) return no("卡上没有交付记录");
  if (last.actor !== author.agent) return no(`最近一次交付来自 ${last.actor}，不是本机作者 ${author.agent}`);
  if (!t.headSHA || last.data.headSHA !== t.headSHA) return no("最近一次交付的 head 不是卡上当前 head");
  return { ok: true, evidence: { peer: lease.peer, leaseBranch: lease.branch, leaseAt: lease.updatedAt, branch: t.branch, head: t.headSHA,
    round: t.round, specRev: t.specRev, agent: author.agent, sessionId: author.sessionId, family: author.family, transport: author.transport,
    deliverSeq: last.seq, unpin: pin !== null } };
}

/** The ledger's facts for assessContinuity, read now (outside or inside a transaction alike). */
export function continuityCheck(db: Database, task: LedgerTask): Continuity {
  const wf = getWorkflow(db, task.id);
  const intents = db.query("SELECT id, status FROM scheduler_intents WHERE taskId = ?").all(task.id) as Pick<SchedulerIntent, "id" | "status">[];
  return assessContinuity({ task, auto: wf?.mode === "auto" && wf.specRev === task.specRev, lease: heldLease(db, task),
    orders: listLendOrders(db, task.id), intents, events: listEvents(db, { project: task.project, target: task.id }),
    author: getSchedulerSession(db, task.id, "author") });
}

const ports = new WeakMap<Database, RecoveryPolicyPort>();
/** Same wiring pattern as setPeerLeasePorts: tests inject the policy per ledger. */
export const setStaleLeasePolicy = (db: Database, p: RecoveryPolicyPort): void => void ports.set(db, p);
/** Read on every call (tick, fact reader, transaction): switching back to off stops the next side effect. */
export const staleLeaseMode = (db: Database, project: string): RecoveryMode => (ports.get(db) ?? recoveryPolicy)(project, STALE_LEASE_KEY).mode;

/** observe's one sample per card and lease generation (PM 补 3: the same lease is sampled once, whatever the rounds): `stale-lease:<digest>`. */
export function staleLeaseObserveKey(taskId: string, ev: ContinuityEvidence): string {
  return `stale-lease:${createHash("sha256").update(JSON.stringify([taskId, ev.peer, ev.leaseAt])).digest("hex").slice(0, 32)}`;
}
