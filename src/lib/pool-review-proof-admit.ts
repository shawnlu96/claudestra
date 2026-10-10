/**
 * dispatch-recovery-POOLRV1 r1: what writeLendResult binds to a pool review event, inside its own transaction. The received text
 * is archived when it hashes to the body sha; a ticket is kept only if it verifies against the key pinned for the peer no later
 * than the order's claim. Anything missing is recorded as a refusal: the verdict still enters as before, never as an AUTO source.
 * tests/pool-review-proof-raw.test.ts, tests/pool-review-proof.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { LendOrder } from "./ledger-lend.js";
import { currentPin, readPeerPins } from "./peer-trust.js";
import { readPeers } from "./peers.js";
import type { ResultRequest } from "./lend-wire.js";
import type { RawRef } from "./pool-review-proof-raw.js";
import { logicalSha, ticketProblem } from "./pool-review-proof-ticket.js";

export interface PinnedKey { publicKey: string; pinnedAt: string }
/** What the lend-write entry got besides the parsed request: the received text and the peer's pinned key, both optional. */
export interface ReceivedResult { raw?: string; pinned?: PinnedKey | null }

/** The bridge's pin for this peer (read-only), dropped when it predates the current peer record (a same-name peer added again). */
export async function readPinnedKey(peer: string): Promise<PinnedKey | null> {
  const rec = ((await readPeers()).httpPeers ?? []).find((p) => p.name === peer && !p.disabled);
  const pin = rec ? currentPin((await readPeerPins())[peer], rec) : undefined;
  return pin?.publicKey && pin.pinnedAt ? { publicKey: pin.publicKey, pinnedAt: pin.pinnedAt } : null;
}

const parseObj = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
};

/** The claim of this order under this lease generation: the key must have been pinned by then (a later re-pin is another key). */
function claimTs(db: Database, o: Pick<LendOrder, "taskId" | "orderId" | "leaseGen">): number | null {
  const r = db.query(`SELECT ts FROM events WHERE target = ? AND kind = 'note' AND json_extract(data, '$.lend.orderId') = ?
    AND json_extract(data, '$.lend.op') = 'claim' AND json_extract(data, '$.lend.gen') = ? ORDER BY seq DESC LIMIT 1`)
    .get(o.taskId, o.orderId, o.leaseGen) as { ts: number } | null;
  return r?.ts ?? null;
}

function ticketRefusal(db: Database, o: LendOrder, req: ResultRequest, body: Record<string, unknown> | null, pinned: PinnedKey | null | undefined): string | null {
  const t = req.ticket!;
  if (!body) return "没有存下的原件，票据无从核对";
  if (!pinned?.publicKey) return "本机读不到这个 peer 钉住的钥匙";
  const claimed = claimTs(db, o), at = Date.parse(pinned.pinnedAt);
  if (claimed === null || !Number.isFinite(at) || at > claimed) return "钉住的钥匙晚于这一单的领单（换过钥匙或没有领单记录）";
  return ticketProblem(t, { orderId: o.orderId, gen: o.leaseGen, taskId: o.taskId, head: o.head, specRev: o.specRev, round: o.round, family: o.family,
    worker: o.worker ?? "", session: req.session.id, payloadSha: logicalSha(body) }, pinned.publicKey);
}

export function admitPoolEvidence(db: Database, o: LendOrder, req: ResultRequest, bodySha: string, received: ReceivedResult,
  saveRaw?: (text: string) => RawRef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let body: Record<string, unknown> | null = null;
  if (received.raw === undefined || !saveRaw) out.rawRefusal = "入口没交原件";
  else if (createHash("sha256").update(received.raw, "utf8").digest("hex") !== bodySha) out.rawRefusal = "收到的文本与入账摘要不一致";
  else {
    try {
      out.raw = saveRaw(received.raw);
      body = parseObj(received.raw);
    } catch (e) {
      out.rawRefusal = `原件没存下：${(e as Error).message}`.slice(0, 200);
    }
  }
  if (!req.ticket) return out;
  const why = ticketRefusal(db, o, req, body, received.pinned);
  return { ...out, ...(why ? { ticketRefusal: why } : { ticket: req.ticket }) };
}
