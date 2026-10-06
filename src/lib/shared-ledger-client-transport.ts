import { randomBytes } from "node:crypto";
import { canonicalJson } from "./ask-bind.js";
import { signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS } from "./shared-ledger-auth.js";
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";

export class SharedLedgerRemoteError extends Error {
  constructor(readonly status: number, readonly response: unknown) { super(`shared ledger rejected (${status})`); }
}
export class SharedLedgerRollback extends Error {
  constructor(readonly serverSeq: number) { super("shared ledger sequence rollback; cache rebuilt"); }
}
export class SharedLedgerUnavailable extends Error {
  constructor() { super("shared ledger unavailable; outcome unconfirmed"); }
}
export interface SharedLedgerTransportOptions {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
}
/** Validate again at send time: the caller may have changed its connection since construction. */
export function sharedLedgerCenterUrl(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { throw new Error("invalid center URL"); } // Native URL errors can retain credentials in their input field.
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid center URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("center requires HTTPS");
  }
  return url;
}
/** A rejection parser may retain only validated public conflict fields, never the raw response. */
export type SharedLedgerRejectionParser = (status: number, response: Response) => Promise<unknown>;
type SharedLedgerSuccessParser = (status: number, body: unknown) => unknown;
async function legacyRejection(_status: number, response: Response): Promise<unknown> {
  try { return parseSharedLedgerResponse("error", await response.json()); }
  catch { return { error: "shared ledger rejected" }; } // Invalid rejection bodies remain non-retryable, especially CAS 409.
}

/** One signed attempt; callers decide whether a lost outcome may be retried. */
export async function requestSharedLedger(connection: SharedLedgerConnection, key: InstanceKey, options: SharedLedgerTransportOptions,
  method: string, path: string, payload?: unknown, signal?: AbortSignal, rejection: SharedLedgerRejectionParser = legacyRejection,
  encodeBody?: (nonce: string) => string, success?: SharedLedgerSuccessParser): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new SharedLedgerUnavailable();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 5000);
  try {
    const { baseUrl, bearer, instanceId } = connection;
    const { fetch: fetcher = fetch, now = Date.now } = options;
    const signingKey = { ...key };
    const base = sharedLedgerCenterUrl(baseUrl);
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.pathname !== path || url.search || url.hash) throw new SharedLedgerUnavailable();
    const attemptNonce = randomBytes(24).toString("hex");
    const body = encodeBody ? encodeBody(attemptNonce) : payload === undefined ? "" : canonicalJson({ attemptNonce, payload });
    const signed = signSharedLedgerRequest({ method, path, body, bearer, instanceId,
      ts: String(Math.floor(now() / 1000)), attemptNonce }, signingKey);
    const h = SHARED_LEDGER_AUTH_HEADERS;
    let response: Response;
    try {
      response = await fetcher(url, { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", [h.key]: signed.publicKey,
          [h.ts]: signed.ts, [h.sig]: signed.signature, [h.instance]: instanceId, [h.nonce]: attemptNonce },
        ...(method === "GET" ? {} : { body }) });
    } catch { throw new SharedLedgerUnavailable(); } // Fetch implementations may throw errors carrying response bodies or credentials.
    if (response.status >= 500) throw new SharedLedgerUnavailable();
    if (!response.ok) throw new SharedLedgerRemoteError(response.status, await rejection(response.status, response));
    try {
      const raw = await response.json();
      return success ? success(response.status, raw) : raw;
    }
    catch { throw new SharedLedgerUnavailable(); } // Body decoders can throw RemoteError too; only actual rejection handling may retain one.
  } catch (error) {
    if (error instanceof SharedLedgerRemoteError) throw error;
    // Transport/invalid responses cannot confirm a commit; discard potentially sensitive error text and causes.
    throw new SharedLedgerUnavailable();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
