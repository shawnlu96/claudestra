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
/** A rejection parser may retain only validated public conflict fields, never the raw response. */
export type SharedLedgerRejectionParser = (status: number, response: Response) => Promise<unknown>;
async function legacyRejection(_status: number, response: Response): Promise<unknown> {
  try { return parseSharedLedgerResponse("error", await response.json()); }
  catch { return { error: "shared ledger rejected" }; } // Invalid rejection bodies remain non-retryable, especially CAS 409.
}

/** One signed attempt; callers decide whether a lost outcome may be retried. */
export async function requestSharedLedger(connection: SharedLedgerConnection, key: InstanceKey, options: SharedLedgerTransportOptions,
  method: string, path: string, payload?: unknown, signal?: AbortSignal, rejection: SharedLedgerRejectionParser = legacyRejection, encodeBody?: (nonce: string) => string): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) throw new SharedLedgerUnavailable();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 5000);
  try {
    const attemptNonce = randomBytes(24).toString("hex");
    const body = encodeBody ? encodeBody(attemptNonce) : payload === undefined ? "" : canonicalJson({ attemptNonce, payload });
    const signed = signSharedLedgerRequest({ method, path, body, bearer: connection.bearer, instanceId: connection.instanceId,
      ts: String(Math.floor((options.now ?? Date.now)() / 1000)), attemptNonce }, key);
    const h = SHARED_LEDGER_AUTH_HEADERS;
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(new URL(path, connection.baseUrl), { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${connection.bearer}`, "content-type": "application/json", [h.key]: signed.publicKey,
          [h.ts]: signed.ts, [h.sig]: signed.signature, [h.instance]: connection.instanceId, [h.nonce]: attemptNonce },
        ...(method === "GET" ? {} : { body }) });
    } catch { throw new SharedLedgerUnavailable(); } // Fetch implementations may throw errors carrying response bodies or credentials.
    if (response.status >= 500) throw new SharedLedgerUnavailable();
    if (!response.ok) throw new SharedLedgerRemoteError(response.status, await rejection(response.status, response));
    return await response.json();
  } catch (error) {
    if (error instanceof SharedLedgerRemoteError) throw error;
    // Transport/invalid responses cannot confirm a commit; discard potentially sensitive error text and causes.
    throw new SharedLedgerUnavailable();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
