/** S2T wire: one signed attempt against a frozen S2K `V2_ROUTES` entry, with V1 SharedLedgerClient signing and credentials.
 * Signing reuses `signSharedLedgerRequest` / `SHARED_LEDGER_AUTH_HEADERS` / `sharedLedgerCenterUrl` unchanged; the V1
 * `requestSharedLedger` itself cannot carry the receipts query string, so this module performs the same single attempt.
 * Errors: network reject / timeout / 5xx / 429 → unavailable; any other non-2xx keeps the center's code (4xx 原样);
 * a 2xx body that is not JSON or fails the S2K parser → invalid_field. No retry, no cache, no authorization memory.
 */
import { randomBytes } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS } from "./shared-ledger-auth.js";
import { sharedLedgerCenterUrl } from "./shared-ledger-client-transport.js";
import type { SharedLedgerConnection } from "./shared-ledger-client.js";
import type { InstanceKey } from "./instance-key.js";
import { fail, parseError, V2_ERROR_STATUS, V2ContractError, type V2ErrorCode } from "./shared-ledger-contract-v2.js";
import { V2_ROUTES, type V2RouteName } from "./shared-ledger-contract-v2-routes.js";

export interface Stage2Connection {
  /** V1 credential/connection (bearer + instance key sign every request); teamId is the only team this transport reaches. */
  connection: SharedLedgerConnection;
  key: InstanceKey;
  /** Center project id this transport is scoped to; params can never override it. */
  projectId: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}
type Params<N extends V2RouteName> = Parameters<(typeof V2_ROUTES)[N]["path"]>[0];
export type Stage2RouteParams<N extends V2RouteName> = Omit<Params<N>, "teamId" | "projectId">;
export type Stage2RouteResult<N extends V2RouteName> = ReturnType<(typeof V2_ROUTES)[N]["parseResponse"]>;
export type Stage2RouteBody<N extends V2RouteName> = ReturnType<(typeof V2_ROUTES)[N]["parseRequest"]>;

/** Fallback when an error body is missing or does not name a code of that HTTP status. */
const STATUS_CODE: Record<number, V2ErrorCode> = {
  400: "invalid_field", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large",
};
async function rejection(response: Response): Promise<never> {
  let text: string;
  try { text = await response.text(); } catch { return fail("unavailable"); } // read aborted / timed out: rejection unconfirmed
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* missing or non-JSON error body: status alone decides */ }
  let code: V2ErrorCode | null = null;
  try { code = parseError(body).code; } catch { /* malformed error body */ }
  return fail(code !== null && V2_ERROR_STATUS[code] === response.status ? code : STATUS_CODE[response.status] ?? "invalid_field");
}

/** One signed attempt; returns the raw JSON success body. Throws only V2ContractError. */
async function signedAttempt(conn: Stage2Connection, method: "GET" | "POST", path: string, body: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conn.timeoutMs ?? 5000);
  try {
    const { baseUrl, bearer, instanceId } = conn.connection, now = conn.now ?? Date.now;
    let url: URL;
    try {
      const base = sharedLedgerCenterUrl(baseUrl);
      url = new URL(path, base);
      if (url.origin !== base.origin || url.pathname + url.search !== path || url.hash) return fail("unavailable");
    } catch (e) { if (e instanceof V2ContractError) throw e; return fail("unavailable"); } // never echo a URL with secrets
    const attemptNonce = randomBytes(24).toString("hex");
    const signed = signSharedLedgerRequest({ method, path, body, bearer, instanceId, ts: String(Math.floor(now() / 1000)), attemptNonce },
      { ...conn.key });
    const h = SHARED_LEDGER_AUTH_HEADERS;
    let response: Response;
    try {
      response = await (conn.fetch ?? fetch)(url, { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", [h.key]: signed.publicKey,
          [h.ts]: signed.ts, [h.sig]: signed.signature, [h.instance]: instanceId, [h.nonce]: attemptNonce },
        ...(method === "GET" ? {} : { body }) });
    } catch { return fail("unavailable"); } // fetch errors may carry bodies or credentials; keep none of it
    if (response.status === 429 || response.status >= 500) return fail("unavailable");
    if (!response.ok) return await rejection(response);
    let text: string;
    try { text = await response.text(); } catch { return fail("unavailable"); } // body lost mid-read: outcome unconfirmed
    try { return JSON.parse(text); } catch { return fail("invalid_field"); }
  } catch (e) {
    if (e instanceof V2ContractError) throw e;
    return fail("unavailable");
  } finally { clearTimeout(timer); }
}

/** Validates params + request with the S2K route before any network I/O; the response must pass the same route's parser. */
export async function callStage2Route<N extends V2RouteName>(conn: Stage2Connection, name: N, params: Stage2RouteParams<N>,
  body?: unknown): Promise<Stage2RouteResult<N>> {
  const route = V2_ROUTES[name] as unknown as {
    method: "GET" | "POST"; parseParams(v: unknown): Record<string, unknown>; path(p: unknown): string;
    parseRequest(v: unknown, p: unknown): unknown; parseResponse(v: unknown, p: unknown): unknown;
  };
  const scope = { teamId: conn.connection.teamId, projectId: conn.projectId };
  for (const k of ["teamId", "projectId"] as const) {
    if (k in (params as object) && (params as Record<string, unknown>)[k] !== scope[k]) fail("forbidden");
  }
  const p = route.parseParams({ ...params, ...scope });
  if (body !== null && typeof body === "object" && ("actor" in body || "role" in body)) fail("invalid_field");
  const request = route.parseRequest(body, p);
  const raw = await signedAttempt(conn, route.method, route.path(p), request === undefined ? "" : canonicalJson(request));
  try { return route.parseResponse(raw, p) as Stage2RouteResult<N>; }
  catch { return fail("invalid_field"); } // any S2K parse failure of a 2xx body (incl. oversize) is the center's fault, never 413
}
