/**
 * WEXT1: `scheduler-file-scope --live-extend` appends a card's approved fileGlobs to the file claims of its one live lent author,
 * without pausing it. Pure append under one BEGIN IMMEDIATE: never removes a claim, touches intent / merge / deploy resources,
 * ends the lease, swaps author / peer / order, moves the stage or rewrites the dispatch. Every binding — PM, task / workflow CAS,
 * the real pool dispatch intent, its linked claimed order with this gen, the claim note, the held lease's peer / fingerprint /
 * branch, the peer step binding and the absence of any other writer — is read from production tables and replayed claims;
 * any gap, conflict or drift is a zero-write refusal. The audit (ledger-writer-scope-extend-audit.ts) records the bindings and
 * old / added claims; the default paused reconciliation (ledger-resource-scope.ts) is unchanged. tests/ledger-writer-scope-extend*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getLendOrder } from "./ledger-lend.js";
import { heldLease } from "./ledger-lend-lease.js";
import { getLendPeer } from "./ledger-lend-peers.js";
import { file, fileList, provenance, type Claim } from "./ledger-resource-scope.js";
import { getIntent, getWorkflow, resourceKey, resourcesOverlap, type SchedulerIntent } from "./ledger-scheduler.js";
import { actorMayConfigure, textOneLine } from "./ledger-scheduler-settle.js";
import { busyAsLedgerError, LedgerError, listEvents } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { stepsOf } from "./ledger-steps.js";
import { appendEvent } from "./ledger-write.js";
import { lendBranch, stepOfStage } from "./lend-git.js";
import { bareCanonicalName, normalizeRegistryAgents, REGISTRY_PATH } from "./registry.js";
import { poolOrderId } from "./scheduler-pool-facts.js";
import type { SchedulerSession } from "./scheduler-sessions.js";
import { readJsonStateSync } from "./state-file.js";
import { orderBinding, SCOPE_EXTEND_OP, type ScopeExtendAudit } from "./ledger-writer-scope-extend-audit.js";

export interface LiveExtendInput {
  taskId: string; project: string; taskRev: number; workflowRev: number; reason: string; apply?: boolean;
  /** The live writer the caller saw: the lend order, its lease gen and the peer. Any drift refuses. */
  orderId: string; gen: number; peer: string;
  /** File injection only; the CLI does not expose this as a flag. */
  registryPath?: string;
}

interface Binding { intent: SchedulerIntent; orderId: string; peer: string; family: string; worker: string; gen: number; leaseUntil: number; step: string;
  fp: string; branch: string; intentEventSeq: number; poolLinkSeq: number; claimSeq: number }
interface LivePlan {
  old: string[]; target: string[]; added: string[]; retained: string[];
  conflicts: { resource: string; held: string; taskId: string }[]; reasons: string[];
  binding: Binding | null; duplicateOf: number | null;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The one live lent author: real pool dispatch intent → linked claimed order (this gen) → claim note → held lease. */
function liveWriter(db: Database, task: LedgerTask, input: LiveExtendInput, events: LedgerEvent[], now: number, reasons: string[]): Binding | null {
  const fail = (why: string): null => (reasons.push(why), null);
  const order = getLendOrder(db, input.orderId);
  if (!order || order.taskId !== task.id || order.project !== task.project) return fail("出借单不存在或不属于本卡");
  if (order.peer !== input.peer) return fail(`出借单在 ${order.peer}，不是 ${input.peer}`);
  if (order.status !== "claimed") return fail(`出借单是 ${order.status}，不是在写的 claimed`);
  if (order.leaseGen !== input.gen) return fail(`租约代数是 ${order.leaseGen}，不是 ${input.gen}`);
  if (!order.worker || (order.leaseUntil ?? 0) <= now) return fail("出借单租约已过期或没有 worker");
  if (!["write", "fix"].includes(order.step) || stepOfStage(task.stage) !== order.step) return fail("出借单不是本卡当前阶段的写单");
  if (order.round !== task.round || order.specRev !== task.specRev) return fail("出借单的轮次或 specRev 已变化");
  const live = db.query("SELECT orderId FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown')").all(task.id) as { orderId: string }[];
  if (live.length !== 1 || live[0]!.orderId !== order.orderId) return fail("本卡有其他未结出借单");
  const links = events.filter(e => e.kind === "scheduler" && e.data.op === "pool_offer" && e.data.orderId === order.orderId);
  const intent = links.length === 1 && typeof links[0]!.data.id === "string" ? getIntent(db, links[0]!.data.id) : null;
  if (!intent || poolOrderId(db, intent.id) !== order.orderId) return fail("出借单缺唯一真实的派单意图链接");
  if (intent.taskId !== task.id || intent.project !== task.project || intent.action !== "dispatch" || intent.recipient !== `peer:${input.peer}` ||
    intent.specRev !== task.specRev) return fail("派单意图不是给这个 peer 的本卡写单");
  if (!["pending", "submitted"].includes(intent.status)) return fail(`派单意图是 ${intent.status}，不接受`);
  const others = db.query("SELECT id FROM scheduler_intents WHERE taskId = ? AND id <> ? AND status IN ('pending','submitted','unknown')")
    .all(task.id, intent.id) as { id: string }[];
  if (others.length) return fail("本卡还有其他未结调度意图");
  const plan = events.find(e => e.seq === intent.eventSeq);
  if (plan?.kind !== "scheduler" || plan.data.op !== "plan" || plan.data.id !== intent.id) return fail("派单意图的计划事件不可核");
  const { link, claim } = orderBinding(events, intent.id, order.orderId, input.peer, order.leaseGen, order.worker);
  if (!link || !claim) return fail("缺真实领单记录（链接 / 代数 / worker 不符）");
  const lease = heldLease(db, task);
  if (!lease || lease.project !== task.project || lease.peer !== input.peer) return fail("写租约不在这个 peer 名下或已结束");
  if (!order.branch || lease.branch !== order.branch || lendBranch(task.id, lease.fp) !== lease.branch) return fail("写租约分支与出借单 / 指纹不符");
  // The peer's current fingerprint (its pinned hello) is the identity proof; a missing one is unverifiable, not a pass.
  const known = getLendPeer(db, input.peer)?.fp;
  if (typeof known !== "string" || !known) return fail("peer 当前指纹缺失，无法核实写租约身份");
  if (known.toLowerCase() !== lease.fp.toLowerCase()) return fail("peer 当前指纹与写租约不符");
  return { intent, orderId: order.orderId, peer: order.peer, family: order.family, worker: order.worker, gen: order.leaseGen, leaseUntil: order.leaseUntil as number,
    step: order.step, fp: lease.fp.toLowerCase(), branch: lease.branch, intentEventSeq: plan.seq, poolLinkSeq: link.seq, claimSeq: claim.seq };
}

/**
 * A surviving author session may only be the claimed worker itself: active, peer transport, agent = `<worker>@<peer>`, the order's
 * family, created by a done ensure_session intent of this card whose one production session_bind event names exactly it and
 * came after this claim. A peer name alone, a retiring row or a binding older than the claim is not proof.
 */
function peerAuthorGap(db: Database, task: LedgerTask, s: SchedulerSession, b: Binding, events: LedgerEvent[]): string | null {
  if (s.state !== "active" || s.transport !== "peer" || s.agent !== `${b.worker}@${b.peer}` || s.family !== b.family) return "不是当前领单的 peer worker";
  const intent = getIntent(db, s.createIntentId);
  if (!intent || intent.taskId !== task.id || intent.project !== task.project || intent.action !== "ensure_session" ||
    intent.node === "adversarial_review" || intent.status !== "done") return "缺本卡已完成的建 session 意图";
  const binds = events.filter(e => e.kind === "scheduler" && e.data.op === "session_bind" && e.data.intentId === intent.id);
  const bind = binds.length === 1 ? binds[0]! : null;
  if (!bind || bind.dedupKey !== `scheduler:${intent.id}:bind` || bind.seq <= b.claimSeq || bind.data.role !== "author" ||
    bind.data.agent !== s.agent || bind.data.sessionId !== s.sessionId || bind.data.transport !== "peer" || bind.data.family !== s.family ||
    bind.data.source !== "peer_claim") return "缺本次领单之后的真实绑定记录";
  return null;
}

/**
 * Only the bound peer step writes: any other assigned author step, local author session or possibly-live registry author is unknown.
 * registry.task is a display title, so a registry agent also counts when the card names it (task.agent / assignee / author step),
 * as in the paused reconciliation; stopped / dead / retired only clears it without a pending restart.
 */
function otherWriters(db: Database, task: LedgerTask, b: Binding, input: LiveExtendInput, events: LedgerEvent[], reasons: string[]): void {
  const executor = `${b.worker}@${b.peer}`;
  const writing = stepsOf(db, task).filter(s => !s.derived && ["restate", "write", "fix"].includes(s.step) && s.state === "assigned");
  if (writing.length !== 1 || writing[0]!.step !== b.step || writing[0]!.executor !== executor || writing[0]!.executorKind !== "peer" ||
    writing[0]!.round !== task.round) reasons.push("作者步骤绑定不是唯一的这个 peer worker");
  const sessions = db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? AND state <> 'retired'").all(task.id) as SchedulerSession[];
  for (const s of sessions) if (s.role === "author") {
    const gap = peerAuthorGap(db, task, s, b, events);
    if (gap) reasons.push(`作者 session ${s.sessionId} ${gap}`);
  } else if (!["author", "reviewer"].includes(s.role)) reasons.push(`session ${s.sessionId} 角色不明`);
  const state = readJsonStateSync(input.registryPath ?? REGISTRY_PATH, v => object(v) && object(v.agents) && Object.values(v.agents).every(object));
  if (state.status !== "ok") { reasons.push(`registry 无法核实：${state.status}`); return; }
  const reviewers = new Set(sessions.filter(s => s.role === "reviewer").map(s => bareCanonicalName(s.agent)));
  const authorNames = new Set([task.agent, task.assignee, ...stepsOf(db, task).filter(s => !s.derived && ["restate", "write", "fix"].includes(s.step))
    .map(s => s.executor)].filter((name): name is string => !!name && name !== executor).map(bareCanonicalName));
  const elsewhere = db.query("SELECT * FROM scheduler_sessions WHERE taskId <> ? AND state = 'active'").all(task.id) as SchedulerSession[];
  for (const a of normalizeRegistryAgents(state.data)) {
    const name = bareCanonicalName(a.name);
    const named = authorNames.has(name) && !actorMayConfigure(db, a.name, task.project) && !(!!a.sessionId && elsewhere.some(s =>
      s.sessionId === a.sessionId && bareCanonicalName(s.agent) === name && ["author", "reviewer"].includes(s.role)));
    const bound = a.task === task.id || sessions.some(s => s.role === "author" && !!a.sessionId && s.sessionId === a.sessionId);
    if ((named || (bound && !reviewers.has(name))) && (!["dead", "stopped", "retired"].includes(a.status ?? "") || a.acpRestartPending)) {
      reasons.push(`registry 里 ${a.name} 仍绑在本卡或被本卡点名为作者，可能在写`);
    }
  }
}

const auditOf = (task: LedgerTask, input: LiveExtendInput, b: Binding, fileGlobs: string[], held: string[]): Omit<ScopeExtendAudit, "old" | "added"> => ({
  op: SCOPE_EXTEND_OP, taskRev: task.rev, workflowRev: input.workflowRev, specRev: task.specRev, round: task.round, stage: task.stage,
  intentId: b.intent.id, intentEventSeq: b.intentEventSeq, poolLinkSeq: b.poolLinkSeq, orderId: b.orderId, peer: b.peer, worker: b.worker, gen: b.gen,
  claimSeq: b.claimSeq, fp: b.fp, branch: b.branch, fileGlobs, held });

function inspect(db: Database, task: LedgerTask, input: LiveExtendInput, reason: string, now: number): LivePlan {
  const p: LivePlan = { old: [], target: [], added: [], retained: [], conflicts: [], reasons: [], binding: null, duplicateOf: null };
  try { p.target = fileList(task.extra.fileGlobs); }
  catch (error) { p.reasons.push((error as Error).message); }
  const w = getWorkflow(db, task.id);
  if (task.rev !== input.taskRev || !w || w.rev !== input.workflowRev) p.reasons.push("任务或 workflow CAS 已变化");
  if (!w || w.project !== task.project || w.mode !== "auto" || w.specRev !== task.specRev) p.reasons.push("只接 auto 且 specRev 对齐的卡");
  if (!["build", "fix"].includes(task.stage)) p.reasons.push("只接 build / fix 阶段的卡");
  const events = listEvents(db, { project: task.project, target: task.id });
  p.binding = liveWriter(db, task, input, events, now, p.reasons);
  if (p.binding) otherWriters(db, task, p.binding, input, events, p.reasons);
  const rows = db.query("SELECT * FROM scheduler_resources WHERE project = ? OR taskId = ?").all(task.project, task.id) as Claim[];
  const own = rows.filter(r => r.taskId === task.id && r.scope === "card" && file(r.resource));
  p.old = own.map(r => r.resource).sort();
  const intents = db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(task.id) as SchedulerIntent[];
  const expected = provenance(db, task, events, intents, { target: p.old, reasons: p.reasons, anchors: {} }, own);
  for (const [resource, anchor] of expected) if (!own.some(r => r.resource === resource && r.intentId === anchor)) p.reasons.push(`失锁或来源被换：${resource}`);
  for (const r of own) if (r.project !== task.project || expected.get(r.resource) !== r.intentId) p.reasons.push(`文件锁缺匹配来源：${r.resource}`);
  p.added = p.target.filter(r => !p.old.includes(r));
  p.retained = p.old.filter(r => !p.target.includes(r));
  // Every claim the card keeps (old, retained) and every one it would add is rescanned; a duplicate receipt is no exception.
  for (const r of rows) {
    if (resourceKey(r.resource) !== r.resource || !["card", "intent"].includes(r.scope)) p.reasons.push("资源表存在未知状态");
    for (const wanted of new Set([...p.old, ...p.target])) {
      const foreign = r.taskId !== task.id || (p.added.includes(wanted) && (r.scope !== "card" || !file(r.resource)));
      if (foreign && resourcesOverlap(wanted, r.resource)) {
        p.conflicts.push({ resource: wanted, held: r.resource, taskId: r.taskId });
      }
    }
  }
  if (p.conflicts.length) p.reasons.push("已持或追加范围与现存资源冲突");
  if (!p.added.length && p.binding && !p.reasons.length) {
    const b = p.binding;
    const same = events.findLast(e => e.kind === "decision" && e.data.op === SCOPE_EXTEND_OP);
    // A receipt only for the identical audit this call would have written: every binding field, not just the order and gen.
    const want: Omit<ScopeExtendAudit, "old" | "added"> = auditOf(task, input, b, p.target, p.old);
    const d = same?.data as Record<string, unknown> | undefined;
    if (same && d && same.actor !== "scheduler" && same.text === reason && Object.entries(want).every(([k, v]) => JSON.stringify(d[k]) === JSON.stringify(v)) &&
      JSON.stringify([...(d.old as string[]), ...(d.added as string[])].sort()) === JSON.stringify(p.old)) p.duplicateOf = same.seq;
    else p.reasons.push("批准范围已全部持锁，没有可追加的文件（非同参数重放，不写空审计）");
  }
  return p;
}

const heldFiles = (db: Database, task: LedgerTask): string[] => (db.query(
  "SELECT resource FROM scheduler_resources WHERE project = ? AND taskId = ? AND scope = 'card'").all(task.project, task.id) as { resource: string }[])
  .map(r => r.resource).filter(file).sort();

function view(p: LivePlan, held: string[], auditSeq: number | null) {
  const b = p.binding;
  return { mode: "live-extend", old: p.old, target: p.target, added: p.added, retained: p.retained, held, conflicts: p.conflicts, reasons: p.reasons,
    intent: b ? { id: b.intent.id, status: b.intent.status } : null,
    order: b ? { orderId: b.orderId, peer: b.peer, worker: b.worker, gen: b.gen, step: b.step, leaseUntil: b.leaseUntil } : null,
    lease: b ? { peer: b.peer, fp: b.fp, branch: b.branch } : null, auditSeq };
}

export function extendLiveWriterScope(db: Database, ctx: WriteCtx, input: LiveExtendInput) {
  const transaction = db.transaction(() => {
    const task = mustTask(db, input.taskId);
    if (task.project !== input.project || ctx.actor === "scheduler" || !actorMayConfigure(db, ctx.actor, task.project)) {
      throw new LedgerError("forbidden", "只接受本项目 PM / owner / master");
    }
    const reason = textOneLine(input.reason, "追加原因", 600);
    const now = ctx.now ?? Date.now();
    const p = inspect(db, task, input, reason, now);
    if (!input.apply) {
      return { ok: true, dryRun: true, executable: !p.reasons.length, duplicate: p.duplicateOf !== null, ...view(p, heldFiles(db, task), p.duplicateOf) };
    }
    if (p.reasons.length || !p.binding) throw new LedgerError("conflict", p.reasons.join("；") || "缺活跃作者绑定", view(p, heldFiles(db, task), null));
    if (p.duplicateOf !== null) return { ok: true, dryRun: false, executable: true, duplicate: true, ...view(p, heldFiles(db, task), p.duplicateOf) };
    const b = p.binding;
    for (const r of p.added) {
      const result = db.query(`INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope)
        VALUES (?, ?, ?, ?, ?, 'card') ON CONFLICT DO NOTHING`).run(task.project, r, task.id, b.intent.id, now);
      if (result.changes !== 1) throw new LedgerError("conflict", `加锁 CAS 失败：${r}`);
    }
    const held = [...p.old, ...p.added].sort();
    const audit: ScopeExtendAudit = { ...auditOf(task, input, b, p.target, held), old: p.old, added: p.added };
    const { event } = appendEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "decision", text: reason,
      data: { ...audit } });
    // The committed state must replay as an exact duplicate of what was just written, or the whole append rolls back.
    const check = inspect(db, mustTask(db, task.id), input, reason, now);
    const actual = heldFiles(db, task);
    if (check.reasons.length || check.duplicateOf !== event.seq || JSON.stringify(actual) !== JSON.stringify(held)) {
      throw new LedgerError("conflict", `追加后复核失败：${check.reasons.join("；") || "持锁与审计不符"}`);
    }
    return { ok: true, dryRun: false, executable: true, duplicate: false, ...view(p, actual, event.seq) };
  });
  // query_only forbids BEGIN IMMEDIATE. Preview takes one read snapshot; apply rechecks everything under the write reservation.
  return busyAsLedgerError("活跃作者追加文件范围", () => input.apply ? transaction.immediate() : transaction.deferred());
}
