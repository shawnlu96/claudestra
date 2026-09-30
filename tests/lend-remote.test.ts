/** T94 B→A 出借接口的响应解析与前提（src/lib/lend-remote.ts） */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lendRequest, peerLendProblem, proxyVarsIn, type LendCall } from "../src/lib/lend-remote.js";
import type { HttpPeer } from "../src/lib/peers.js";

const reply = (status: number, body: unknown): LendCall => async () => ({ status, body });
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
