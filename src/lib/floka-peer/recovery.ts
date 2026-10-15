/** A rejection retires only the sending pin's hint. It never authorizes a retry or a plaintext send. */
import { readJsonCapped } from "../body-reader.js";
import { peerForUrl, readHttpPeers } from "../peer-e2e-local.js";
import type { E2ePin } from "../floka-compat/e2e/capability.js";
import { peerCapabilities, pinOf, type PeerCapabilities } from "./capability.js";
import { REQUEST_HEADERS } from "../floka-compat/signature/families.js";

const signatureReasons = new Set(["bad", "stale", "unsigned", "invalid signature family"]);
const newSend = (headers: Record<string, string> = {}) => {
  const h = new Headers(headers);
  return h.has(REQUEST_HEADERS.floka.sig) && !h.has(REQUEST_HEADERS.claudestra.sig);
};

/** Tee cancellation must not wait for the caller to consume its untouched response branch. */
async function rejectionCode(response: Response): Promise<string | null> {
  if (response.status !== 401) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const diagnostic = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const r = await reader.read();
      if (r.done) controller.close(); else controller.enqueue(r.value);
    },
    cancel() { void reader.cancel().catch(() => {}); /* The diagnostic branch is already abandoned; caller owns the other branch. */ },
  });
  const j = await readJsonCapped(new Response(diagnostic), 8192, { idleMs: 1000, totalMs: 1000 }) as { code?: string; reason?: string } | null;
  if (j?.code === "e2e_session" || j?.code === "e2e_signature" || j?.code === "bad_signature") return j.code;
  return j?.code === "peer_signature" && signatureReasons.has(j.reason ?? "") ? j.code : null;
}

interface RecoveryDeps { pin: E2ePin | null; cache?: PeerCapabilities; rejected?: (code: string) => void }
/** Captures the pin before sending. A concurrent peer-record change cannot invalidate a different identity. */
export async function recoverPeerSend<T extends { status: number; body: ReadableStream<Uint8Array> | null }>(
  url: string, headers: Record<string, string> | undefined, send: () => Promise<T>, deps?: RecoveryDeps,
): Promise<T> {
  if (!newSend(headers)) return send();
  const rec = deps ? null : peerForUrl(url, await readHttpPeers());
  const pin = deps ? deps.pin : rec ? pinOf(rec) : null, cache = deps?.cache ?? peerCapabilities;
  const reject = (code: string) => { if (pin) cache.forget(pin); deps?.rejected?.(code); };
  let response: T;
  try { response = await send(); }
  catch (error) {
    if ((error as { code?: string })?.code === "bad_signature") reject("bad_signature");
    throw error;
  }
  if (response.status !== 401) return response;
  let probe: Response;
  if (response instanceof Response) probe = new Response(response.clone().body, { status: response.status });
  else {
    const branches = response.body?.tee();
    response.body = branches?.[0] ?? null;
    probe = new Response(branches?.[1] ?? null, { status: response.status });
  }
  const code = await rejectionCode(probe);
  if (code) reject(code);
  return response;
}
