/** T94 B→A 出借接口的响应解析与前提（src/lib/lend-remote.ts） */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { LEND_OLD_PEER, lendRequest, peerLendProblem, proxyVarsIn, type LendCall } from "../src/lib/lend-remote.js";
import type { HttpPeer } from "../src/lib/peers.js";

const reply = (status: number, body: unknown): LendCall<string> => async () => ({ status, body });
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const lease = { gen: 1, expiresAt: 5, ms: 600_000 };

describe("T94 lendRequest", () => {
  test("请求体带 v:1；成功体严格解析", async () => {
    let seen: Record<string, unknown> = {};
    const r = await lendRequest(async (_p, _op, body) => { seen = body; return { status: 200, body: { ok: true, v: 1, lease } }; }, "a", "lease", { orderId: "o" });
    expect(seen).toEqual({ v: 1, orderId: "o" });
    expect(r).toEqual({ ok: true, value: lease });
  });

  test("多字段 / 版本不对 / 不是 JSON：bad_response（结果不明，不当拒绝）", async () => {
    expect(await lendRequest(reply(200, { ok: true, v: 1, lease, extra: 1 }), "a", "lease", {})).toMatchObject({ ok: false, code: "bad_response" });
    expect(await lendRequest(reply(200, { ok: true, v: 2, lease }), "a", "lease", {})).toMatchObject({ ok: false, code: "bad_response" });
    expect(await lendRequest(reply(502, null), "a", "lease", {})).toMatchObject({ ok: false, code: "bad_response" });
  });

  test("对方明确拒绝：原样带出 code；发不出去：transport", async () => {
    expect(await lendRequest(reply(409, { ok: false, code: "lease_expired", error: "过期" }), "a", "lease", {})).toMatchObject({ ok: false, status: 409, code: "lease_expired" });
    expect(await lendRequest(async () => { throw new Error("断了"); }, "a", "poll", {})).toMatchObject({ ok: false, code: "transport" });
  });

  test("claim：派单全文的 sha256 对不上 / 订单不合格都不收", async () => {
    const order = { v: 1, orderId: "o", taskId: "T", specRev: 1, dagVersion: null, node: "n", step: "review", round: 1, head: "a".repeat(40),
      repo: "o/r", pr: 1, inputs: [], outputs: [], acceptance: [], writeBack: "w", findings: [], fallback: null };
    const ok = await lendRequest(reply(200, { ok: true, v: 1, order, text: "t", sha256: sha("t"), lease }), "a", "claim", {});
    expect(ok.ok).toBe(true);
    expect(await lendRequest(reply(200, { ok: true, v: 1, order, text: "t", sha256: sha("u"), lease }), "a", "claim", {})).toMatchObject({ code: "bad_response" });
    expect(await lendRequest(reply(200, { ok: true, v: 1, order: { ...order, head: "abc" }, text: "t", sha256: sha("t"), lease }), "a", "claim", {}))
      .toMatchObject({ code: "bad_response" });
  });

  test("poll 摘要超过 20 条不收", async () => {
    const o = { orderId: "o", taskId: "T", step: "review", family: "codex", repo: "o/r", pr: null, head: "a".repeat(40), round: 1, specRev: 1, offeredAt: 1 };
    expect(await lendRequest(reply(200, { ok: true, v: 1, orders: Array(21).fill(o), pollAfterMs: 1 }), "a", "poll", {})).toMatchObject({ code: "bad_response" });
  });
});

describe("T94 前提", () => {
  const good = { name: "a", addedAt: "x", baseUrl: "relay://x", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
  test("没钉完整公钥、没 E2E、握手没完成、禁用、不在 peers.json：都不借", () => {
    expect(peerLendProblem(good, "a")).toBeNull();
    expect(peerLendProblem({ ...good, e2e: undefined }, "a")).toMatch(/端到端/);
    expect(peerLendProblem({ ...good, publicKey: undefined }, "a")).toMatch(/公钥/);
    expect(peerLendProblem({ ...good, outToken: undefined }, "a")).toMatch(/握手/);
    expect(peerLendProblem({ ...good, disabled: true }, "a")).toMatch(/禁用/);
    expect(peerLendProblem(undefined, "a")).toMatch(/不在/);
  });

  test("代理变量（大小写都算），空值不算", () => {
    expect(proxyVarsIn({ https_proxy: "http://p", ALL_PROXY: "socks5://x", HTTP_PROXY: " ", NO_PROXY: "*" })).toEqual(["ALL_PROXY", "https_proxy"]);
  });
});

describe("i28-W2 v2 op", () => {
  test("hello / beat / ask 的成功体按 lend-wire-v2 严格解析", async () => {
    expect(await lendRequest(reply(200, { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 }), "a", "hello", {}))
      .toEqual({ ok: true, value: { proto: 2, helloMs: 60_000, beatMs: 15_000 } });
    expect(await lendRequest(reply(200, { ok: true, v: 1, orders: [{ orderId: "o", verdict: "ok", lease }] }), "a", "beat", {}))
      .toEqual({ ok: true, value: [{ orderId: "o", verdict: "ok", lease }] });
    expect(await lendRequest(reply(200, { ok: true, v: 1, askId: "ask_1" }), "a", "ask", {})).toEqual({ ok: true, value: { askId: "ask_1" } });
    expect(await lendRequest(reply(200, { ok: true, v: 1, askId: "ask_1", taskId: "T2" }), "a", "ask", {})).toMatchObject({ code: "bad_response" });
  });

  test("v2 接口回 404（不管正文是不是 JSON）= 对方是旧版：old_peer，调用方退回轮询；v1 接口的 404 照旧按对方的码", async () => {
    for (const op of ["hello", "beat", "ask"] as const) {
      expect(await lendRequest(reply(404, { ok: false, error: "not found" }), "a", op, {})).toMatchObject({ ok: false, status: 404, code: LEND_OLD_PEER });
      expect(await lendRequest(reply(404, null), "a", op, {})).toMatchObject({ code: LEND_OLD_PEER });
    }
    expect(await lendRequest(reply(404, { ok: false, code: "not_found", error: "没有" }), "a", "claim", {})).toMatchObject({ code: "not_found" });
    expect(await lendRequest(reply(409, { ok: false, code: "not_held", error: "不在你名下" }), "a", "ask", {})).toMatchObject({ code: "not_held" });
  });
});
