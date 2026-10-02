/** Supplements require a remote receipt and the same E2E boundary as lend offers. */
import type { HttpPeer } from "../lib/peers.js";
import type { RelaySend } from "../lib/ledger-lend-relay.js";
import { peerLendProblem } from "../lib/lend-remote.js";
import { peerTextRefusal } from "../lib/order-wire-render.js";
import { signedFor } from "../lib/instance-key.js";
import { readJsonCapped } from "../lib/body-reader.js";
import { isE2eResponse } from "../lib/peer-e2e-client.js";
import { peerFetch } from "./relay-link.js";

type SendDeps = { fetch: typeof peerFetch; authenticated: typeof isE2eResponse };
const defaults: SendDeps = { fetch: peerFetch, authenticated: isE2eResponse };
export async function sendLendRelay(peer: HttpPeer, agent: string, text: string, d: SendDeps = defaults): Promise<RelaySend & { remoteAccepted?: true }> {
  const problem = peerLendProblem(peer, peer.name) ?? peerTextRefusal(text);
  if (problem) return { ok: false, error: problem };
  const url = `${peer.baseUrl!.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(agent)}/messages`;
  const body = JSON.stringify({ text, wait: 0, nonce: crypto.randomUUID() });
  try {
    const res = await d.fetch(url, {
      method: "POST", headers: { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) },
      body, signal: AbortSignal.timeout(15_000),
    }, { timeoutMs: 15_000, e2eOnly: true });
    const reply = await readJsonCapped(res) as { ok?: boolean } | null;
    if (!d.authenticated(res)) return { ok: false, error: "没有认证的远端回执", maybeSent: true };
    if (res.ok && reply?.ok === true) return { ok: true, remoteAccepted: true };
    const rejected = [401, 403, 404, 409, 429, 503].includes(res.status) && reply?.ok === false;
    return { ok: false, error: `远端回执 ${res.status}`, maybeSent: !rejected };
  } catch (e) {
    // A transport failure may follow delivery; never retry without a definite refusal.
    return { ok: false, error: (e as Error).message, maybeSent: true };
  }
}
