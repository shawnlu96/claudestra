/**
 * WEXT1: the structured audit of a live writer's file-scope extension, and its replay. The audit is a PM decision bound to the
 * real dispatch intent, its pool-linked lend order, that order's claim (gen) and the lease peer / fingerprint / branch; it never
 * claims a new dispatch was sent or a new order taken. Replay accepts it only when every binding is found in the card's own
 * events and its `old` equals the claims replayed up to it, so a missing, forged, repeated or reordered audit fails closed. The approved
 * scope / task rev, stage / round / specRev, order row, offer branch and lease fingerprint it names are checked against their sources too.
 */
import type { Database } from "bun:sqlite";
import { getLendOrder } from "./ledger-lend.js";
import { getWriteLease } from "./ledger-lend-lease.js";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { getIntent, getWorkflow, resourceKey } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { lendBranch, stepOfStage } from "./lend-git.js";

export const SCOPE_EXTEND_OP = "scheduler_file_scope_extend";

export interface ScopeExtendAudit {
  op: typeof SCOPE_EXTEND_OP; taskRev: number; workflowRev: number; specRev: number; round: number; stage: string;
  intentId: string; intentEventSeq: number; poolLinkSeq: number; orderId: string; peer: string; worker: string; gen: number; claimSeq: number;
  fp: string; branch: string; fileGlobs: string[]; old: string[]; added: string[]; held: string[];
}

const isFile = (s: unknown): s is string => typeof s === "string" && !s.includes(":") && !s.startsWith("/") && resourceKey(s) === s;
const sortedFiles = (v: unknown): v is string[] => Array.isArray(v) && v.every(isFile) && v.every((x, i) => i === 0 || v[i - 1]! < x);
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const nat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** The pool link and the claim note the scheduler / claimLend wrote for this order, read from the card's own events. */
export function orderBinding(events: LedgerEvent[], intentId: string, orderId: string, peer: string, gen: number, worker: string, before = Infinity) {
  const links = events.filter(e => e.kind === "scheduler" && e.data.op === "pool_offer" && e.data.id === intentId && e.seq < before);
  const link = links.length === 1 && links[0]!.dedupKey === `scheduler:${intentId}:pool` && links[0]!.data.orderId === orderId &&
    links[0]!.data.peer === peer ? links[0]! : null;
  const claims = events.filter(e => e.kind === "note" && e.seq < before && typeof e.data.lend === "object" && e.data.lend !== null &&
    (e.data.lend as Record<string, unknown>).orderId === orderId && (e.data.lend as Record<string, unknown>).op === "claim");
  const lend = (e: LedgerEvent) => e.data.lend as Record<string, unknown>;
  // Each claim bumps the gen by one; exactly one note may carry this gen, and it must be the newest claim before `before`.
  const same = claims.filter(e => lend(e).gen === gen);
  const claim = same.length === 1 && claims.at(-1) === same[0] && lend(same[0]!).peer === peer && lend(same[0]!).worker === worker ? same[0]! : null;
  return { link, claim };
}

/** The approval the audit cites: the task rev it was written at and the fileGlobs that rev carried, from the card's own task events. */
function approvedAt(events: LedgerEvent[], before: number): { rev: number | null; fileGlobs: unknown } {
  const tasks = events.filter(x => x.kind === "task" && x.seq < before);
  const extra = tasks.findLast(x => object(x.data.patch) && "extra" in x.data.patch);
  const patch = extra?.data.patch as Record<string, unknown> | undefined;
  const rev = tasks.at(-1)?.data.rev;
  return { rev: int(rev) ? rev : null, fileGlobs: object(patch?.extra) ? patch.extra.fileGlobs : undefined };
}

/** Every binding the audit names, checked against the rows and events that produced it. Returns why it is not provable. */
function bindingGap(db: Database, project: string, e: LedgerEvent, d: ScopeExtendAudit, events: LedgerEvent[]): string | null {
  // The approved scope and its CAS: the task rev the audit was written at, and the fileGlobs that rev carried; added = approved − old.
  const approved = approvedAt(events, e.seq);
  if (approved.rev !== d.taskRev || !Array.isArray(approved.fileGlobs) || !approved.fileGlobs.every(isFile) ||
    !same([...new Set(approved.fileGlobs)].sort(), d.fileGlobs)) return "扩范围审计的批准范围 / 任务 rev 与卡的历史不符";
  if (!same(d.added, d.fileGlobs.filter(r => !d.old.includes(r)))) return "扩范围审计的追加项不是批准范围减旧锁";
  const w = getWorkflow(db, e.target);
  if (!w || w.project !== project || d.workflowRev > w.rev) return "扩范围审计的 workflow rev 不可核";
  const stage = events.findLast(x => x.kind === "stage" && x.seq < e.seq);
  if (stage?.data.to !== d.stage || stage.data.round !== d.round || stage.data.specRev !== d.specRev) return "扩范围审计的阶段 / 轮次 / specRev 与卡的历史不符";
  const intent = getIntent(db, d.intentId);
  if (!intent || intent.taskId !== e.target || intent.project !== project || intent.specRev !== d.specRev) return "扩范围审计的派单意图与 specRev 不符";
  // The order, its offer note and the lease row it held: peer, worker, step, rev, round, branch and the full fingerprint.
  const order = getLendOrder(db, d.orderId);
  if (!order || order.taskId !== e.target || order.project !== project || order.peer !== d.peer || order.worker !== d.worker ||
    order.step !== stepOfStage(d.stage) || order.specRev !== d.specRev || order.round !== d.round || order.branch !== d.branch ||
    order.leaseGen < d.gen) return "扩范围审计与出借单记录不符";
  const offers = events.filter(x => x.kind === "note" && x.seq < e.seq && object(x.data.lend) && x.data.lend.orderId === d.orderId && x.data.lend.op === "offer");
  if (offers.length !== 1 || (offers[0]!.data.lend as Record<string, unknown>).branch !== d.branch) return "扩范围审计的出借分支与挂单记录不符";
  const lease = getWriteLease(db, e.target);
  if (d.fp !== d.fp.toLowerCase() || lendBranch(e.target, d.fp) !== d.branch || !lease || lease.project !== project || lease.peer !== d.peer ||
    lease.branch !== d.branch || lease.fp.toLowerCase() !== d.fp) return "扩范围审计的指纹 / 分支与写租约不符";
  return null;
}

/**
 * Replays one extension audit onto the expected claims. Returns a reason when it is not provably real; otherwise adds the
 * resources to `expected`, `planned` and `historical` under the original dispatch intent.
 */
export function replayScopeExtend(db: Database, project: string, e: LedgerEvent, events: LedgerEvent[], planned: Map<string, Set<string>>,
  expected: Map<string, string>, historical: Map<string, string>): string | null {
  const d = e.data as Partial<ScopeExtendAudit>;
  if (!actorMayConfigure(db, e.actor, project) || e.actor === "scheduler") return "扩范围审计不是 PM 写的";
  if (!text(d.intentId) || !text(d.orderId) || !text(d.peer) || !text(d.worker) || !text(d.fp) || !text(d.branch) || !int(d.gen) ||
    !int(d.intentEventSeq) || !int(d.claimSeq) || !int(d.poolLinkSeq) || !sortedFiles(d.old) || !sortedFiles(d.added) || !sortedFiles(d.held) ||
    !sortedFiles(d.fileGlobs) || !int(d.taskRev) || !int(d.workflowRev) || !int(d.specRev) || !nat(d.round) || !["build", "fix"].includes(d.stage as string) ||
    !d.added.length) return "扩范围审计字段损坏";
  const plan = events.find(x => x.seq === d.intentEventSeq);
  if (!planned.has(d.intentId) || plan?.kind !== "scheduler" || plan.data.op !== "plan" || plan.data.id !== d.intentId ||
    plan.data.action !== "dispatch" || plan.data.recipient !== `peer:${d.peer}`) return "扩范围审计的派单来源不可核";
  const { link, claim } = orderBinding(events, d.intentId, d.orderId, d.peer, d.gen, d.worker, e.seq);
  if (!link || link.seq !== d.poolLinkSeq || !claim || claim.seq !== d.claimSeq) return "扩范围审计的出借单 / 领单来源不可核";
  const gap = bindingGap(db, project, e, d as ScopeExtendAudit, events);
  if (gap) return gap;
  const current = [...expected.keys()].sort();
  if (JSON.stringify(current) !== JSON.stringify(d.old) || d.added.some(r => expected.has(r)) ||
    JSON.stringify([...d.old, ...d.added].sort()) !== JSON.stringify(d.held)) return "扩范围审计与重放的旧锁不一致（重复、乱序或缺失）";
  for (const r of d.added) {
    expected.set(r, d.intentId);
    planned.get(d.intentId)!.add(r);
    historical.set(r, d.intentId);
  }
  return null;
}
