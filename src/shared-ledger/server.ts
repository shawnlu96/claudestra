import { SHARED_LEDGER_MAX_BODY_BYTES, SharedLedgerError } from "../lib/shared-ledger-contract.js";
import { SHARED_LEDGER_AUTH_HEADERS as H } from "../lib/shared-ledger-auth.js";
import { LedgerService } from "./service.js";

interface Limits { readTimeoutMs: number; requestsPerMinute: number; maxBodyBytes: number }
const defaults: Limits = { readTimeoutMs: 5000, requestsPerMinute: 120, maxBodyBytes: SHARED_LEDGER_MAX_BODY_BYTES };

export async function readBody(request: Request, limit: number, timeout: number): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit) throw new SharedLedgerError("payload_too_large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SharedLedgerError("expired", "Request body read timed out")), timeout);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new SharedLedgerError("payload_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => { /* A disconnected or rejected input stream has no business side effects to recover. */ });
  }
}

export function createHandler(service: LedgerService, overrides: Partial<Limits> = {}, clock = Date.now) {
  const limits = { ...defaults, ...overrides };
  const buckets = new Map<string, { at: number; count: number }>();
  return async (req: Request, remote = "loopback"): Promise<Response> => {
    const now = clock();
    for (const [key, value] of buckets) if (now - value.at >= 60_000) buckets.delete(key);
    if (!buckets.has(remote) && buckets.size >= 4096) return Response.json({ message: "Rate limit exceeded" }, { status: 429 });
    const bucket = buckets.get(remote) ?? { at: now, count: 0 };
    bucket.count++;
    buckets.set(remote, bucket);
    if (bucket.count > limits.requestsPerMinute) {
      return Response.json({ message: "Rate limit exceeded" }, { status: 429, headers: { "Retry-After": "60" } });
    }
    try {
      const body = await readBody(req, limits.maxBodyBytes, limits.readTimeoutMs);
      const url = new URL(req.url);
      const result = service.handle({ method: req.method, path: url.pathname + url.search, body,
        bearer: /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "",
        publicKey: req.headers.get(H.key) ?? "", instanceId: req.headers.get(H.instance) ?? "",
        ts: req.headers.get(H.ts) ?? "", signature: req.headers.get(H.sig) ?? "", attemptNonce: req.headers.get(H.nonce) ?? "" }, now);
      return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof SharedLedgerError) return Response.json({ code: e.code, status: e.status, message: e.message }, { status: e.status });
      // Network read errors carry arbitrary input; disclose neither their text nor partial body.
      return Response.json({ message: "Request body unavailable" }, { status: 400 });
    }
  };
}
export function startServer(service: LedgerService, options: { hostname?: string; port?: number } = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(hostname)) throw new Error("Shared ledger development server requires loopback");
  const handler = createHandler(service);
  return Bun.serve({ hostname, port: options.port ?? 0, maxRequestBodySize: SHARED_LEDGER_MAX_BODY_BYTES,
    fetch(req, server) { return handler(req, server.requestIP(req)?.address ?? "loopback"); } });
}
