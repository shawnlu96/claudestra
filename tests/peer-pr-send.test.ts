/** i28-A2 §5 bridge 发送端：帧里的一切都不信，配置 / peers.json / 门现读重核；任何一项不过就是带类型的拒绝、零字节外发。 */
import { describe, expect, test } from "bun:test";
import { handlePeerPrPush, type PeerPrSendDeps } from "../src/bridge/peer-pr-send.ts";
import type { PeerPrConfig } from "../src/lib/peer-pr-config.ts";
import { GATE_REJECTED, PUSH_MAX_BYTES } from "../src/lib/peer-pr-message.ts";
import type { HttpPeer } from "../src/lib/peers.ts";

const FP = "0a1b-2c3d-4e5f-6a7b";
const HEAD = "ab".repeat(20);
const CFG = { project: "p", repoDir: "/repo", peers: [{ peer: "he", fp: FP, agent: "agent-x", githubLogins: ["he"], authorFamily: "claude" }] } as unknown as PeerPrConfig;
const PEER: HttpPeer = { name: "he", baseUrl: "https://peer.example/", outToken: "out", fp: FP, addedAt: "" };
const FRAME = { type: "peer_pr_push", peer: "he", fp: FP, agent: "agent-x", key: "PR1:review:3", text: `审查结论，head ${HEAD}`, shas: [HEAD] };

function deps(over: Partial<PeerPrSendDeps> = {}) {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const d: PeerPrSendDeps = {
    readConfig: () => ({ kind: "on", config: CFG }),
    peers: async () => [PEER],
    commits: async (_dir, shas) => new Set(shas.filter((s) => s === HEAD)),
    post: async (url, headers, body) => { posts.push({ url, headers, body }); return 202; },
    ...over,
  };
  return { d, posts };
}

describe("handlePeerPrPush", () => {
  test("全过：一次 POST 到对方 agent 的 messages，回 HTTP 状态", async () => {
    const { d, posts } = deps();
    expect(await handlePeerPrPush(FRAME, false, d)).toEqual({ result: { status: 202 } });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://peer.example/api/v1/agents/agent-x/messages");
    expect(posts[0]!.headers.Authorization).toBe("Bearer out");
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ text: FRAME.text, wait: 0 });
  });

  const refusals: [string, Record<string, unknown>, Partial<PeerPrSendDeps>, string][] = [
    ["agent 频道发来的帧", {}, {}, "peer_pr_caller"],
    ["缺字段", { agent: undefined }, {}, "peer_pr_frame"],
    ["超大", { text: "x".repeat(PUSH_MAX_BYTES + 1) }, {}, "peer_pr_size"],
    ["配置关了", {}, { readConfig: () => ({ kind: "off" }) }, "peer_pr_config"],
    ["收件三元组不是配置里的", { agent: "agent-y" }, {}, "peer_pr_target"],
    ["peers.json 禁用", {}, { peers: async () => [{ ...PEER, disabled: true }] }, "peer_pr_peer"],
    ["peers.json 指纹对不上", {}, { peers: async () => [{ ...PEER, fp: "ffff-ffff-ffff-ffff" }] }, "peer_pr_peer"],
    ["握手不全", {}, { peers: async () => [{ ...PEER, outToken: undefined }] }, "peer_pr_peer"],
    ["门：不是仓库 commit 的长十六进制", {}, { commits: async () => new Set() }, GATE_REJECTED],
    ["门：前缀被空白拆开的密钥", { text: `审查结论，head ${HEAD}\ns k - abcdefghijklmnopqrstuvwx` }, {}, GATE_REJECTED],
  ];
  for (const [why, frame, over, code] of refusals) {
    test(`拒：${why}`, async () => {
      const { d, posts } = deps(over);
      const r = await handlePeerPrPush({ ...FRAME, ...frame }, why.startsWith("agent"), d);
      expect(r).toMatchObject({ rejected: code });
      expect(posts).toHaveLength(0);
    });
  }

  test("网络出错 = 结果不明（不带 rejected，调度器重试）", async () => {
    const { d } = deps({ post: async () => { throw new Error("timeout"); } });
    const r = await handlePeerPrPush(FRAME, false, d);
    expect(r).toMatchObject({ error: expect.stringContaining("结果不明") });
    expect("rejected" in r).toBe(false);
  });
});
