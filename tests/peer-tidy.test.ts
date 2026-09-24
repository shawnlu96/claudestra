import { describe, expect, test } from "bun:test";
import { activePeerTokens, applyPeerTidy, mergedPeerRecord, planPeerTidy, type PeerTokenRef } from "../src/lib/peer-tidy";
import type { HttpPeer } from "../src/lib/peers";
import type { Principal } from "../src/lib/principals";

const OUT = "o".repeat(64);

/** owner 机器上 2026-09-24 的真实形态（token secret / outToken 换成占位） */
function ownerData(): { peers: HttpPeer[]; principals: Principal[] } {
  const peers: HttpPeer[] = [
    { addedAt: "2026-07-31T03:10:28.077Z", name: "HedeMacBook-Pro", inTokenId: "tok_af027363" },
    { addedAt: "2026-07-31T03:15:53.887Z", name: "HedeMacBook-Pro-2", baseUrl: "http://100.82.126.45:3847", outToken: OUT },
    { addedAt: "2026-08-23T03:32:35.751Z", name: "HedeMacBook-Pro-3", inTokenId: "tok_9d14428c" },
    { addedAt: "2026-09-23T17:02:55.175Z", name: "Sekai", inTokenId: "tok_6354ae44" },
    { addedAt: "2026-09-23T17:24:21.140Z", name: "Sekai-2", baseUrl: "http://100.113.223.87:13847", outToken: OUT },
  ];
  const tok = (id: string, peer: string, createdAt: string, disabled = false): Principal => ({
    id: `token:${id}`, role: "external", name: `peer-${peer}`, agents: ["claudestra"], secret: "s", peer, createdAt, disabled,
  });
  const principals: Principal[] = [
    { id: "discord:1", role: "owner", agents: ["*"], createdAt: "2026-07-01T00:00:00Z" },
    tok("tok_79f9976b", "self", "2026-07-19T00:01:43.729Z", true),
    tok("tok_c3779c6b", "macmini-2", "2026-07-26T18:29:27.140Z", true),
    tok("tok_af027363", "HedeMacBook-Pro", "2026-07-31T03:03:41.151Z"),
    tok("tok_9d14428c", "HedeMacBook-Pro-3", "2026-08-23T03:29:25.435Z"),
    tok("tok_94d69715", "invite:inv_3cd370ef", "2026-09-23T15:34:34.312Z", true),
    tok("tok_6354ae44", "Sekai", "2026-09-23T16:59:40.009Z"),
    tok("tok_pending1", "invite:inv_live", "2026-09-24T01:00:00.000Z"),
  ];
  return { peers, principals };
}

describe("activePeerTokens", () => {
  test("只要有效、已兑换的 peer token（不含停用 / invite:* 占位 / 非 token principal）", () => {
    const { principals } = ownerData();
    expect(activePeerTokens(principals).map((t) => t.tokenId)).toEqual(["tok_af027363", "tok_9d14428c", "tok_6354ae44"]);
  });
});

describe("planPeerTidy：owner 的真实数据", () => {
  const { peers, principals } = ownerData();
  const plan = planPeerTidy(peers, activePeerTokens(principals));

  test("两组：HedeMacBook-Pro 三条合一、Sekai 两条合一", () => {
    expect(plan.map((g) => g.finalName)).toEqual(["HedeMacBook-Pro", "Sekai"]);
    expect(plan.every((g) => !g.skip)).toBe(true);
  });

  test("HedeMacBook-Pro：留新 token、留出站、吊销旧 token、addedAt 取最早", () => {
    const g = plan[0];
    expect(g.records).toEqual(["HedeMacBook-Pro", "HedeMacBook-Pro-2", "HedeMacBook-Pro-3"]);
    expect(g.keepToken).toBe("tok_9d14428c");
    expect(g.revokeTokens).toEqual(["tok_af027363"]);
    expect(g.outboundFrom).toBe("HedeMacBook-Pro-2");
    expect(g.baseUrl).toBe("http://100.82.126.45:3847");
    expect(g.addedAt).toBe("2026-07-31T03:10:28.077Z");
    expect(g.desc).toBe(
      "HedeMacBook-Pro、-2、-3 合成一张「HedeMacBook-Pro」：保留他连你的 token tok_9d14428c、你连他的 http://100.82.126.45:3847；" +
        "旧 token tok_af027363 吊销（他之后又重新加入过，旧的已被新的取代）；以后给他发消息写 <agent>@HedeMacBook-Pro",
    );
  });

  test("Sekai：入站 + 出站合成一条，不吊销任何 token", () => {
    const g = plan[1];
    expect(g.records).toEqual(["Sekai", "Sekai-2"]);
    expect(g.keepToken).toBe("tok_6354ae44");
    expect(g.revokeTokens).toEqual([]);
    expect(g.baseUrl).toBe("http://100.113.223.87:13847");
    expect(g.desc).toStartWith("Sekai、-2 合成一张「Sekai」：保留他连你的 token tok_6354ae44、你连他的 http://100.113.223.87:13847");
  });

  test("计划里不带任何凭据（它要发给 web 展示）", () => {
    expect(JSON.stringify(plan)).not.toContain(OUT);
  });

  test("apply：principals 吊销 + 改挂名字；peers 只剩两条完整记录", () => {
    const d = ownerData();
    const r = applyPeerTidy(d.peers, d.principals, plan);
    expect(r.revoked).toEqual(["tok_af027363"]);
    const byId = (id: string) => d.principals.find((p) => p.id === `token:${id}`)!;
    expect(byId("tok_af027363").disabled).toBe(true);
    expect(byId("tok_9d14428c")).toMatchObject({ peer: "HedeMacBook-Pro", name: "peer-HedeMacBook-Pro", disabled: false });
    expect(byId("tok_6354ae44")).toMatchObject({ peer: "Sekai", disabled: false });
    expect(byId("tok_pending1").peer).toBe("invite:inv_live"); // 待兑换的邀请不碰
    expect(r.httpPeers).toEqual([
      {
        name: "HedeMacBook-Pro", addedAt: "2026-07-31T03:10:28.077Z",
        baseUrl: "http://100.82.126.45:3847", outToken: OUT, inTokenId: "tok_9d14428c",
      },
      {
        name: "Sekai", addedAt: "2026-09-23T17:02:55.175Z",
        baseUrl: "http://100.113.223.87:13847", outToken: OUT, inTokenId: "tok_6354ae44",
      },
    ]);
    // 整理完再算一次：没有要做的了
    expect(planPeerTidy(r.httpPeers, activePeerTokens(d.principals))).toEqual([]);
  });
});

describe("planPeerTidy：边界", () => {
  const at = (d: string) => `2026-09-${d}T00:00:00.000Z`;
  const tok = (tokenId: string, peer: string, d: string): PeerTokenRef => ({ tokenId, peer, createdAt: at(d) });

  test("单条、活着的记录不进计划（哪怕名字带 -2）", () => {
    const peers: HttpPeer[] = [
      { name: "Alex", addedAt: at("01"), baseUrl: "http://100.1.1.1:3847", outToken: OUT, inTokenId: "tok_a" },
      { name: "macmini-2", addedAt: at("01"), baseUrl: "http://100.2.2.2:3847", outToken: OUT },
    ];
    expect(planPeerTidy(peers, [tok("tok_a", "Alex", "01")])).toEqual([]);
  });

  test("出站在两台不同机器 → 可能是两个人，整组不动", () => {
    const peers: HttpPeer[] = [
      { name: "Bob", addedAt: at("01"), baseUrl: "http://100.1.1.1:3847", outToken: OUT, inTokenId: "tok_b1" },
      { name: "Bob-2", addedAt: at("02"), baseUrl: "http://100.9.9.9:3847", outToken: OUT, inTokenId: "tok_b2" },
    ];
    const plan = planPeerTidy(peers, [tok("tok_b1", "Bob", "01"), tok("tok_b2", "Bob-2", "02")]);
    expect(plan).toHaveLength(1);
    expect(plan[0].skip).toContain("100.1.1.1 / 100.9.9.9");
    expect(plan[0].revokeTokens).toEqual([]);
    const principals: Principal[] = [
      { id: "token:tok_b1", role: "external", agents: ["x"], peer: "Bob", createdAt: at("01") },
      { id: "token:tok_b2", role: "external", agents: ["x"], peer: "Bob-2", createdAt: at("02") },
    ];
    const r = applyPeerTidy(peers, principals, plan);
    expect(r.httpPeers).toEqual(peers);
    expect(r.revoked).toEqual([]);
    expect(principals.every((p) => !p.disabled)).toBe(true);
  });

  test("同一 host 不同端口 → 合并，出站取最新，旧地址标注不再用", () => {
    const peers: HttpPeer[] = [
      { name: "Cat", addedAt: at("01"), baseUrl: "http://100.3.3.3:3847", outToken: "old".padEnd(32, "x") },
      { name: "Cat-2", addedAt: at("05"), baseUrl: "http://100.3.3.3:13847", outToken: OUT },
    ];
    const [g] = planPeerTidy(peers, []);
    expect(g.skip).toBeUndefined();
    expect(g.outboundFrom).toBe("Cat-2");
    expect(g.desc).toContain("旧地址 http://100.3.3.3:3847 不再用");
    expect(mergedPeerRecord(g, peers)).toEqual({ name: "Cat", addedAt: at("01"), baseUrl: "http://100.3.3.3:13847", outToken: OUT });
  });

  test("实例 id 不同 → 不同的人，不动；只有一条有 id → 合并后带上", () => {
    const two: HttpPeer[] = [
      { name: "Dan", addedAt: at("01"), inTokenId: "tok_d1", instanceId: "iid1" },
      { name: "Dan-2", addedAt: at("02"), inTokenId: "tok_d2", instanceId: "iid2" },
    ];
    expect(planPeerTidy(two, [tok("tok_d1", "Dan", "01"), tok("tok_d2", "Dan-2", "02")])[0].skip).toContain("不同的 Claudestra 实例");
    const one: HttpPeer[] = [two[0], { ...two[1], instanceId: undefined }];
    const [g] = planPeerTidy(one, [tok("tok_d1", "Dan", "01"), tok("tok_d2", "Dan-2", "02")]);
    expect(g.instanceId).toBe("iid1");
    expect(g.keepToken).toBe("tok_d2");
    expect(g.revokeTokens).toEqual(["tok_d1"]);
  });

  test("死记录（两个方向都没有）：单条也要删", () => {
    const peers: HttpPeer[] = [
      { name: "Eve", addedAt: at("01"), inTokenId: "tok_revoked" },
      { name: "Fay", addedAt: at("01"), baseUrl: "http://100.4.4.4:3847", outToken: OUT },
    ];
    const plan = planPeerTidy(peers, []);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ finalName: "Eve", records: ["Eve"], revokeTokens: [] });
    expect(plan[0].desc).toBe("「Eve」两个方向都不通（他连不上你，你也连不上他），删掉");
    const r = applyPeerTidy(peers, [], plan);
    expect(r.httpPeers.map((p) => p.name)).toEqual(["Fay"]);
  });

  test("组里夹着死记录：一起并掉", () => {
    const peers: HttpPeer[] = [
      { name: "Gus", addedAt: at("01") },
      { name: "Gus-2", addedAt: at("02"), baseUrl: "http://100.5.5.5:3847", outToken: OUT },
    ];
    const [g] = planPeerTidy(peers, []);
    expect(g).toMatchObject({ finalName: "Gus", records: ["Gus", "Gus-2"], outboundFrom: "Gus-2" });
    expect(applyPeerTidy(peers, [], [g]).httpPeers).toEqual([
      { name: "Gus", addedAt: at("01"), baseUrl: "http://100.5.5.5:3847", outToken: OUT },
    ]);
  });

  test("停用的记录不动；基名被停用记录占着 → 用组里第一条的名字", () => {
    const peers: HttpPeer[] = [
      { name: "Hal", addedAt: at("01"), disabled: true },
      { name: "Hal-2", addedAt: at("02"), inTokenId: "tok_h2" },
      { name: "Hal-3", addedAt: at("03"), baseUrl: "http://100.6.6.6:3847", outToken: OUT },
    ];
    const [g] = planPeerTidy(peers, [tok("tok_h2", "Hal-2", "02")]);
    expect(g).toMatchObject({ finalName: "Hal-2", records: ["Hal-2", "Hal-3"], keepToken: "tok_h2" });
    const r = applyPeerTidy(peers, [], [g]);
    expect(r.httpPeers.map((p) => p.name)).toEqual(["Hal", "Hal-2"]);
    expect(r.httpPeers[0].disabled).toBe(true);
  });

  test("-10 排在 -9 后面（按数字不按字典序）", () => {
    const peers: HttpPeer[] = [
      { name: "Ivy-10", addedAt: at("03"), inTokenId: "tok_i10" },
      { name: "Ivy-9", addedAt: at("02"), baseUrl: "http://100.7.7.7:3847", outToken: OUT },
    ];
    const [g] = planPeerTidy(peers, [tok("tok_i10", "Ivy-10", "03")]);
    expect(g.records).toEqual(["Ivy-9", "Ivy-10"]);
    expect(g.desc).toStartWith("Ivy-9、-10 合成一张「Ivy」");
  });
});
