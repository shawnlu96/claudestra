/**
 * 兑换端点进 manager 之前的一段（bridge/peer-redeem.ts redeemPrecheck）：经中继隧道 / 路径模式来的 403；
 * 口令不对的按来源分桶限速，不连累别的来源、也不连累同一来源上口令对的兑换；口令对的才进全局桶；nonce 至少 128 位。
 * 状态文件写在 preload 的临时 STATE_DIR。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../src/lib/paths.js";
import { redeemArgs, redeemPrecheck, resetRedeemLimitsForTest, type RedeemInput } from "../src/bridge/peer-redeem.js";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.js";

const JOIN = "g".repeat(48);
beforeAll(() => {
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [], pendingInvites: [
    { id: "inv_gate", joinSecret: JOIN, inTokenId: "tok_gate", agents: ["*"], url: "", createdAt: "", expiresAt },
  ] }));
});
afterAll(() => rmSync(join(STATE_DIR, "peers.json"), { force: true }));
beforeEach(() => resetRedeemLimitsForTest());

function req(body: Record<string, unknown>, ctx: Partial<RequestContext> = {}): Request {
  const r = new Request("http://127.0.0.1:1/api/v1/peers/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  setRequestContext(r, { source: "peer-ingress", clientIp: "203.0.113.1", https: false, ...ctx });
  return r;
}
const status = async (r: Request) => {
  const out = await redeemPrecheck(r);
  return out instanceof Response ? out.status : 200;
};

describe("兑换前置检查", () => {
  test("经中继隧道 / 路径模式（source=relay）→ 403", async () => {
    expect(await status(req({ join: JOIN, name: "n" }, { source: "relay" }))).toBe(403);
  });
  test("口令不对的按来源分桶：一个来源试满只拒它自己，同一来源口令对的照常", async () => {
    for (let i = 0; i < 10; i++) expect(await status(req({ join: "b".repeat(48), name: "n" }))).toBe(400);
    expect(await status(req({ join: "b".repeat(48), name: "n" }))).toBe(429);
    expect(await status(req({ join: "b".repeat(48), name: "n" }, { clientIp: "203.0.113.2" }))).toBe(400);
    expect(await status(req({ join: "b".repeat(48), name: "n" }, { clientIp: null, relayFrom: "16f9-b5d1-30fb-8923" }))).toBe(400);
    expect(await status(req({ join: JOIN, name: "n" }))).toBe(200);
  });
  test("口令对的进全局桶：每分钟 30 次", async () => {
    for (let i = 0; i < 30; i++) expect(await status(req({ join: JOIN, name: "n" }, { clientIp: `198.51.100.${i}` }))).toBe(200);
    expect(await status(req({ join: JOIN, name: "n" }, { clientIp: "198.51.100.99" }))).toBe(429);
  });
  test("nonce 不足 128 位当没带；参数原样交给 manager", async () => {
    const short = (await redeemPrecheck(req({ join: JOIN, name: "n", nonce: "a".repeat(21) }))) as RedeemInput;
    expect(short.nonce).toBe("");
    const ok = (await redeemPrecheck(req({ join: JOIN, name: "n", nonce: "a".repeat(22), iid: "bad id" }))) as RedeemInput;
    expect(ok).toMatchObject({ nonce: "a".repeat(22), iid: "", fp: "", pk: "" });
    expect(redeemArgs(ok)).toEqual(["--join", JOIN, "--name", "n", "--nonce", "a".repeat(22)]);
  });
});
