/**
 * CVREBOR1: read-only recognition of a write lease ended by the scheduler's formal CONV2 family-swap reclaim (fix_strategy_reclaim).
 * It is not a PM reclaim and is never rewritten into one: the v1 path and its marker keep their meaning. Every proof is a
 * scheduler-written, dedup-keyed ledger fact; a reason string, op, ordinary note or a cancelled status alone proves nothing.
 */
import type { Database } from "bun:sqlite";
import { lendBranch } from "./lend-git.js";
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
import { LEND_LIVE } from "./ledger-lend-schema.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import type { LedgerEvent } from "./ledger-stages.js";
import type { LendOrder } from "./ledger-lend.js";
import { stoppedReportSeq } from "./lend-reclaim-stopped.js";
import { conflict, digest, readFacts, sha40, type ConvEnd, type ReborrowFacts } from "./lend-reborrow-facts.js";

const isFamily = (f: unknown): f is LendFamily => (LEND_FAMILIES as readonly unknown[]).includes(f);
const writeStep = (o: LendOrder): boolean => o.step === "write" || o.step === "fix";
/** A formal fact is the exact dedup-keyed scheduler event, not any event that merely carries the same op. */
function formal(db: Database, e: LedgerEvent | undefined, key: string, taskId: string): e is LedgerEvent {
  return !!e && e.kind === "scheduler" && e.actor === "scheduler" && e.target === taskId && e.dedupKey === key && getEventByDedup(db, key)?.seq === e.seq;
}

/** Clean stop of one cancelled lease generation: the bound clean ack, or the reclaim's own stopped-exit record of a real stopped report. */
function cleanProof(db: Database, events: LedgerEvent[], intentId: string, o: LendOrder, end: LedgerEvent): LedgerEvent | null {
  const ack = getEventByDedup(db, `convergence-cancel:${o.orderId}`);
  if (ack && ack.kind === "scheduler" && ack.actor === "scheduler" && ack.target === o.taskId && ack.seq < end.seq &&
    ack.data.op === "convergence_cancel_ack" && ack.data.orderId === o.orderId && ack.data.intentId === intentId &&
    ack.data.clean === true && ack.data.gen === o.leaseGen) return ack;
  const key = `scheduler:${intentId}:stopped-exit:${o.orderId}`, exit = events.find((e) => e.dedupKey === key);
  const report = stoppedReportSeq(db, o.orderId, o.leaseGen);
  if (formal(db, exit, key, o.taskId) && exit.seq < end.seq && exit.data.op === "convergence_stopped_exit" && exit.data.intentId === intentId &&
    exit.data.orderId === o.orderId && exit.data.gen === o.leaseGen && report !== null && exit.data.reportSeq === report) return exit;
  return null;
}

export function captureConvReborrowFacts(db: Database, taskId: string, peer: string, repo: string): ReborrowFacts {
  const facts = readFacts(db, taskId);
  const { task, lease, orders, events, workflow, steps, intents } = facts;
  if (task.stage !== "fix") conflict("CONV 续修只接 fix 阶段的卡");
  if (!lease || lease.state !== "ended") conflict("没有已结束的写租约");
  const ended = lease!;
  if (ended.project !== task.project || ended.peer !== peer || ended.repo !== repo) conflict("peer / 仓库与原租约不符");
  if (task.branch !== ended.branch || lendBranch(task.id, ended.fp) !== ended.branch) conflict("卡分支或实例指纹与原租约不符");
  if (!task.headSHA || !sha40.test(task.headSHA)) conflict("卡上没有可核对的原已审 head");
  // The newest end projection decides; a bad latest proof never falls back to an older good one.
  const end = events.findLast((e) => e.data.op === "fix_strategy_reclaim");
  const id = end?.data.intentId;
  if (!end || typeof id !== "string" || !formal(db, end, `scheduler:${id}:reclaim`, task.id) || end.project !== task.project) conflict("缺少正式 CONV 结束事件");
  const d = end!.data, intentId = id as string;
  if (events.some((e) => e.seq > end!.seq && (e.data.lend as { op?: string } | undefined)?.op === "reclaim")) conflict("CONV 结束后另有收回，最新结束不是 CONV");
  if (!isFamily(d.family) || d.reason !== `CONV2 other_family ${d.family}; intent ${intentId}` || ended.reason !== d.reason ||
    ended.updatedAt !== end!.ts || d.peer !== peer) conflict("CONV 结束事件与最新已结束租约投影不符");
  if (d.specRev !== task.specRev || d.round !== task.round || d.head !== task.headSHA) conflict("CONV 结束事件的规格、轮次或已审 head 不符");
  const intent = (intents as Record<string, unknown>[]).find((i) => i.id === intentId);
  if (!intent || intent.action !== "fix_swap" || intent.taskId !== task.id || intent.project !== task.project || intent.specRev !== task.specRev ||
    intent.head !== task.headSHA || !["done", "cancelled"].includes(String(intent.status)) || Number(intent.createdAt) > end!.ts) {
    conflict("原 fix_swap 收敛意图不符或未正规结清");
  }
  if (getEventByDedup(db, `scheduler:${intentId}:replacement`) || getEventByDedup(db, `scheduler:${intentId}:remote-strategy`)) {
    conflict("CONV 已绑定或派出替换作者");
  }
  const materials = events.find((e) => e.dedupKey === `scheduler:${intentId}:materials`);
  if (!formal(db, materials, `scheduler:${intentId}:materials`, task.id) || materials.seq >= end!.seq ||
    materials.data.mode !== "other_family" || materials.data.family !== d.family || materials.data.intentId !== intentId) {
    conflict("缺少冻结的 other_family 材料");
  }
  if (orders.some((o) => LEND_LIVE.includes(o.status))) conflict("仍有活单或未知结果");
  if (steps.some((s) => s.state === "assigned") || intents.some((i) => ["pending", "submitted", "unknown"].includes(i.status))) {
    conflict("仍有未结束的本机步骤或调度意图");
  }
  const sessions = db.query("SELECT * FROM scheduler_sessions WHERE taskId = ? ORDER BY role").all(task.id) as { role: string; state: string }[];
  if (sessions.some((s) => s.role === "author" && s.state !== "retired")) conflict("仍有未退役的作者会话");
  const writers = orders.filter(writeStep).sort((a, b) => b.createdAt - a.createdAt);
  if (writers.some((o) => o.createdAt > end!.ts)) conflict("CONV 结束后已经签发过写单");
  const held = writers.filter((o) => o.peer === peer && o.repo === repo && o.branch === ended.branch);
  const previous = held[0];
  if (!previous || previous.specRev !== task.specRev || !["done", "cancelled", "released"].includes(previous.status)) conflict("原订单与租约 / CONV 结束事实不符");
  const cancels = events.filter((e) => e.data.op === "convergence_cancel" && e.data.intentId === intentId);
  for (const c of cancels) {
    const o = orders.find((x) => x.orderId === c.data.orderId);
    if (!formal(db, c, `scheduler:${intentId}:cancel:${String(c.data.orderId)}`, task.id) || c.seq >= end!.seq || !o ||
      o.status !== "cancelled" || o.leaseGen !== c.data.gen) conflict("convergence_cancel 未绑定原撤单 / 代数");
  }
  const proofs: LedgerEvent[] = [];
  for (const o of held.filter((x) => x.status === "cancelled")) {
    if (!cancels.some((c) => c.data.orderId === o.orderId) && o.orderId === previous!.orderId) conflict("原写单只被取消，没有 CONV 撤单记录");
    if (o.leaseGen === 0) continue; // never claimed: no worker existed for this generation
    const proof = cleanProof(db, events, intentId, o, end!);
    if (!proof) conflict(`旧写单 ${o.orderId} 只取消未确认干净停止`);
    proofs.push(proof!);
  }
  const from = previous!.family, to = d.family as LendFamily;
  const author = facts.authorFamily ?? (workflow?.specRev === task.specRev ? workflow.authorFamily : previous!.family);
  if (author !== from || to === from) conflict("原作者家族与 CONV 目标家族不符");
  const conv: ConvEnd = { intent: intent!, materials: materials!, cancels, proofs, from, to };
  return { task, lease: ended, previous: previous!, reclaim: end!, family: to, fingerprint: digest({ ...facts, sessions }), conv };
}

/** Under the canonical writer's BEGIN IMMEDIATE: re-read every fact; any drift since preparation is a conflict, never a write. */
export function assertConvReborrowCas(db: Database, prepared: ReborrowFacts): void {
  if (!db.inTransaction) throw new LedgerError("invalid", "恢复 CAS 必须在 canonical writer 的写事务内执行");
  const fresh = captureConvReborrowFacts(db, prepared.task.id, prepared.lease.peer, prepared.lease.repo);
  if (fresh.fingerprint !== prepared.fingerprint || digest(fresh) !== digest(prepared)) conflict("读取来源期间任务、材料、订单或租约发生变化");
}
