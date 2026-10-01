/**
 * i28-W2 lend wire v2（src/lib/lend-wire-v2.ts）：hello / beat / ask / offer 请求与应答的严格解析；LEND_PROTO 只定义一次；
 * v2 拒绝码不用 404（404 只表示对方是旧版）；bridge 的 v2 路由对调用方的要求与 v1 同一道闸（local-api/lend.ts lendCallerRefusal）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { handleLendApi, lendCallerRefusal } from "../src/bridge/local-api/lend.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { LEND_PROTO, LEND_V2_STATUS, offerBody, parseV2Request, parseV2Response, helloAnswer } from "../src/lib/lend-wire-v2.js";
import type { OfferSummary } from "../src/lib/lend-wire.js";
import type { Principal } from "../src/lib/principals.js";

const H = "a".repeat(40);
const hello = { v: 1, proto: 2, boot: "boot-0001", seq: 1, grant: { until: 9, roles: ["review"], repos: ["o/r"], ordersPerDay: 3, ordersLeftToday: 3 },
  slots: { codex: { total: 1, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null };
const line = { orderId: "lend:T1:s1:r1:a0", gen: 1, phase: "working", lastActivityAt: 5, excerpt: "跑测试\n第二行" };
const summary: OfferSummary = { orderId: "lend:T1:s1:r1:a0", taskId: "T1", step: "review", family: "codex", repo: "o/r", pr: 3, head: H, round: 1, specRev: 1, offeredAt: 7 };
const bad = (r: { ok: boolean; error?: string }, path: string) => {
  expect(r.ok).toBe(false);
  expect(r.error).toContain(path);
};

describe("请求", () => {
  test("hello：字段齐全才收；grant / paused 可为 null；proto 至少 2", () => {
    expect<unknown>(parseV2Request("hello", hello)).toEqual({ ok: true, value: hello });
    expect<unknown>(parseV2Request("hello", { ...hello, grant: null, paused: { reason: "codex_quota", until: 9 } }).ok).toBe(true);
    bad(parseV2Request("hello", { ...hello, extra: 1 }), "extra");
    bad(parseV2Request("hello", { ...hello, v: 2 }), "v");
    bad(parseV2Request("hello", { ...hello, proto: 1 }), "proto");
    bad(parseV2Request("hello", { ...hello, boot: "x" }), "boot");
    bad(parseV2Request("hello", { ...hello, slots: { codex: { total: 1, busy: 0 } } }), "slots");
    bad(parseV2Request("hello", { ...hello, grant: { ...hello.grant, repos: ["../x"] } }), "grant.repos");
    bad(parseV2Request("hello", { ...hello, paused: { reason: "Bad Reason", until: 1 } }), "paused.reason");
  });

  test("beat：ended 可省；ended 只认 revoked + 布尔 clean；≤50 行、单号不重复、摘要 ≤1 KiB 不带控制字符", () => {
    expect<unknown>(parseV2Request("beat", { v: 1, orders: [line] })).toEqual({ ok: true, value: { v: 1, orders: [{ ...line, ended: null }] } });
    const ended = parseV2Request("beat", { v: 1, orders: [{ ...line, ended: { reason: "revoked", clean: false } }] });
    expect<unknown>(ended.ok && ended.value.orders[0]!.ended).toEqual({ reason: "revoked", clean: false });
    bad(parseV2Request("beat", { v: 1, orders: [{ ...line, ended: { reason: "revoked", clean: "yes" } }] }), "clean");
    bad(parseV2Request("beat", { v: 1, orders: [{ ...line, phase: "idle" }] }), "phase");
    bad(parseV2Request("beat", { v: 1, orders: [{ ...line, gen: 0 }] }), "gen");
    bad(parseV2Request("beat", { v: 1, orders: [line, line] }), "两次");
    bad(parseV2Request("beat", { v: 1, orders: [{ ...line, excerpt: "x".repeat(1025) }] }), "excerpt");
    bad(parseV2Request("beat", { v: 1, orders: [{ ...line, excerpt: "a b" }] }), "excerpt");
  });

  test("ask：问题和选项按本机 ask 工具的上限；带租约代数；多字段拒", () => {
    const ask = { v: 1, orderId: "lend:T1:s1:r1:a0", gen: 2, question: "要不要改 X？", options: ["改", "不改"] };
    expect<unknown>(parseV2Request("ask", ask)).toEqual({ ok: true, value: ask });
    bad(parseV2Request("ask", { ...ask, taskId: "T2" }), "taskId");
    bad(parseV2Request("ask", { ...ask, question: "" }), "question");
    bad(parseV2Request("ask", { ...ask, options: Array(11).fill("o") }), "options");
  });

  test("offer：A 推给 B 的就是 v1 poll 的摘要，最多 20 条、不空、不重复", () => {
    expect<unknown>(parseV2Request("offer", offerBody([summary]))).toEqual({ ok: true, value: { v: 1, proto: LEND_PROTO, orders: [summary] } });
    expect(offerBody(Array(25).fill(summary)).orders.length).toBe(20);
    bad(parseV2Request("offer", { v: 1, proto: 2, orders: [] }), "空");
    bad(parseV2Request("offer", { v: 1, proto: 2, orders: [summary, summary] }), "两次");
    bad(parseV2Request("offer", { v: 1, proto: 2, orders: [{ ...summary, head: "abc" }] }), "head");
    bad(parseV2Request("offer", { v: 1, proto: 2, orders: [{ ...summary, text: "全文" }] }), "text");
  });
});

describe("应答", () => {
  test("各接口成功体只认自己那几个字段", () => {
    expect<unknown>(parseV2Response("hello", { ok: true, v: 1, ...helloAnswer() })).toEqual({ ok: true, value: { proto: 2, helloMs: 60_000, beatMs: 15_000 } });
    bad(parseV2Response("hello", { ok: true, v: 1, ...helloAnswer(), applied: true }), "applied");
    const answer = { orderId: "o", verdict: "stale_gen", lease: null };
    expect<unknown>(parseV2Response("beat", { ok: true, v: 1, orders: [answer] })).toEqual({ ok: true, value: [answer] });
    bad(parseV2Response("beat", { ok: true, v: 1, orders: [{ ...answer, verdict: "maybe" }] }), "verdict");
    expect<unknown>(parseV2Response("ask", { ok: true, v: 1, askId: "ask_1" })).toEqual({ ok: true, value: { askId: "ask_1" } });
    bad(parseV2Response("ask", { ok: true, v: 1, askId: "ask_1", askee: "agent-pm" }), "askee");
    expect<unknown>(parseV2Response("offer", { ok: true, v: 1, accepted: ["o"], refused: [{ orderId: "p", code: "no_grant" }] }).ok).toBe(true);
    bad(parseV2Response("offer", { ok: false, v: 1, accepted: [], refused: [] }), "ok");
  });
});

describe("协议常量与状态码", () => {
  test("LEND_PROTO 在 src 里只定义一次（协议常量单一来源）", () => {
    const root = resolve(import.meta.dir, "../src");
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /\bLEND_PROTO\s*=/.test(readFileSync(p, "utf8"))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual(["lib/lend-wire-v2.ts"]);
  });

  test("v2 拒绝码没有 404：对方 v2 接口回 404 只可能是旧版", () => {
    expect(Object.values(LEND_V2_STATUS)).not.toContain(404);
  });
});

describe("v2 路由：谁能调", () => {
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
  const signed = { "x-claudestra-key": "k".repeat(43), "x-claudestra-sig": "s" };

  test("hello / beat / ask：非 peer、邀请 token、非 E2E、没钉钥（签了也不算）一律 401，碰不到台账", async () => {
    for (const ep of ["hello", "beat", "ask"]) {
      const path = `/lend/${ep}`;
      expect(await status(handleLendApi(post(path, true, signed), path, peer(undefined)))).toEqual([401, "unauthorized"]);
      expect(await status(handleLendApi(post(path, true, signed), path, peer("invite:x")))).toEqual([401, "unauthorized"]);
      expect(await status(handleLendApi(post(path, false, signed), path, peer("mate")))).toEqual([401, "unauthorized"]);
      expect(await status(handleLendApi(post(path, true, signed), path, peer("never-pinned")))).toEqual([401, "unauthorized"]);
      expect(await status(handleLendApi(post(path, true), path, peer("never-pinned")))).toEqual([401, "unauthorized"]);
    }
  });

  test("offer 不是 A 的路由（那是出借方收推送的入口，W3）；闸本身导出给它复用", async () => {
    expect(await handleLendApi(post("/lend/offer", true), "/lend/offer", peer("mate"))).toBeNull();
    expect(await handleLendApi(post("/lend/pushed", true), "/lend/pushed", peer("mate"))).toBeNull();
    expect(lendCallerRefusal(post("/lend/offer", false), peer("mate"))).toMatch(/端到端/);
  });
});
