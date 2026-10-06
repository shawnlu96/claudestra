/**
 * WEXT1: the structured audit of a live writer's file-scope extension, and its replay. The audit is a PM decision bound to the
 * real dispatch intent, its pool-linked lend order, that order's claim (gen) and the lease peer / fingerprint / branch; it never
 * claims a new dispatch was sent or a new order taken. Replay accepts it only when every binding is found in the card's own
 * events and its `old` equals the claims replayed up to it, so a missing, forged, repeated or reordered audit fails closed.
 */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import { resourceKey } from "./ledger-scheduler.js";
import type { LedgerEvent } from "./ledger-stages.js";

export const SCOPE_EXTEND_OP = "scheduler_file_scope_extend";

export interface ScopeExtendAudit {
  op: typeof SCOPE_EXTEND_OP; taskRev: number; workflowRev: number; specRev: number; round: number; stage: string;
  intentId: string; intentEventSeq: number; poolLinkSeq: number; orderId: string; peer: string; worker: string; gen: number; claimSeq: number;
  fp: string; branch: string; fileGlobs: string[]; old: string[]; added: string[]; held: string[];
}

const isFile = (s: unknown): s is string => typeof s === "string" && !s.includes(":") && !s.startsWith("/") && resourceKey(s) === s;
const sortedFiles = (v: unknown): v is string[] => Array.isArray(v) && v.every(isFile) && v.every((x, i) => i === 0 || v[i - 1]! < x);
const int = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
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
    !d.added.length) return "扩范围审计字段损坏";
  const plan = events.find(x => x.seq === d.intentEventSeq);
  if (!planned.has(d.intentId) || plan?.kind !== "scheduler" || plan.data.op !== "plan" || plan.data.id !== d.intentId ||
    plan.data.action !== "dispatch" || plan.data.recipient !== `peer:${d.peer}`) return "扩范围审计的派单来源不可核";
  const { link, claim } = orderBinding(events, d.intentId, d.orderId, d.peer, d.gen, d.worker, e.seq);
  if (!link || link.seq !== d.poolLinkSeq || !claim || claim.seq !== d.claimSeq) return "扩范围审计的出借单 / 领单来源不可核";
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
