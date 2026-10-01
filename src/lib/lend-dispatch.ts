/**
 * The push loop's logic (lend protocol v2, docs/design/remote-capacity.md §3.2), with every effect injected; the bridge wires it
 * in bridge/lend-dispatch.ts. Each tick announces pooled orders to peers that said a fresh v2 hello, batched per peer; what the
 * lender answers goes to the ledger (accepted → acknowledged, refused → withdrawn). A push is only a notice — the lender's v1
 * claim is still the one authoritative CAS — so a push that fails just backs off (5 s, 15 s, 30 s, then every 60 s) and the
 * ledger's push TTL withdraws what never got through. Send state lives in memory only: after a restart every pooled order is
 * announced once more, which the lender dedups by orderId. Never plaintext: the peer must pass peerLendProblem (E2E record,
 * pinned key) and the answer must have come back over E2E. tests/lend-dispatch.test.ts.
 */
import type { PushCandidate } from "./ledger-lend-peers.js";
import { offerBody, OFFER_MAX, parseV2Response, type OfferRequest } from "./lend-wire-v2.js";

export const PUSH_TICK_MS = 5_000;
const BACKOFF_MS = [5_000, 15_000, 30_000];
const STEADY_MS = 60_000;
/** Wait before the next attempt after `tries` failed ones. */
export const backoffAfter = (tries: number): number => BACKOFF_MS[tries - 1] ?? STEADY_MS;

export interface PushSend { status: number; body: unknown; e2e: boolean }

export interface DispatchDeps {
  now(): number;
  /** Pooled orders for peers with a fresh v2 hello and a live grant (ledger, read-only). */
  candidates(now: number): PushCandidate[];
  /** null = this peer can take a push (handshake complete, key pinned, E2E on record, no proxy); otherwise why not. */
  problem(peer: string): Promise<string | null>;
  /** One push; throwing = not known whether it arrived. */
  send(peer: string, body: OfferRequest): Promise<PushSend>;
  /** Hand the lender's answer to the ledger (`ledger lend-pushed`); false = not written, the push is retried. */
  record(peer: string, answer: unknown): Promise<boolean>;
  /** Any pooled order past its push TTL (ledger, read-only)? Then sweep() withdraws them. */
  ttlDue(now: number): boolean;
  sweep(): Promise<void>;
  log(msg: string): void;
}

interface SendState { tries: number; nextAt: number; done: boolean }
export interface TickReport { pushed: string[]; acked: string[]; failed: string[]; skipped: string[]; swept: boolean }

/** Did the lender answer this exact batch (every id one of ours, nothing twice)? Anything else is treated as no answer. */
function answerFor(res: PushSend, ids: Set<string>): { accepted: string[]; refused: string[]; raw: unknown } | string {
  if (!res.e2e) return "应答不是经端到端加密回来的";
  if (res.status !== 200) return `对方回了 ${res.status}`;
  const a = parseV2Response("offer", res.body);
  if (!a.ok) return `应答看不懂：${a.error}`;
  const answered = [...a.value.accepted, ...a.value.refused.map((r) => r.orderId)];
  if (new Set(answered).size !== answered.length || answered.some((id) => !ids.has(id))) return "应答里的单号对不上这次推送";
  return { accepted: a.value.accepted, refused: a.value.refused.map((r) => r.orderId), raw: res.body };
}

export function createPushLoop(deps: DispatchDeps): { tick(): Promise<TickReport | null>; state: Map<string, SendState> } {
  const state = new Map<string, SendState>();
  let running = false;

  const fail = (ids: string[], now: number) => {
    for (const id of ids) {
      const s = state.get(id) ?? { tries: 0, nextAt: 0, done: false };
      state.set(id, { tries: s.tries + 1, nextAt: now + backoffAfter(s.tries + 1), done: false });
    }
  };

  async function pushPeer(peer: string, batch: PushCandidate[], now: number, rep: TickReport): Promise<void> {
    const ids = batch.map((c) => c.summary.orderId);
    const why = await deps.problem(peer);
    if (why) {
      deps.log(`不推给 ${peer}：${why}`);
      rep.skipped.push(...ids);
      return fail(ids, now);
    }
    rep.pushed.push(...ids);
    let res: PushSend;
    try {
      res = await deps.send(peer, offerBody(batch.map((c) => c.summary)));
    } catch (e) {
      deps.log(`推给 ${peer} 没送到（之后重推）：${(e as Error).message}`);
      rep.failed.push(...ids);
      return fail(ids, now);
    }
    const a = answerFor(res, new Set(ids));
    if (typeof a === "string" || !(await deps.record(peer, a.raw))) {
      deps.log(`推给 ${peer} 的应答没入账（之后重推）：${typeof a === "string" ? a : "台账没写上"}`);
      rep.failed.push(...ids);
      return fail(ids, now);
    }
    const answered = new Set([...a.accepted, ...a.refused]);
    for (const id of answered) state.set(id, { tries: 0, nextAt: 0, done: true });
    rep.acked.push(...a.accepted);
    fail(ids.filter((id) => !answered.has(id)), now);
    rep.failed.push(...ids.filter((id) => !answered.has(id)));
  }

  async function tick(): Promise<TickReport | null> {
    if (running) return null;
    running = true;
    try {
      const now = deps.now();
      const rep: TickReport = { pushed: [], acked: [], failed: [], skipped: [], swept: false };
      const cands = deps.candidates(now);
      const live = new Set(cands.map((c) => c.summary.orderId));
      for (const id of state.keys()) if (!live.has(id)) state.delete(id);
      const byPeer = new Map<string, PushCandidate[]>();
      for (const c of cands) {
        const s = state.get(c.summary.orderId);
        if (s && (s.done || s.nextAt > now)) continue;
        const list = byPeer.get(c.peer) ?? [];
        if (list.length < OFFER_MAX) byPeer.set(c.peer, [...list, c]);
      }
      for (const [peer, batch] of byPeer) await pushPeer(peer, batch, now, rep);
      if (deps.ttlDue(deps.now())) {
        await deps.sweep();
        rep.swept = true;
      }
      return rep;
    } finally {
      running = false;
    }
  }

  return { tick, state };
}
