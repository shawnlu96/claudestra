/**
 * T93 lend 接口：请求体严格解析（lib/lend-wire.ts）、bridge 路由对调用方的要求（local-api/lend.ts：只收 peer token + E2E +
 * 钉钥签名，缺一条 401、不起 CLI）、「只能投递消息」token 放行四条 lend 路径。台账侧的行为在 tests/ledger-lend.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { handleLendApi } from "../src/bridge/local-api/lend.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { parseLendRequest } from "../src/lib/lend-wire.js";
import { messagesOnlyAllows } from "../src/lib/peer-scope-gate.js";
import type { Principal } from "../src/lib/principals.js";

const H = "a".repeat(40);
const verdict = (orderId: string) => ({ v: 1, orderId, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" });
const refused = (r: { ok: boolean; error?: string }, part: string) => {
  expect(r.ok).toBe(false);
  expect((r as { error: string }).error).toContain(part);
};

describe("parseLendRequest", () => {
  test("well-formed requests parse", () => {
    expect(parseLendRequest("poll", { v: 1, capacity: { families: { codex: 2 }, busy: { codex: 1 }, roles: ["review"], repos: ["a/b"], ordersLeftToday: 3 } }).ok).toBe(true);
    expect(parseLendRequest("claim", { v: 1, orderId: "lend:T9:s1:r1:a0", worker: "w-1" }).ok).toBe(true);
    expect(parseLendRequest("lease", { v: 1, orderId: "o", gen: 1, action: "release", reason: "stopped", detail: "撞额度" }).ok).toBe(true);
    const r = parseLendRequest("result", { v: 1, orderId: "o", gen: 1, verdict: verdict("o"), report: "报告", session: { id: "s", family: "codex" } });
    expect(r).toMatchObject({ ok: true, value: { session: { family: "codex" } } });
  });

  test("unknown / missing fields, wrong versions and shapes are refused, never trimmed", () => {
    refused(parseLendRequest("claim", { v: 1, orderId: "o", worker: "w", extra: 1 }), "不认识的字段 extra");
    refused(parseLendRequest("claim", { v: 2, orderId: "o", worker: "w" }), "只认版本 1");
    refused(parseLendRequest("claim", { v: 1, orderId: "o" }), "缺字段 worker");
    refused(parseLendRequest("claim", { v: 1, orderId: "o", worker: "a b" }), "worker");
    refused(parseLendRequest("poll", { v: 1, capacity: { families: { gpt: 1 }, busy: {}, roles: [], repos: [], ordersLeftToday: 0 } }), "families.gpt");
    refused(parseLendRequest("poll", { v: 1, capacity: { families: {}, busy: {}, roles: ["review"], repos: ["../etc"], ordersLeftToday: 0 } }), "repos[0]");
    refused(parseLendRequest("lease", { v: 1, orderId: "o", gen: 1, action: "renew", reason: "stopped", detail: null }), "reason");
    refused(parseLendRequest("lease", { v: 1, orderId: "o", gen: 1, action: "release", reason: "stopped", detail: "a\nb" }), "detail");
    refused(parseLendRequest("lease", { v: 1, orderId: "o", gen: 0, action: "renew", reason: null, detail: null }), "gen");
  });

  test("result: the verdict goes through T87's parser, must name the same order, and the report has a byte cap", () => {
    const base = { v: 1, orderId: "o", gen: 1, verdict: verdict("o"), report: "r", session: { id: "s", family: "codex" } };
    refused(parseLendRequest("result", { ...base, verdict: { ...verdict("o"), p1: 1 } }), "verdict");
    refused(parseLendRequest("result", { ...base, verdict: verdict("other") }), "verdict.orderId");
    refused(parseLendRequest("result", { ...base, report: "界".repeat(22_000) }), "report");
    refused(parseLendRequest("result", { ...base, report: "" }), "report");
    refused(parseLendRequest("result", { ...base, session: { id: "s", family: "gpt" } }), "session.family");
  });
});

describe("lend routes: who may call", () => {
  const peer = (p: string | undefined): Principal => ({ id: "token:t", role: "external", agents: [], createdAt: "", ...(p ? { peer: p } : {}) }) as Principal;
  const post = (path: string, e2e: boolean, headers: Record<string, string> = {}) => {
    const req = new Request(`http://x/api/v1${path}`, { method: "POST", body: "{}", headers });
    setRequestContext(req, { source: "peer-ingress", clientIp: null, https: false, ...(e2e ? { e2e: { peerFp: "f" } } : {}) });
    return req;
  };
  const status = async (r: Promise<Response | null>) => {
    const res = await r;
    return res ? [res.status, ((await res.json()) as { code?: string }).code] : null;
  };

  test("anything but a redeemed peer token over E2E with its pinned key and a signature is 401 before any ledger call", async () => {
    expect(await status(handleLendApi(post("/lend/poll", true), "/lend/poll", peer(undefined)))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendApi(post("/lend/poll", true), "/lend/poll", peer("invite:x")))).toEqual([401, "unauthorized"]);
    expect(await status(handleLendApi(post("/lend/claim", false), "/lend/claim", peer("mate")))).toEqual([401, "unauthorized"]);
    const signed = { "x-claudestra-key": "k".repeat(43), "x-claudestra-sig": "s" };
    expect(await status(handleLendApi(post("/lend/result", true, signed), "/lend/result", peer("never-pinned")))).toEqual([401, "unauthorized"]);
  });

  test("only the four exact POST paths are lend's; messages-only tokens may reach them", async () => {
    expect(await handleLendApi(post("/lend/pollx", true), "/lend/pollx", peer("mate"))).toBeNull();
    expect(await handleLendApi(post("/lend", true), "/lend", peer("mate"))).toBeNull();
    const get = new Request("http://x/api/v1/lend/poll");
    expect((await handleLendApi(get, "/lend/poll", peer("mate")))!.status).toBe(405);
    for (const e of ["poll", "claim", "lease", "result"]) expect(messagesOnlyAllows("POST", `/api/v1/lend/${e}`)).toBe(true);
    expect(messagesOnlyAllows("GET", "/api/v1/lend/poll")).toBe(false);
    expect(messagesOnlyAllows("POST", "/api/v1/lend/poll/x")).toBe(false);
  });
});
