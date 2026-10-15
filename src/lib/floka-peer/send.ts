/** Both CLI transports and the bridge use one signer; encrypted envelopes keep their selected family. */
import { instanceKeySync, type InstanceKey } from "../instance-key.js";
import { signRequestFamily, verifyRequestFamilies } from "../floka-compat/signature/request.js";
import { REQUEST_HEADERS } from "../floka-compat/signature/families.js";
import { peerForUrl, readHttpPeers } from "../peer-e2e-local.js";
import type { HttpPeer } from "../peers.js";
import { peerCapabilities, pinOf, type PeerCapabilities } from "./capability.js";
import { peerPolicy } from "./policy.js";
export { recoverPeerSend } from "./recovery.js";

interface SendDeps { key?: InstanceKey | null; peers?: HttpPeer[]; config?: unknown; now?: number; capabilities?: PeerCapabilities; path?: string }
export async function preparePeerSend<T extends { method?: string; body?: string | Uint8Array; headers?: Record<string, string> }>(url: string, init: T): Promise<T> {
  if (peerPolicy().send !== "on") return init;
  const rec = peerForUrl(url, await readHttpPeers());
  if (peerCapabilities.family(rec ? pinOf(rec) : null) !== "floka") return init;
  return { ...init, headers: await signPeerTransport(url, init.method ?? "GET", init.body ?? "", init.headers) };
}

export async function signPeerTransport(
  url: string, method: string, body: string | Uint8Array, headers: Record<string, string> = {}, d: SendDeps = {},
): Promise<Record<string, string>> {
  const key = d.key === undefined ? instanceKeySync() : d.key, now = d.now ?? Date.now();
  const u = new URL(url), req = { method, path: d.path ?? u.pathname + u.search, body };
  const policy = peerPolicy(d.config), encrypted = /\/api\/v1\/(e2e\/|peers\/redeem$)/.test(u.pathname);
  const original = verifyRequestFamilies(headers, req, "on", now);
  if (original.status === "reject" || (original.status === "ok" && original.publicKey !== key?.publicKey)) {
    throw new Error("Invalid outgoing signature family; refusing to replace it with another signature");
  }
  const rec = peerForUrl(url, d.peers ?? await readHttpPeers());
  let family = (d.capabilities ?? peerCapabilities).family(rec ? pinOf(rec) : null, d.config, false, now);
  if (encrypted) {
    family = original.status === "ok" && original.publicKey === key?.publicKey ? original.family : "claudestra";
    if (family === "floka" && (policy.signature !== "on" || policy.send !== "on" || policy.e2e.send !== "on" || policy.e2e.receive !== "on")) {
      throw new Error("E2E family disabled before transport; refusing to relabel ciphertext");
    }
  }
  const names = new Set([...Object.values(REQUEST_HEADERS.claudestra), ...Object.values(REQUEST_HEADERS.floka)]);
  const clean = Object.fromEntries(Object.entries(headers).filter(([k]) => !names.has(k.toLowerCase())));
  return { ...clean, ...signRequestFamily(family, req, key, now) };
}
