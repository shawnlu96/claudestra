/**
 * 网页上的邀请生成 / 加入按请求来源分流（bridge/peers-routes.ts；docs/relay/e2e-design.md §5.1、§6.1 第 12 条）：
 * 经中继（source=relay）或判不出来源 → 只生成不加密的邀请（--via-relay-page）、拒绝加入加密邀请；回环 / 局域网与 CLI 一样。
 */
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { handlePeersRoutes } from "../src/bridge/peers-routes.ts";
import { setRequestContext, type RequestContext } from "../src/bridge/request-context.ts";
import { signE2eKey } from "../src/lib/e2e-machine-key.ts";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { keyFingerprint } from "../src/lib/instance-key.ts";
import { RELAY_PAGE_JOIN_REFUSED } from "../src/lib/peer-e2e-local.ts";
import { encodePeerInviteV2 } from "../src/lib/peers.ts";
import type { Principal } from "../src/lib/principals.ts";

const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const SOURCES: Record<string, RequestContext | null> = {
  relay: { source: "relay", clientIp: null, https: true },
  unknown: null,
  loopback: { source: "loopback", clientIp: "127.0.0.1", https: false },
  lan: { source: "lan", clientIp: "100.64.0.9", https: false },
};

function post(path: string, body: unknown, ctx: RequestContext | null): Request {
  const req = new Request(`http://bridge.local/api/v1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (ctx) setRequestContext(req, ctx);
  return req;
}

function recorder() {
  const calls: string[][] = [];
  return { calls, run: async (...args: string[]) => (calls.push(args), { ok: true, warnings: [] }) };
}

async function keyedInvite(): Promise<string> {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const idk = String(createPublicKey(privateKey).export({ format: "jwk" }).x);
  const fp = keyFingerprint(idk);
  const ek = signE2eKey({ privateKey }, (await generateEcdh()).pub, 1, 1790000000);
  return encodePeerInviteV2({ v: 2, name: "carol", url: `relay://${fp}`, token: "t".repeat(40), join: "j".repeat(40), iid: "c0c0c0c0c0c0c0c0c0c0c0c0", fp, idk, ek });
}
const legacyInvite = encodePeerInviteV2({ v: 2, name: "dave", url: "http://100.64.0.7:3847", token: "t".repeat(40), join: "j".repeat(40), iid: "d0d0d0d0d0d0d0d0d0d0d0d0" });

describe("网页生成邀请", () => {
  test("经中继、判不出来源 → 带 --via-relay-page（不加密 + 警告）；回环、局域网 → 与 CLI 一样", async () => {
    for (const [name, ctx] of Object.entries(SOURCES)) {
      const m = recorder();
      const res = (await handlePeersRoutes(post("/peers/invite-new", { agents: ["x"] }, ctx), "/peers/invite-new", OWNER, m.run))!;
      expect(res.status).toBe(200);
      expect(m.calls[0].includes("--via-relay-page")).toBe(name === "relay" || name === "unknown");
    }
  });
});

describe("网页加入邀请", () => {
  test("加密邀请：经中继、判不出来源 → 400 并给替代做法，manager 不被调用；回环、局域网 → 照常加入", async () => {
    const invite = await keyedInvite();
    for (const [name, ctx] of Object.entries(SOURCES)) {
      const m = recorder();
      const res = (await handlePeersRoutes(post("/peers/join-auto", { invite }, ctx), "/peers/join-auto", OWNER, m.run))!;
      if (name === "relay" || name === "unknown") {
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ ok: false, error: RELAY_PAGE_JOIN_REFUSED });
        expect(m.calls).toEqual([]);
      } else {
        expect(res.status).toBe(200);
        expect(m.calls[0].slice(0, 2)).toEqual(["peer-join-auto", invite]);
      }
    }
  });

  test("不加密的邀请经中继照常加入（它本来就不防中继）", async () => {
    const m = recorder();
    const res = (await handlePeersRoutes(post("/peers/join-auto", { invite: legacyInvite }, SOURCES.relay), "/peers/join-auto", OWNER, m.run))!;
    expect(res.status).toBe(200);
    expect(m.calls[0].slice(0, 2)).toEqual(["peer-join-auto", legacyInvite]);
  });

  test("替代做法的话术：说明为什么不行、给出本机页面 / 命令行 / --allow-legacy 三条路", () => {
    for (const w of ["中继看得到邀请内容", "本机页面", "peer-join-auto", "--allow-legacy"]) expect(RELAY_PAGE_JOIN_REFUSED).toContain(w);
  });
});
