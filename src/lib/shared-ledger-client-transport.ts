import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import { acquireLock } from "./file-lock.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { STATE_DIR } from "./paths.js";
import { canonicalJson } from "./ask-bind.js";
import { signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS } from "./shared-ledger-auth.js";
import { ledgerPurposeHeaders, ledgerSendFamilyFor } from "./floka-ledger/config.js";
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";

export class SharedLedgerRemoteError extends Error {
  constructor(readonly status: number, readonly response: unknown, readonly retryAfterMs = 5_000, readonly retryAfter: string | null = null) { super(`shared ledger rejected (${status})`); }
}
export class SharedLedgerRollback extends Error {
  constructor(readonly serverSeq: number) { super("shared ledger sequence rollback; cache rebuilt"); }
}
export class SharedLedgerUnavailable extends Error {
  constructor() { super("shared ledger unavailable; outcome unconfirmed"); }
}
export interface SharedLedgerTransportOptions {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number; stateDir?: string; random?: () => number;
}
/** Only the center origin's hash is stored: different credentials/processes share its IP limit without retaining URLs. */
function cooldownPath(baseUrl: string, dir: string): string {
  const origin = sharedLedgerCenterUrl(baseUrl).origin;
  return join(dir, "shared-ledger-cooldowns", `${createHash("sha256").update(origin).digest("hex")}.json`);
}
/** One explicit Retry-After (or a deadline already on disk) stops every V1/V2 request to the center; never longer than this. */
const MAX_COOLDOWN_MS = 600_000;
/** An unreadable/invalid cooldown is no cooldown: the next 429 atomically overwrites it, so no one has to delete it by hand. */
const warnedCorrupt = new Set<string>();
/** A deadline written before the cap (or by a huge header) reads as at most now + 10 minutes, and at most 10 minutes after the
 * file was written so that it still expires; the file itself is left alone. */
function cappedDeadline(path: string, deadline: number, now: number): number {
  let written = Infinity;
  try { written = Math.ceil(statSync(path).mtimeMs); } catch { /* raced with a rewrite: the now-based cap still applies */ }
  return Math.min(deadline, now + MAX_COOLDOWN_MS, written + MAX_COOLDOWN_MS);
}
export function sharedLedgerNotBefore(baseUrl: string, dir = STATE_DIR, now = Date.now()): number {
  const path = cooldownPath(baseUrl, dir);
  const state = readJsonStateSync(path, (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
  if (state.status !== "corrupt") return warnedCorrupt.delete(path), state.status === "missing" ? 0 : cappedDeadline(path, state.data as number, now);
  // Once per broken spell (every push re-reads it); fixed text, never the file's content or path.
  if (!warnedCorrupt.has(path)) { warnedCorrupt.add(path); console.warn("shared ledger cooldown file unreadable; treated as no cooldown"); }
  return 0;
}
/** Missing Retry-After uses a cross-process exponential streak; explicit seconds/date honor the center's deadline up to ten minutes. */
function retryDelay(raw: string | null, now: number, failures: number, random = Math.random): number {
  if (raw?.trim()) {
    const seconds = Number(raw), date = Date.parse(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_COOLDOWN_MS, seconds * 1000);
    if (!Number.isFinite(seconds) && Number.isFinite(date)) return Math.min(MAX_COOLDOWN_MS, Math.max(0, date - now));
  }
  return Math.min(120_000, 5_000 * 2 ** Math.min(5, Math.max(0, failures - 1)) * (1 + random() * 0.2));
}
interface LimitStreak { failures: number; at: number; retryAfter?: string | null }
function limitStreak(path: string): LimitStreak {
  const state = readJsonStateSync(`${path}.streak`, (v) => !!v && typeof v === "object"
    && Number.isSafeInteger((v as LimitStreak).failures) && (v as LimitStreak).failures >= 0 && Number.isFinite((v as LimitStreak).at));
  return state.status === "ok" ? state.data as LimitStreak : { failures: 0, at: 0 };
}
/** Whole seconds left until a deadline (min 1), the form a replayed Retry-After takes instead of the center's original value. */
const remainingSeconds = (ms: number) => String(Math.max(1, Math.ceil(ms / 1000)));
/** During a locally enforced cooldown, replay the center's optional timing header as the time left (following any extended
 * deadline), without inventing one when the center gave none. */
export function sharedLedgerRetryAfter(baseUrl: string, dir = STATE_DIR, now = Date.now()): string | null {
  const raw = limitStreak(cooldownPath(baseUrl, dir)).retryAfter;
  return typeof raw === "string" ? remainingSeconds(sharedLedgerNotBefore(baseUrl, dir, now) - now) : null;
}
export async function sharedLedgerRateLimited(baseUrl: string, raw: string | null, now: number, dir = STATE_DIR, random = Math.random): Promise<number> {
  const path = cooldownPath(baseUrl, dir);
  let delay = retryDelay(raw, now, 1, random);
  try {
    mkdirSync(join(dir, "shared-ledger-cooldowns"), { recursive: true, mode: 0o700 });
    const lock = await acquireLock(`${path}.lock`);
    if (!lock) throw new SharedLedgerUnavailable();
    try {
      const failures = limitStreak(path).failures + 1;
      delay = retryDelay(raw, now, failures, random);
      writeJsonAtomicSync(`${path}.streak`, { failures, at: now, retryAfter: raw }, { mode: 0o600, commitIf: lock.held });
      writeJsonAtomicSync(path, Math.max(sharedLedgerNotBefore(baseUrl, dir, now), Math.ceil(now + delay)), { mode: 0o600, commitIf: lock.held });
    } finally { lock.release(); }
  } catch { console.warn("shared ledger cooldown not recorded"); } // Still report 429 even when its shared state cannot be written.
  return delay;
}
export async function sharedLedgerSucceeded(baseUrl: string, startedAt: number, dir = STATE_DIR): Promise<void> {
  const path = cooldownPath(baseUrl, dir);
  if (!limitStreak(path).failures) return;
  try {
    const lock = await acquireLock(`${path}.lock`);
    if (!lock) return;
    try {
      // A success from an older in-flight request must not erase a newer rejection's streak or deadline.
      if (limitStreak(path).at <= startedAt) writeJsonAtomicSync(`${path}.streak`, { failures: 0, at: startedAt }, { mode: 0o600, commitIf: lock.held });
    } finally { lock.release(); }
  } catch { console.warn("shared ledger cooldown streak not reset"); } // A successful response remains usable; only the next fallback delay stays conservative.
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
    const startedAt = now();
    const blocked = sharedLedgerNotBefore(baseUrl, options.stateDir, startedAt) - startedAt;
    if (blocked > 0) throw new SharedLedgerRemoteError(429, null, blocked, sharedLedgerRetryAfter(baseUrl, options.stateDir, startedAt));
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.pathname !== path || url.search || url.hash) throw new SharedLedgerUnavailable();
    const attemptNonce = randomBytes(24).toString("hex");
    const body = encodeBody ? encodeBody(attemptNonce) : payload === undefined ? "" : canonicalJson({ attemptNonce, payload });
    const signed = signSharedLedgerRequest({ method, path, body, bearer, instanceId,
      ts: String(Math.floor(now() / 1000)), attemptNonce }, signingKey, ledgerSendFamilyFor("shared-ledger", base.origin)); // LEDGER1: off / no capability = old family
    const h = SHARED_LEDGER_AUTH_HEADERS;
    let response: Response;
    try {
      response = await fetcher(url, { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", [h.key]: signed.publicKey,
          [h.ts]: signed.ts, [h.sig]: signed.signature, [h.instance]: instanceId, [h.nonce]: attemptNonce, ...ledgerPurposeHeaders(signed) },
        ...(method === "GET" ? {} : { body }) });
    } catch { throw new SharedLedgerUnavailable(); } // Fetch implementations may throw errors carrying response bodies or credentials.
    if (response.status === 429) {
      const raw = response.headers.get("retry-after");
      const delay = await sharedLedgerRateLimited(baseUrl, raw, now(), options.stateDir, options.random);
      // nginx may return HTML; retain only its timing header, as capped whole seconds, not a rejection body or source-DAG outcome.
      throw new SharedLedgerRemoteError(429, null, delay, raw === null ? null : remainingSeconds(delay));
    }
    if (response.status >= 500) throw new SharedLedgerUnavailable();
    if (!response.ok) throw new SharedLedgerRemoteError(response.status, await rejection(response.status, response));
    try {
      const raw = await response.json();
      await sharedLedgerSucceeded(baseUrl, startedAt, options.stateDir);
      return success ? success(response.status, raw) : raw;
    }
    catch { throw new SharedLedgerUnavailable(); } // Body decoders can throw RemoteError too; only actual rejection handling may retain one.
  } catch (error) {
    if (error instanceof SharedLedgerRemoteError) throw error;
    // Transport/invalid responses cannot confirm a commit; discard potentially sensitive error text and causes.
    throw new SharedLedgerUnavailable();
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
