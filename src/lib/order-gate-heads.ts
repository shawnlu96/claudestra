/**
 * What a peer order needs before the T87 gate (order-wire-render.ts), so known-safe local facts do not get the whole order refused
 * (i28-GATE2). The gate itself is unchanged; only these two rewrites happen, on the order that goes out, never on local files:
 * - the card's own full heads (headSHA now, plus every `head` / `headSHA` its events recorded: deliver, task-set, review, dispatch)
 *   in inputs become 12-char short SHAs. Only whole 40 / 64 hex runs that are this card's heads; any other long hex still refuses.
 * - a findingId the gate would refuse (a sensitive word, a token or address shape) goes out as an alias F1, F2…; the alias map is
 *   kept on this machine keyed by order id, and a verdict citing the alias is mapped back before it reaches the ledger.
 * A refused order on the scheduler's pool path is recorded once per card + reason (recordGateRefused) instead of the card stalling silently.
 * tests/order-gate-heads.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
import type { OrderWire } from "./order-wire.js";
import { sanitizeForeign } from "./order-wire-render.js";
import { peerSecretHit } from "./peer-secret-gate.js";

const FULL = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HEAD_KEYS = new Set(["head", "headSHA"]);

/** Every full head this card's ledger knows: its headSHA and any head / headSHA field (nested a few levels) in its events. */
export function cardHeads(db: Database, task: Pick<LedgerTask, "project" | "id" | "headSHA">): Set<string> {
  const heads = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && FULL.test(v.toLowerCase())) heads.add(v.toLowerCase()); };
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 3) return;
    for (const [k, x] of Object.entries(v)) (HEAD_KEYS.has(k) ? add(x) : walk(x, depth + 1));
  };
  add(task.headSHA);
  for (const e of listEvents(db, { project: task.project, target: task.id })) walk(e.data, 0);
  return heads;
}

/** Whole 40 / 64 hex runs (same boundary as the gate's head exemption) that are one of `heads` → their 12-char prefix. */
export const shortenHeads = (text: string, heads: ReadonlySet<string>): string =>
  text.replace(/(?<![\w-])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![\w-])/g, (m) => (heads.has(m.toLowerCase()) ? m.slice(0, 12) : m));

/** The gate refuses an id that masking would change or that reads as a secret (order-wire-render.ts gatePeer). */
const refusedId = (id: string): boolean => sanitizeForeign(id) !== id || peerSecretHit(id) !== null;

/** Findings whose id the gate would refuse get F1, F2… (skipping ids already in the order); returns alias → original. */
export function aliasFindings<F extends { findingId: string }>(findings: readonly F[]): { findings: F[]; aliases: Record<string, string> } {
  const taken = new Set(findings.map((f) => f.findingId));
  const aliases: Record<string, string> = {};
  let n = 0;
  const next = (): string => { let a: string; do a = `F${++n}`; while (taken.has(a)); return a; };
  return { findings: findings.map((f) => {
    if (!refusedId(f.findingId)) return f;
    const a = next();
    aliases[a] = f.findingId;
    return { ...f, findingId: a };
  }), aliases };
}

const aliasKey = (orderId: string): string => `lend-alias:${orderId}`;

/**
 * The order as it goes to a peer: card heads in inputs shortened, refused finding ids aliased. `whole` (the unsplit form the gate
 * scans) gets the same rewrite. The alias map is written as one note event keyed by the order id, inside the caller's transaction,
 * so an order the gate then refuses leaves no map behind.
 */
export function forPeer<M extends { wire: OrderWire; whole?: OrderWire }>(db: Database, ctx: WriteCtx, task: LedgerTask, made: M): M {
  const heads = cardHeads(db, task);
  const one = (w: OrderWire) => {
    const a = aliasFindings(w.findings);
    return { wire: { ...w, inputs: w.inputs.map((s) => shortenHeads(s, heads)), findings: a.findings }, aliases: a.aliases };
  };
  const out = one(made.wire);
  if (Object.keys(out.aliases).length && !getEventByDedup(db, aliasKey(made.wire.orderId))) {
    insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: aliasKey(made.wire.orderId) }, { project: task.project, target: task.id,
      kind: "note", text: `出借单 ${made.wire.orderId} 的问题编号外发用别名`, data: { op: "finding_alias", orderId: made.wire.orderId, aliases: out.aliases } }, true);
  }
  return { ...made, wire: out.wire, ...(made.whole ? { whole: one(made.whole).wire } : {}) };
}

/** A peer's verdict citing aliases → the original ids this machine recorded for that order; anything else unchanged. */
export function withOriginalIds<R extends { orderId: string; verdict: { findings: { findingId: string }[] } }>(db: Database, req: R): R {
  const raw = getEventByDedup(db, aliasKey(req.orderId))?.data.aliases;
  if (!raw || typeof raw !== "object") return req;
  const map = raw as Record<string, unknown>;
  const orig = (id: string): string => (Object.hasOwn(map, id) && typeof map[id] === "string" ? map[id] as string : id);
  return { ...req, verdict: { ...req.verdict, findings: req.verdict.findings.map((f) => ({ ...f, findingId: orig(f.findingId) })) } };
}

/** Only the peer gate's refusals raise this alarm; other refused offers keep their existing paths. */
export const isGateRefusal = (message: string): boolean => message.includes("外发闸");

/**
 * One scheduler event per card + reason when the peer gate refused an order: PM's watch sees why the card is not moving and what
 * it waits for. The gate is not loosened, so the round waits for a local worker (or PM fixing the material and offering again).
 */
export function recordGateRefused(db: Database, ctx: WriteCtx, task: Pick<LedgerTask, "project" | "id" | "stage">, message: string):
  { event: LedgerEvent; duplicate: boolean } {
  const reason = message.replace(/\s+/g, " ").trim().slice(0, 560);
  const key = `scheduler:gate-refused:${task.id}:${createHash("sha256").update(reason).digest("hex").slice(0, 24)}`;
  const prior = getEventByDedup(db, key);
  if (prior) return { event: prior, duplicate: true };
  const waiting = `卡停在 ${task.stage}：外发闸不放宽，这一轮等本机执行者接手，或 PM 处理材料后重挂`;
  const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id,
    kind: "scheduler", text: `出借单被外发闸拒收：${reason}。${waiting}`, data: { op: "gate_refused", reason, waiting } }, true);
  return { event, duplicate: false };
}
