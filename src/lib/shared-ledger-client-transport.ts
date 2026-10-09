import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { canonicalJson } from "./ask-bind.js";
import { signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS } from "./shared-ledger-auth.js";
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";

export class SharedLedgerRemoteError extends Error {
  constructor(readonly status: number, readonly response: unknown, readonly retryAfterMs = 5_000) { super(`shared ledger rejected (${status})`); }
}
export class SharedLedgerRollback extends Error {
  constructor(readonly serverSeq: number) { super("shared ledger sequence rollback; cache rebuilt"); }
}
export class SharedLedgerUnavailable extends Error {
  constructor() { super("shared ledger unavailable; outcome unconfirmed"); }
}
export interface SharedLedgerTransportOptions {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number; stateDir?: string;
}
/** Only the center origin's hash is stored: different credentials/processes share its IP limit without retaining URLs. */
function cooldownPath(baseUrl: string, dir: string): string {
  const origin = sharedLedgerCenterUrl(baseUrl).origin;
  return join(dir, "shared-ledger-cooldowns", `${createHash("sha256").update(origin).digest("hex")}.json`);
}
/** An unreadable/invalid cooldown is no cooldown: the next 429 atomically overwrites it, so no one has to delete it by hand. */
const warnedCorrupt = new Set<string>();
export function sharedLedgerNotBefore(baseUrl: string, dir = STATE_DIR): number {
  const path = cooldownPath(baseUrl, dir);
  const state = readJsonStateSync(path, (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  if (state.status !== "corrupt") return warnedCorrupt.delete(path), state.status === "missing" ? 0 : state.data as number;
  // Once per broken spell (every push re-reads it); fixed text, never the file's content or path.
  if (!warnedCorrupt.has(path)) { warnedCorrupt.add(path); console.warn("shared ledger cooldown file unreadable; treated as no cooldown"); }
  return 0;
}
/** Retry-After accepts seconds or HTTP-date; malformed/missing values use five seconds, never more than a minute. */
function retryDelay(raw: string | null, now: number): number {
  if (!raw?.trim()) return 5_000;
  const seconds = Number(raw), date = Date.parse(raw);
  const ms = Number.isFinite(seconds) ? (seconds >= 0 ? seconds * 1000 : 5_000) : Number.isFinite(date) ? Math.max(0, date - now) : 5_000;
  return Math.min(60_000, ms);
}
export async function deferSharedLedger(baseUrl: string, until: number, dir = STATE_DIR): Promise<void> {
  const path = cooldownPath(baseUrl, dir);
  mkdirSync(join(dir, "shared-ledger-cooldowns"), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(`${path}.lock`);
  if (!lock) throw new SharedLedgerUnavailable();
  try { writeJsonAtomicSync(path, Math.max(sharedLedgerNotBefore(baseUrl, dir), Math.ceil(until)), { mode: 0o600, commitIf: lock.held }); }
  finally { lock.release(); }
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
    // Uploads and import receipt/recovery share the push gate. Web reads have their own list/detail backoff.
    const pushRequest = /^\/v1\/teams\/[^/]+\/(?:projections|source-dags|imports(?:\/[^/]+)?)$/.test(path);
    const blocked = pushRequest ? sharedLedgerNotBefore(baseUrl, options.stateDir) - now() : 0;
    if (blocked > 0) throw new SharedLedgerRemoteError(429, null, blocked);
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
    if (response.status === 429) {
      const delay = retryDelay(response.headers.get("retry-after"), now());
      // A cooldown that cannot be recorded (lock held, write failed) must not turn the center's 429 into Unavailable.
      if (pushRequest) await deferSharedLedger(baseUrl, now() + delay, options.stateDir).catch(() => console.warn("shared ledger cooldown not recorded"));
      // nginx may return HTML; retain only its safe timing header, not a rejection body or source-DAG outcome.
      throw new SharedLedgerRemoteError(429, null, delay);
    }
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
