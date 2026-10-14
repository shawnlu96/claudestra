/**
 * PM reclaim of a build order also settles the one scheduler intent that order left unknown (RECLAIMINT1), so the next pass can
 * plan again; the scheduler's own unknown rules stay as they are. The intent is the one the order's pool_offer event links
 * (poolOrderId), never guessed from id text. It is settled only with proof the peer left nothing: its branch is absent on origin,
 * no PR (any state) has that branch as head, and the ledger holds no delivery or peer receipt for the order. Remote reads run
 * before the reclaim transaction (prepareReclaimIntent); inside it settleReclaimIntent re-checks every ledger fact and acts per
 * the `lendReclaimIntent` recovery key. Any doubt keeps unknown and says why. tests/lend-reclaim-intent*.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import type { WriteLease } from "./ledger-lend-lease.js";
import { getIntent } from "./ledger-scheduler.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import type { LedgerTask } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { decideRecovery, recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { POOL_RECIPIENT } from "./scheduler-pool-plan.js";

const RECLAIM_INTENT_KEY = "lendReclaimIntent";
const PROBE_TIMEOUT_MS = 90_000;

/** origin's answer for the order branch: absent only when the query succeeded and found no such ref. */
export type BranchProbe = { state: "absent" } | { state: "present"; head: string } | { state: "unknown"; why: string };
/** PRs whose head is the order branch, in any state: none only on a complete, well-formed answer. */
export type PrProbe = { state: "none" } | { state: "exists"; numbers: number[] } | { state: "unknown"; why: string };
export interface ReclaimIntentProbe {
  branch(repo: string, branch: string): Promise<BranchProbe>;
  prs(repo: string, branch: string): Promise<PrProbe>;
}

/** What the reclaim was prepared against, read before its transaction; the transaction re-reads all of it. */
interface ReclaimCandidate {
  intentId: string; orderId: string; peer: string; branch: string; repo: string; leaseGen: number;
  taskRev: number; specRev: number; round: number;
}
/** The order a pool intent's offer event links (scheduler-pool-facts.ts poolOrderId), injected: that module sits above ledger-lend.ts. */
type PoolLink = (db: Database, intentId: string) => string | null;
export interface ReclaimIntentPrep {
  mode: RecoveryMode;
  /** the same link reader the preparation used, for the in-transaction re-check */
  link: PoolLink;
  diagnostic?: string;
  candidate: ReclaimCandidate | null;
  /** why there is no candidate */
  none?: string;
  branch?: BranchProbe;
  pr?: PrProbe;
}
export type ReclaimIntentOutcome =
  | { status: "settled"; intentId: string; receipt: string }
  | { status: "kept_unknown"; intentId: string; reason: string; observed?: true }
  | { status: "none"; reason: string };

/** The order fields this module reads; reclaimLend hands over its LendOrder as read in the transaction, before it cancelled it. */
interface LiveOrder {
  orderId: string; step: string; status: string; peer: string; branch: string | null; repo: string; leaseGen: number;
  resultSha: string | null; receipt: unknown; eventSeq: number | null;
}

const liveOrder = (db: Database, taskId: string): LiveOrder | null => db.query(`SELECT orderId, step, status, peer, branch, repo, leaseGen,
  resultSha, receipt, eventSeq FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')`).get(taskId) as LiveOrder | null;

/** The pool intent this order became: exactly one pool_offer event naming it, and that intent's own link resolving back to it. */
function linkedIntent(db: Database, link: PoolLink, taskId: string, orderId: string): string | { none: string } {
  const ids = (db.query(`SELECT json_extract(data, '$.id') AS id FROM events WHERE target = ? AND kind = 'scheduler'
    AND json_extract(data, '$.op') = 'pool_offer' AND json_extract(data, '$.orderId') = ?`).all(taskId, orderId) as { id: unknown }[])
    .map((r) => r.id).filter((id): id is string => typeof id === "string" && link(db, id) === orderId);
  if (ids.length === 0) return { none: `出借单 ${orderId} 不是调度挂池出的单，没有对应的调度意图` };
  if (new Set(ids).size > 1) return { none: `出借单 ${orderId} 对上了多条调度意图，不认关联` };
  return ids[0];
}

/** Why this intent is not the write dispatch left unknown by this order, or null when it is. */
function intentMismatch(db: Database, id: string, taskId: string, peer: string): string | null {
  const i = getIntent(db, id);
  if (!i) return `调度意图 ${id} 不见了`;
  if (i.taskId !== taskId || i.node !== "write" || i.action !== "dispatch" || i.recipient !== `${POOL_RECIPIENT}${peer}`) {
    return `调度意图 ${id} 不是这张单的开工派单（${i.node}/${i.action} → ${i.recipient ?? "-"}）`;
  }
  return i.status === "unknown" ? null : `调度意图 ${id} 是 ${i.status}，不是 unknown`;
}

/** The candidate as the ledger shows it now, or why there is none. Shared by the preparation and the in-transaction re-check. */
function candidateOf(db: Database, link: PoolLink, task: LedgerTask): ReclaimCandidate | { none: string } {
  if (task.stage !== "build") return { none: `卡在 ${task.stage}，只结清开工阶段收回留下的意图` };
  const o = liveOrder(db, task.id);
  if (!o) return { none: "没有未结的出借单" };
  if (o.step !== "write") return { none: `未结的出借单是 ${o.step} 单，不是开工单` };
  if (o.status !== "unknown") return { none: `出借单 ${o.orderId} 是 ${o.status}，不是结果不明` };
  if (!o.branch) return { none: `出借单 ${o.orderId} 没有出借分支` };
  const id = linkedIntent(db, link, task.id, o.orderId);
  if (typeof id !== "string") return id;
  const bad = intentMismatch(db, id, task.id, o.peer);
  if (bad) return { none: bad };
  return { intentId: id, orderId: o.orderId, peer: o.peer, branch: o.branch, repo: o.repo, leaseGen: o.leaseGen,
    taskRev: task.rev, specRev: task.specRev, round: task.round };
}

/** A probe that throws or hangs counts as unknown, never as "nothing there". */
async function bounded<T>(run: () => Promise<T>, fail: (why: string) => T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fail(`查询超过 ${Math.round(ms / 1000)} 秒没回`)), ms); });
  try { return await Promise.race([run().catch((e: unknown) => fail(`查询出错：${(e as Error)?.message ?? String(e)}`)), late]); }
  finally { clearTimeout(timer); }
}

export interface PrepareDeps { probe: ReclaimIntentProbe; link: PoolLink; policy?: RecoveryPolicyPort; timeoutMs?: number }

/** Outside the reclaim transaction: the switch, the candidate, and (unless off) the two remote reads. Never throws on a probe. */
export async function prepareReclaimIntent(db: Database, task: LedgerTask, deps: PrepareDeps): Promise<ReclaimIntentPrep> {
  const policy = (deps.policy ?? recoveryPolicy)(task.project, RECLAIM_INTENT_KEY);
  const head = { mode: policy.mode, link: deps.link, ...(policy.diagnostic ? { diagnostic: policy.diagnostic } : {}) };
  if (policy.mode === "off") return { ...head, candidate: null };
  const c = candidateOf(db, deps.link, task);
  if ("none" in c) return { ...head, candidate: null, none: c.none };
  const ms = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [branch, pr] = await Promise.all([
    bounded(() => deps.probe.branch(c.repo, c.branch), (why): BranchProbe => ({ state: "unknown", why }), ms),
    bounded(() => deps.probe.prs(c.repo, c.branch), (why): PrProbe => ({ state: "unknown", why }), ms),
  ]);
  return { ...head, candidate: c, branch, pr };
}

/** Delivery or peer receipts the ledger holds for this order; empty = none. */
function ledgerResults(db: Database, o: LiveOrder): string[] {
  const out: string[] = [];
  if (o.resultSha || o.receipt || o.eventSeq !== null) out.push("出借单已有交付 / 回执");
  const prefix = `lend-deliver:${o.orderId}:`;
  if (db.query("SELECT 1 FROM events WHERE substr(dedupKey, 1, ?) = ? LIMIT 1").get(prefix.length, prefix)) out.push("台账有这张单的交付事件");
  const peerNotes = db.query(`SELECT DISTINCT json_extract(data, '$.lend.op') AS op FROM events WHERE json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') IN ('actual','usage','release')`).all(o.orderId) as { op: string }[];
  if (peerNotes.length) out.push(`台账有对方回执（${peerNotes.map((r) => r.op).sort().join(" / ")}）`);
  if (db.query(`SELECT 1 FROM events WHERE json_extract(data, '$.op') = 'convergence_cancel_ack' AND json_extract(data, '$.orderId') = ? LIMIT 1`)
    .get(o.orderId)) out.push("台账有对方停止回执");
  return out;
}

const branchLine = (b: BranchProbe | undefined): string | null => !b ? "分支没查" : b.state === "absent" ? null
  : b.state === "present" ? `分支已推到 origin（${b.head.slice(0, 12)}）` : `分支查询不确定：${b.why}`;
const prLine = (p: PrProbe | undefined): string | null => !p ? "PR 没查" : p.state === "none" ? null
  : p.state === "exists" ? `已有以该分支为 head 的 PR（#${p.numbers.join(" #")}）` : `PR 查询不确定：${p.why}`;

/** Every in-transaction re-check; order is the reclaim's own read of the live order, before it cancelled it. */
function driftOf(db: Database, link: PoolLink, task: LedgerTask, order: LiveOrder | null, lease: WriteLease | null, c: ReclaimCandidate): string[] {
  const out: string[] = [];
  if (task.rev !== c.taskRev || task.specRev !== c.specRev || task.round !== c.round) out.push("卡在核对后被改过（rev / specRev / round）");
  if (task.stage !== "build") out.push(`卡已不在开工阶段（${task.stage}）`);
  if (!order || order.orderId !== c.orderId) out.push(`收回的不是核对时那张单（${order?.orderId ?? "无"}）`);
  else if (order.status !== "unknown" || order.step !== "write" || order.peer !== c.peer || order.branch !== c.branch || order.repo !== c.repo
    || order.leaseGen !== c.leaseGen) out.push(`出借单 ${c.orderId} 在核对后变了（状态 / 出借方 / 分支 / 租约代数）`);
  if (!lease || lease.peer !== c.peer || lease.branch !== c.branch) out.push("写租约与核对时的出借方 / 分支对不上");
  const bad = intentMismatch(db, c.intentId, task.id, c.peer);
  if (bad) out.push(bad);
  else if (link(db, c.intentId) !== c.orderId) out.push(`调度意图 ${c.intentId} 的挂池关联变了`);
  const others = db.query(`SELECT id FROM scheduler_intents WHERE taskId = ? AND id != ? AND status IN ('pending','submitted','unknown')`)
    .all(task.id, c.intentId) as { id: string }[];
  if (others.length) out.push(`同卡还有未结的调度意图：${others.map((r) => r.id).join("、")}`);
  return out;
}

const reclaimSeq = (db: Database, taskId: string, orderId: string): number | null => (db.query(`SELECT seq FROM events WHERE target = ? AND kind = 'note'
  AND json_extract(data, '$.lend.op') = 'reclaim' AND json_extract(data, '$.lend.orderId') = ? ORDER BY seq DESC LIMIT 1`).get(taskId, orderId) as
  { seq: number } | null)?.seq ?? null;

/** task / order / lease: what reclaimLend read at the start of its transaction (order before its cancel, lease before its end). */
export interface SettleInput { task: LedgerTask; order: LiveOrder | null; lease: WriteLease | null; prep?: ReclaimIntentPrep }

/**
 * Inside reclaimLend's transaction, after its reclaim note. off (or no preparation) = null: nothing read, nothing written.
 * observe = one deduplicated note per order and lease generation; on = settleIntent(unknown → cancelled) as the reclaiming PM.
 */
export function settleReclaimIntent(db: Database, ctx: WriteCtx, input: SettleInput): ReclaimIntentOutcome | null {
  const { prep, task } = input;
  if (!prep || prep.mode === "off") return null;
  const c = prep.candidate;
  if (!c) return { status: "none", reason: prep.none ?? prep.diagnostic ?? "没有收回留下的未知意图" };
  const order = input.order;
  // Probe errors carry remote text: one line, no control characters, or the observation note (textOneLine) would refuse the whole reclaim.
  const reasons = [...driftOf(db, prep.link, task, order, input.lease, c), ...(order ? ledgerResults(db, order) : []), branchLine(prep.branch), prLine(prep.pr)]
    .filter((r): r is string => !!r).map((r) => r.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim().slice(0, 200));
  const seq = reclaimSeq(db, task.id, c.orderId);
  const basis = `收回事件 #${seq ?? "?"}；单 ${c.orderId} 第 ${c.leaseGen} 代租约；分支 ${c.branch} origin 上不存在；无以它为 head 的 PR（含已关闭）；台账无交付 / 回执`;
  const decision = decideRecovery({ mode: prep.mode, manualAfterMs: null, source: "config" });
  if (decision.kind === "observe") {
    const action = reasons.length ? `保留意图 ${c.intentId} 为 unknown：${reasons.join("；")}` : `结清意图 ${c.intentId}（unknown → cancelled）：${basis}`;
    recordObserved(db, { project: task.project, mechanism: RECLAIM_INTENT_KEY, target: task.id, actionKey: `${c.orderId}:g${c.leaseGen}`,
      action: action.slice(0, 560), data: { intentId: c.intentId, orderId: c.orderId, leaseGen: c.leaseGen, reclaimSeq: seq, wouldSettle: !reasons.length,
        reasons } }, ctx.now ?? Date.now());
    return { status: "kept_unknown", intentId: c.intentId, reason: `observe 只记观察：${reasons.length ? reasons.join("；") : "证据齐全，on 时会结清"}`, observed: true };
  }
  if (reasons.length || seq === null) return { status: "kept_unknown", intentId: c.intentId, reason: reasons.join("；") || "找不到本次收回事件" };
  const receipt = `PM 收回核对：${basis}`;
  try {
    settleIntent(db, ctx, { id: c.intentId, from: "unknown", to: "cancelled", receipt });
  } catch (e) {
    // The settle's own savepoint rolled back; the reclaim still stands and the intent stays unknown for PM, with the refusal in the output.
    if (e instanceof LedgerError) return { status: "kept_unknown", intentId: c.intentId, reason: `结算被拒：${e.message}` };
    throw e;
  }
  return { status: "settled", intentId: c.intentId, receipt };
}
