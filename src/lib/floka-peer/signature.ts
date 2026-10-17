/** Header selection is for legacy pin/replay plumbing; acceptance always goes through SIGN1. */
import { REQUEST_HEADERS } from "../floka-compat/signature/families.js";
import { verifyRequestFamilies } from "../floka-compat/signature/request.js";
import type { SigCheck } from "../instance-signature.js";
import { observePeer, peerPolicy } from "./policy.js";
import { applySignatureContract, signatureFamily } from "./signature-contract.js";
import { peerSigVerdict } from "../peer-trust.js";

type HeaderInput = Headers | Readonly<Record<string, string | undefined>>;
const headerMap = (h: HeaderInput): Readonly<Record<string, string | undefined>> => h instanceof Headers ? Object.fromEntries(h) : h;
export function peerHeaders(input: HeaderInput) {
  const h = new Headers(Object.entries(headerMap(input)).filter((e): e is [string, string] => typeof e[1] === "string"));
  const old = REQUEST_HEADERS.claudestra, neu = REQUEST_HEADERS.floka;
  const names = Object.values(old).some(k => h.has(k)) ? old : neu;
  const key = h.get(names.key), ts = h.get(names.ts), sig = h.get(names.sig);
  const oldFamily = Object.values(old).some(k => h.has(k)), newFamily = Object.values(neu).some(k => h.has(k));
  return { key, ts, sig, oldFamily, newFamily, present: oldFamily || newFamily };
}

export function peerHeader(headers: HeaderInput, canonicalName: string): string {
  const names = REQUEST_HEADERS.claudestra;
  return peerHeaders(headers)[canonicalName === names.key ? "key" : canonicalName === names.ts ? "ts" : "sig"] ?? "";
}

/** Off/observe retain legacy exceptions until the original deadline; new-family failures never use them. */
export function rejectInvalidPeerSignature(headers: Pick<ReturnType<typeof peerHeaders>, "present" | "newFamily">, config?: unknown): boolean {
  if (!headers.present) return false;
  const mode = peerPolicy(config).signature;
  const reject = headers.newFamily || mode === "on";
  if (!reject && mode === "observe") observePeer("signature", "on would reject invalid legacy signature");
  const legacy = { allow: true as const, legacy: true };
  return !applySignatureContract({ family: signatureFamily(headers), result: "bad", signatureMode: mode, legacy },
    reject ? { allow: false, reason: "bad" } : legacy).allow;
}

export function peerSignatureVerdict(result: string, headers: ReturnType<typeof peerHeaders>, anchored: boolean, now: number, config?: unknown) {
  const legacy = peerSigVerdict(result, anchored, now);
  const baseline = result !== "ok" && rejectInvalidPeerSignature(headers, config) ? { allow: false as const, reason: result } : legacy;
  return applySignatureContract({ family: signatureFamily(headers), result, signatureMode: peerPolicy(config).signature, legacy }, baseline);
}

/** After SIGN1 succeeds, expose the key to the existing contact/token gate only. Never forward these aliases on the wire. */
export function peerTrustHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, [REQUEST_HEADERS.claudestra.key]: peerHeaders(headers).key ?? "" };
}

export function checkRequest(
  headers: HeaderInput, req: { method: string; path: string; body: string | Uint8Array }, config?: unknown, now = Date.now(), relay = false,
) {
  const policy = peerPolicy(config);
  const mode = relay && policy.relay !== "on" ? policy.relay === "observe" ? "observe" : "off" : policy.signature;
  const verdict = verifyRequestFamilies(headerMap(headers), req, policy.signature === "on" ? mode : policy.signature, now);
  if (verdict.status !== "unsigned" && verdict.observed) observePeer(relay ? "relay signature" : "signature", verdict.observed);
  return verdict;
}

export function verifyPeerRequest(
  key: string, headers: HeaderInput, req: { method: string; path: string; body: string | Uint8Array }, config?: unknown, now = Date.now(),
): SigCheck {
  const v = checkRequest(headers, req, config, now);
  return v.status === "ok" && v.publicKey === key ? "ok" : v.status === "reject" && v.reason === "stale" ? "stale" : "bad";
}

/** Legacy invitation-token exceptions survive off/observe only for the old family. */
export async function invalidSignedRequest(req: Request, peer: string): Promise<boolean> {
  if (!peer.startsWith("invite:") || !peerHeaders(req.headers).present) return false;
  try {
    const u = new URL(req.url), body = req.body ? new Uint8Array(await req.clone().arrayBuffer()) : new Uint8Array();
    return checkRequest(req.headers, { method: req.method, path: u.pathname + u.search, body }).status !== "ok" && rejectInvalidPeerSignature(peerHeaders(req.headers));
  } catch {
    return rejectInvalidPeerSignature(peerHeaders(req.headers)); // On and new-family failures never become anonymous.
  }
}

/** Old unsigned fixtures still rely on outerSigned; a present invalid family never becomes anonymous. */
export function e2eReceiveFamily(req: Request, body: Uint8Array, config?: unknown) {
  const u = new URL(req.url), policy = peerPolicy(config);
  const v = checkRequest(req.headers, { method: req.method, path: u.pathname + u.search, body }, config);
  if (v.status === "reject") return null;
  if (v.status === "ok" && v.family === "floka") {
    if (policy.e2e.receive === "observe") observePeer("e2e", "floka handshake would be accepted");
    return policy.e2e.receive === "on" ? "floka" as const : null;
  }
  return "claudestra" as const;
}
