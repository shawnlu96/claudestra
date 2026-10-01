import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, ApiError, DeviceInvalidError } from "@/lib/api/client";
import { fetchLedger } from "@/lib/api/ledger";
import { appConfigSync, setAppConfigForTest } from "@/lib/app-config";
import { assertLedgerOverview, isLedgerOverview, metaOf } from "@/lib/ledger-meta-guard";
import { homeView, type LedgerOverview } from "@/features/collab/collab-model";

const realFetch = globalThis.fetch;
const previousConfig = appConfigSync();
const valid = () => ({ ok: true, exists: true, now: 123, meta: metaOf(null), tasks: [], items: [], deps: [] });

beforeEach(() => setAppConfigForTest({ mode: "direct", fp: "ledger-test", machineName: "test", version: "" }));
afterEach(() => { globalThis.fetch = realFetch; setAppConfigForTest(previousConfig); });

function respond(response: Response): void {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

function interrupted(status = 200): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"tasks":['));
      setTimeout(() => controller.error(new Error("connection reset during body")), 5);
    },
  }), { status });
}

describe("2xx body failures are errors, not successful empty objects", () => {
  test("200 headers + partial body + disconnect throws retryable ApiError", async () => {
    respond(interrupted());
    const error = await api("/ledger/test").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: "body_read_failed", retryable: true });
  });

  test("body stalls past the request timeout after headers arrive", async () => {
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"padding":"' + "x".repeat(65536)));
        init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true });
      },
    }))) as typeof fetch;
    const error = await api("/ledger/test", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "body_read_failed", retryable: true });
  });

  test("non-JSON 200 is retryable; empty 200 / 204 and valid JSON stay compatible", async () => {
    for (const text of ["<html>proxy</html>", '{"tasks":', " "]) {
      respond(new Response(text));
      expect(await api("/test").catch((e: unknown) => e)).toMatchObject({ code: "invalid_json", retryable: true });
    }
    for (const status of [200, 204]) {
      respond(new Response(null, { status }));
      const body = await api("/test");
      expect(body).toEqual({});
    }
    respond(Response.json(valid()));
    const body = await api("/test");
    expect(body).toEqual(valid());
  });

  test("non-2xx keeps status/body semantics, including interrupted 401", async () => {
    respond(new Response("proxy unavailable", { status: 502 }));
    expect(await api("/test").catch((e: unknown) => e)).toMatchObject({ status: 502, message: "proxy unavailable" });
    respond(interrupted(401));
    expect(await api("/test").catch((e: unknown) => e)).toBeInstanceOf(DeviceInvalidError);
    respond(Response.json({ error: "conflict", runId: "1" }, { status: 409 }));
    expect(await api("/test").catch((e: unknown) => e)).toMatchObject({ status: 409, body: { runId: "1" } });
  });
});

describe("ledger shape and metadata fallback", () => {
  test("fetchLedger rejects empty/error/missing-meta and invalid array fields", async () => {
    const { meta: _meta, ...missingMeta } = valid();
    for (const value of [{}, { error: "proxy" }, missingMeta, null, [], ...["meta", "tasks", "items", "deps"].map((key) => ({ ...valid(), [key]: null }))]) {
      expect(isLedgerOverview(value)).toBe(false);
      expect(() => assertLedgerOverview(value)).toThrow(ApiError);
      respond(Response.json(value));
      expect(await fetchLedger("test").catch((e: unknown) => e)).toMatchObject({ code: "invalid_ledger_overview", retryable: true });
    }
    respond(Response.json(valid()));
    expect(await fetchLedger("test")).toEqual(valid());
  });

  test("missing metadata renders with empty PMs/team/docs and an unfrozen queue", () => {
    for (const value of [null, {}, { meta: null }, { meta: [] }, { meta: {} }]) {
      expect(metaOf(value)).toEqual({ pms: [], team: null, docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } });
    }
    const ov = { ...valid(), meta: undefined } as unknown as LedgerOverview;
    expect(homeView(ov, 123).pm).toMatchObject({ pm: null, frozen: null });
    const meta = { pms: ["pm"], team: { name: "team" }, docsDir: "/docs", queueFrozen: { frozen: true, reason: "paused", since: 12 } };
    expect(metaOf({ meta })).toEqual(meta);
  });
});
