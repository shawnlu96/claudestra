import { randomBytes } from "node:crypto";
import { canonicalJson } from "./ask-bind.js";
import { signSharedLedgerRequest, SHARED_LEDGER_AUTH_HEADERS, sharedLedgerCommandDigest } from "./shared-ledger-auth.js";
import type { InstanceKey } from "./instance-key.js";
import type { SharedLedgerCommand, SharedLedgerImport, SharedLedgerProjection } from "./shared-ledger-contract.js";
import { parseSharedLedgerCommand } from "./shared-ledger-contract-validation.js";
import { parseSharedLedgerImport, parseSharedLedgerProjection } from "./shared-ledger-contract-transfer.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";
import { scrubSharedLedger, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { SharedLedgerCache, type SharedLedgerCacheIdentity } from "./shared-ledger-cache.js";

export interface SharedLedgerConnection {
  centerId: string; baseUrl: string; teamId: string; personId: string; instanceId: string; bearer: string;
}
export class SharedLedgerRemoteError extends Error {
  constructor(readonly status: number, readonly response: unknown) { super(`shared ledger rejected (${status})`); }
}
export class SharedLedgerUnavailable extends Error {
  constructor() { super("shared ledger unavailable; outcome unconfirmed"); }
}
interface ClientOptions { fetch?: typeof fetch; now?: () => number; timeoutMs?: number; attempts?: number; scrub?: SharedLedgerScrubContext }
/** No implicit local writes or queued commands. Callers retain drafts when the center is unavailable. */
export class SharedLedgerClient {
  private fetcher: typeof fetch;
  private now: () => number;
  constructor(readonly connection: SharedLedgerConnection, private key: InstanceKey, private options: ClientOptions = {}) {
    const url = new URL(connection.baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid center URL");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("center requires HTTPS");
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  private async request(method: string, resource: string, payload?: unknown, signal?: AbortSignal): Promise<unknown> {
    const c = this.connection;
    if (!/^[A-Za-z0-9_.:-]+$/.test(c.teamId)) throw new Error("invalid team");
    const path = `/v1/teams/${c.teamId}/${resource}`;
    const attemptNonce = randomBytes(24).toString("hex");
    const body = payload === undefined ? "" : canonicalJson({ attemptNonce, payload });
    const signed = signSharedLedgerRequest({ method, path, body, bearer: c.bearer, instanceId: c.instanceId,
      ts: String(Math.floor(this.now() / 1000)), attemptNonce }, this.key);
    const h = SHARED_LEDGER_AUTH_HEADERS;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new SharedLedgerUnavailable();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      const response = await this.fetcher(new URL(path, c.baseUrl), { method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${c.bearer}`, "content-type": "application/json", [h.key]: signed.publicKey,
          [h.ts]: signed.ts, [h.sig]: signed.signature, [h.instance]: c.instanceId, [h.nonce]: attemptNonce },
        ...(method === "GET" ? {} : { body }) });
      if (response.status >= 500) throw new SharedLedgerUnavailable();
      if (!response.ok) {
        let detail: unknown = { error: "shared ledger rejected" };
        try { detail = parseSharedLedgerResponse("error", await response.json()); }
        catch { /* Invalid rejection bodies must still remain non-retryable, especially CAS 409. */ }
        throw new SharedLedgerRemoteError(response.status, detail);
      }
      const data: unknown = await response.json();
      return data;
    } catch (error) {
      if (error instanceof SharedLedgerRemoteError) throw error;
      // Transport/invalid responses cannot confirm a commit; do not include potentially sensitive response text.
      throw new SharedLedgerUnavailable();
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  private scrub<T>(input: unknown, parser: (value: unknown) => T): T {
    const context = this.options.scrub ?? { identity: { username: "", hostname: "" } };
    return scrubSharedLedger(input, parser, { ...context, knownSecrets: [...(context.knownSecrets ?? []), this.connection.bearer] });
  }
  async features(signal?: AbortSignal) {
    const result = parseSharedLedgerResponse("features", await this.request("GET", "features", undefined, signal));
    if (result.teamId !== this.connection.teamId) throw new SharedLedgerUnavailable();
    return result;
  }
  async feature(id: string) {
    if (!/^[A-Za-z0-9_.:-]+$/.test(id)) throw new Error("invalid feature id");
    const result = parseSharedLedgerResponse("feature", await this.request("GET", `features/${id}`));
    if (result.teamId !== this.connection.teamId || result.feature.id !== id) throw new SharedLedgerUnavailable();
    return result;
  }
  async receipt(requestId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw new Error("invalid request id");
    const result = parseSharedLedgerResponse("receipt", await this.request("GET", `commands/${requestId}`));
    if ((result.status === "committed" ? result.receipt.requestId : result.requestId) !== requestId) throw new SharedLedgerUnavailable();
    return result;
  }
  async command(input: SharedLedgerCommand) {
    const command = this.scrub(input, parseSharedLedgerCommand);
    const digest = sharedLedgerCommandDigest({ attemptNonce: "00".repeat(16), payload: command });
    for (let attempt = 0; attempt < (this.options.attempts ?? 2); attempt++) {
      {
        const receipt = await this.receipt(command.requestId);
        if (receipt.status === "committed") {
          if (receipt.receipt.requestId !== command.requestId || receipt.receipt.commandDigest !== digest) throw new SharedLedgerUnavailable();
          return receipt.receipt;
        }
        if (receipt.requestId !== command.requestId) throw new SharedLedgerUnavailable();
      }
      try {
        const result = parseSharedLedgerResponse("command", await this.request("POST", "commands", command));
        if (result.requestId !== command.requestId || result.commandDigest !== digest) throw new SharedLedgerUnavailable();
        return result;
      } catch (error) { if (!(error instanceof SharedLedgerUnavailable)) throw error; }
    }
    throw new SharedLedgerUnavailable();
  }
  async import(input: SharedLedgerImport) {
    const payload = this.scrub(input, parseSharedLedgerImport);
    for (let attempt = 0; attempt < (this.options.attempts ?? 2); attempt++) {
      try {
        const result = parseSharedLedgerResponse("import", await this.request("POST", "imports", payload));
        if (result.batchId !== payload.batchId || result.manifestDigest !== payload.manifestDigest || result.mode !== payload.mode) {
          throw new SharedLedgerUnavailable();
        }
        return result;
      } catch (error) { if (!(error instanceof SharedLedgerUnavailable)) throw error; }
    }
    throw new SharedLedgerUnavailable();
  }
  async projection(input: SharedLedgerProjection) {
    const payload = this.scrub(input, parseSharedLedgerProjection);
    const result = parseSharedLedgerResponse("projection", await this.request("POST", "projections", payload));
    if (result.sourceInstanceId !== payload.sourceInstanceId || result.sourceSeq !== payload.sourceSeq) throw new SharedLedgerUnavailable();
    return result;
  }
  poll(cache: SharedLedgerCache<Awaited<ReturnType<SharedLedgerClient["features"]>>>, identity: SharedLedgerCacheIdentity,
    onError: (error: unknown) => void): () => void {
    if (identity.centerId !== this.connection.centerId || identity.teamId !== this.connection.teamId
      || identity.personId !== this.connection.personId) throw new Error("cache identity mismatch");
    const ticket = cache.select(identity);
    let stopped = false;
    let running = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([ticket.signal, controller.signal]);
    const run = async () => {
      if (stopped || running || signal.aborted) return;
      running = true;
      try {
        const result = await this.features(signal);
        if (!stopped) cache.store(ticket, { ...result, features: result.features.filter((f) => f.projectId === identity.projectId) },
          result.serverSeq, this.now());
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof SharedLedgerRemoteError && [401, 403].includes(error.status)) cache.invalidate(ticket);
        onError(error);
      } finally { running = false; }
    };
    const timer = setInterval(run, 5000);
    timer.unref?.();
    void run();
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }
}
