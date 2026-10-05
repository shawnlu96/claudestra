/**
 * What a peer order needs before the T87 gate (order-wire-render.ts), so known-safe local facts do not get the whole order refused
 * (i28-GATE2). The gate itself is unchanged; only these two rewrites happen, on the order that goes out, never on local files:
 * - the card's own full heads (headSHA now, plus every `head` / `headSHA` its events recorded: deliver, task-set, review, dispatch)
 *   in inputs become 12-char short SHAs. Only whole 40 / 64 hex runs that are this card's heads; any other long hex still refuses.
 * - a findingId the gate would refuse (a sensitive word, a token or address shape) goes out as an alias F1, F2…; the alias map is
 *   kept on this machine keyed by order id, and a verdict citing the alias is mapped back before it reaches the ledger.
 * - (i28-GATE3) any other whole 40-char lowercase hex in inputs (a commit SHA a report quoted, e.g. the base) also goes out as its
 *   12-char prefix, with a note counting how many were cut. Not inside a path or file name, not mixed case, not 64 long; and a text
 *   where a SHA is part of what the gate would read as a secret (see shortenShas) is not cut at all: it refuses as before.
 * A refused order on the scheduler's pool path is recorded once per card + reason (recordGateRefused) instead of the card stalling silently.
 * tests/order-gate-heads.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import type { OrderWire } from "./order-wire.js";
import { fold, OrderRenderError, sanitizeForeign } from "./order-wire-render.js";
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

const HEAD_RUN = /(?<![\w-])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{40})(?![\w-])/g;

/** Whole 40 / 64 hex runs (same boundary as the gate's head exemption) that are one of `heads` → their 12-char prefix. */
export const shortenHeads = (text: string, heads: ReadonlySet<string>): string =>
  text.replace(HEAD_RUN, (m) => (heads.has(m.toLowerCase()) ? m.slice(0, 12) : m));

/**
 * A whole 40- or 64-char lowercase hex run (a commit SHA, a SHA-256 digest): neither side a word char or `-`, not a path segment
 * (`/` `\` before or after), not a file name (a single `.` before, `.x` after). A sentence-ending `.` and a git range `a..b` /
 * `a...b` are still boundaries.
 */
const COMMIT_SHA = /(?<![\w/\\-])(?<!(?<!\.)\.)(?:[0-9a-f]{64}|[0-9a-f]{40})(?![\w/\\-]|\.\w)/g;

/**
 * A line naming a secret: a 40 / 64-hex there may be an access token, so it is not cut and the gate judges it. Plain substring
 * match, case-insensitive (`author` counts as `auth`: refusal first); covers `name=value` / `name: value`.
 */
const SECRET_WORD = /credential|secret|token|passw(?:or)?d|api[\s_-]*key|auth|bearer|private[\s_-]*key/i;

/** Private-use, so neither NFKC nor the gate's folding touches it; stands for the SHA being judged in the gate's view. */
const MARK = "\uE000";
/** One unbroken hex run the gate would read once whitespace is removed, holding the SHA being judged. */
const HEX_RUN = new RegExp(`[0-9a-f${MARK}]*${MARK}[0-9a-f${MARK}]*`, "gi");
/** A cut SHA's run is safe only alone with < 8 hex (the gate's own joinable fragment size) on each side. */
const joinsHex = (run: string): boolean => run.split(MARK).length > 2 || run.split(MARK).some((part) => part.length >= 8);
/** COMMIT_SHA's boundary, checked again on the folded view: zero-width chars dropped and NFKC `／` `＼` `．` can make a path or file name. */
const TOUCHES = new RegExp(`[\\w/\\\\-]${MARK}|(?<!\\.)\\.${MARK}|${MARK}(?:[\\w/\\\\-]|\\.\\w)`);
/** Same letter / digit shape as the SHA but not hex: the gate's other rules (prefix, field name, random) see the same text. */
const unhex = (m: string): string => m.replace(/[a-fA-F]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 16));

/** Card heads (any case) and commit / digest shaped runs, each once, in text order. */
function shaSpans(text: string, heads: ReadonlySet<string>): { at: number; sha: string }[] {
  const at = new Map<number, string>();
  for (const m of text.matchAll(HEAD_RUN)) if (heads.has(m[0].toLowerCase())) at.set(m.index, m[0]);
  for (const m of text.matchAll(COMMIT_SHA)) if (!at.has(m.index)) at.set(m.index, m[0]);
  return [...at].sort((a, b) => a[0] - b[0]).map(([i, sha]) => ({ at: i, sha }));
}

/**
 * Card heads (GATE2), then commit SHAs and SHA-256 digests (40 / 64 lowercase hex) → 12-char prefixes; `cut` counts them. Each SHA is
 * judged on its own (GATE4) on the gate's folded view (NFKC, zero-width dropped, blanks joined): one on a line naming a secret, touching
 * a word char or a path / file-name boundary, or sharing one hex run with 8+ hex once whitespace is removed stays whole, and so does
 * one the gate would still read as part of a secret once made non-hex (`sk- ` / `ghp_` before it, a field name…). A whole SHA left in
 * the text still makes the gate refuse the order. If the text trips the gate without any SHA, or only through several SHAs together,
 * nothing in it is cut and the gate gets it unchanged. Any other hex stays for the gate.
 */
export function shortenShas(text: string, heads: ReadonlySet<string>, ledgerHead: string | null = null): { text: string; cut: number } {
  const spans = shaSpans(text, heads);
  if (!spans.length) return { text, cut: 0 };
  const swap = (rep: (sha: string, i: number) => string): string => {
    let out = "";
    let end = 0;
    spans.forEach(({ at, sha }, i) => { out += text.slice(end, at) + rep(sha, i); end = at + sha.length; });
    return out + text.slice(end);
  };
  const gate = (rep: (sha: string, i: number) => string): string | null => peerSecretHit(fold(swap(rep)), ledgerHead);
  const held = new Set<number>();
  if (gate(unhex) !== null) {
    if (gate(() => MARK) !== null) return { text, cut: 0 };
    spans.forEach((_, i) => { if (gate((s, j) => (j === i ? unhex(s) : MARK)) !== null) held.add(i); });
    if (!held.size) return { text, cut: 0 };
  }
  spans.forEach((_, i) => {
    if (held.has(i)) return;
    const marked = fold(swap((s, j) => (j === i ? MARK : s)));
    if (marked.split("\n").some((line) => line.includes(MARK) && SECRET_WORD.test(line)) || TOUCHES.test(marked)
      || (marked.replace(/\s+/g, "").match(HEX_RUN) ?? []).some(joinsHex)) held.add(i);
  });
  const cut = spans.length - held.size;
  return cut ? { text: swap((s, i) => (held.has(i) ? s : s.slice(0, 12))), cut } : { text, cut: 0 };
}

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
const shaNoteKey = (orderId: string): string => `lend-sha-cut:${orderId}`;

/**
 * The order as it goes to a peer: card heads and commit SHAs in inputs shortened, refused finding ids aliased. `whole` (the unsplit form the gate
 * scans) gets the same rewrite. The alias map and the SHA cut count are each written as one note event keyed by the order id, inside the caller's
 * transaction, so an order the gate then refuses leaves neither behind.
 */
export function forPeer<M extends { wire: OrderWire; whole?: OrderWire }>(db: Database, ctx: WriteCtx, task: LedgerTask, made: M): M {
  const heads = cardHeads(db, task);
  const one = (w: OrderWire) => {
    const a = aliasFindings(w.findings);
    const cuts = w.inputs.map((s) => shortenShas(s, heads, w.head));
    return { wire: { ...w, inputs: cuts.map((c) => c.text), findings: a.findings }, aliases: a.aliases, cut: cuts.reduce((n, c) => n + c.cut, 0) };
  };
  const out = one(made.wire);
  if (out.cut && !getEventByDedup(db, shaNoteKey(made.wire.orderId))) {
    insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: shaNoteKey(made.wire.orderId) }, { project: task.project, target: task.id,
      kind: "note", text: `派单材料里 ${out.cut} 处完整 SHA 已截成 12 位（${made.wire.orderId}）`, data: { op: "sha_cut", orderId: made.wire.orderId, count: out.cut } }, true);
  }
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

/** Catch outside the offer transaction so refused orders roll back before their alarm is persisted. */
export function gateOfferTransaction<T>(db: Database, ctx: WriteCtx, task: Pick<LedgerTask, "project" | "id" | "stage">,
  offer: () => T): T {
  try { return tx(db, offer); }
  catch (e) {
    if (e instanceof OrderRenderError) tx(db, () => recordGateRefused(db, ctx, task, e.message));
    throw e;
  }
}

/**
 * One scheduler event per card + reason when the peer gate refused an order: PM's watch sees why the card is not moving and what
 * it waits for. The gate is not loosened, so the round waits for a local worker (or PM fixing the material and offering again).
 */
export function recordGateRefused(db: Database, ctx: WriteCtx, task: Pick<LedgerTask, "project" | "id" | "stage">, message: string,
  facts?: Record<string, unknown> & { intentId: string }): { event: LedgerEvent; duplicate: boolean } {
  const reason = message.replace(/\s+/g, " ").trim().slice(0, 560);
  // With facts (the scheduler's pool path, scheduler-dispatch-block.ts) one event per offer: a re-offer after a material change is a new block.
  const key = `scheduler:gate-refused:${task.id}:${createHash("sha256").update(reason).digest("hex").slice(0, 24)}${facts ? `:${facts.intentId}` : ""}`;
  const prior = getEventByDedup(db, key);
  if (prior) return { event: prior, duplicate: true };
  const waiting = `卡停在 ${task.stage}：外发闸不放宽，这一轮等本机执行者接手，或 PM 处理材料后重挂${facts ? "；同一份材料不再外发，材料或外发闸处理器版本变了自动再试一次（仍完整过闸）" : ""}`;
  const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id,
    kind: "scheduler", text: `出借单被外发闸拒收：${reason}。${waiting}`, data: { op: "gate_refused", reason, waiting, ...facts } }, true);
  return { event, duplicate: false };
}
