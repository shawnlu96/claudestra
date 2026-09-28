import { describe, expect, test } from "bun:test";
import { configuredPeerIngressPort, ingressApiPath, ingressHost, ingressSecret, ingressVerdict, ingressRequest } from "../src/bridge/peer-ingress";
import { RELAY_MARK_HEADER, relayMark, takeRelayFrom } from "../src/bridge/relay-inbound";
import { relaySenderFp } from "../src/bridge/api-auth";
import { setRequestContext } from "../src/bridge/request-context";
import { pickIngressPort } from "../src/lib/peer-ingress-config";

describe("来源指纹只认经中继进来的（relay-inbound 盖进程内标记，peer 入口验，结果只经请求上下文往下传）", () => {
  const FROM = "x-claudestra-relay-from";
  const FP = "16f9-b5d1-30fb-8923";
  test("标记对得上：返回指纹；两个头都从请求里删掉，其余头不动", () => {
    const h = new Headers({ [FROM]: FP, [RELAY_MARK_HEADER]: "m1", authorization: "Bearer t" });
    expect(takeRelayFrom(h, "m1")).toBe(FP);
    expect(h.get(FROM)).toBeNull();
    expect(h.get(RELAY_MARK_HEADER)).toBeNull();
    expect(h.get("authorization")).toBe("Bearer t");
  });
  test("没有标记 / 标记不对：直连 peer 伪造的指纹不认，头也剥掉", () => {
    const spoof = new Headers({ [FROM]: "dead-beef-dead-beef" });
    expect(takeRelayFrom(spoof, "m1")).toBeNull();
    expect(spoof.get(FROM)).toBeNull();
    const wrong = new Headers({ [FROM]: "dead-beef-dead-beef", [RELAY_MARK_HEADER]: "guess" });
    expect(takeRelayFrom(wrong, "m1")).toBeNull();
    expect(wrong.get(FROM)).toBeNull();
    expect(wrong.get(RELAY_MARK_HEADER)).toBeNull();
  });
  test("兑换读发件人只看请求上下文：主端口 / 旧 web 端口进来的请求带着伪造头也读不出来", () => {
    const forged = new Request("http://127.0.0.1:3847/api/v1/peers/redeem", { method: "POST", headers: { [FROM]: FP } });
    setRequestContext(forged, { source: "loopback", clientIp: "127.0.0.1", https: false });
    expect(relaySenderFp(forged)).toBe("");
    expect(relaySenderFp(new Request("http://x/", { headers: { [FROM]: FP } }))).toBe("");
    const viaIngress = new Request("http://ingress.local/api/v1/peers/redeem", { method: "POST" });
    setRequestContext(viaIngress, { source: "lan", clientIp: null, https: false, relayFrom: FP });
    expect(relaySenderFp(viaIngress)).toBe(FP);
    const junk = new Request("http://ingress.local/api/v1/peers/redeem", { method: "POST" });
    setRequestContext(junk, { source: "lan", clientIp: null, https: false, relayFrom: "not-a-fingerprint" });
    expect(relaySenderFp(junk)).toBe("");
  });
  test("peer 入口：带对的标记 → 处理函数从上下文拿到指纹、看不到原始头；伪造的 → 没有指纹", async () => {
    const seen: { fp: string; raw: string | null; mark: string | null }[] = [];
    const api = async (req: Request) => {
      seen.push({ fp: relaySenderFp(req), raw: req.headers.get(FROM), mark: req.headers.get(RELAY_MARK_HEADER) });
      return new Response("{}");
    };
    const post = (headers: Record<string, string>) => ingressRequest(new Request("http://127.0.0.1:1/api/v1/peers/redeem", { method: "POST", headers, body: "{}" }), api);
    await post({ [FROM]: FP, [RELAY_MARK_HEADER]: relayMark() });
    await post({ [FROM]: FP });
    await post({ [FROM]: FP, [RELAY_MARK_HEADER]: "guess" });
    expect(seen).toEqual([{ fp: FP, raw: null, mark: null }, { fp: "", raw: null, mark: null }, { fp: "", raw: null, mark: null }]);
  });
  test("进程内标记：足够长、进程内稳定", () => {
    expect(relayMark()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(relayMark()).toBe(relayMark());
  });
});

describe("peer 入口（HTTPS 反代 → 回环上的 peer 专用端口）", () => {
  test("端口只认 .env 显式配置：没配就不开（升级不凭空多占端口、不随 BRIDGE_PORT 漂）", () => {
    expect(configuredPeerIngressPort({})).toBeNull();
    expect(configuredPeerIngressPort({ PEER_INGRESS_PORT: "3848" })).toBe(3848);
    expect(configuredPeerIngressPort({ PEER_INGRESS_PORT: "abc" })).toBeNull();
    expect(configuredPeerIngressPort({ PEER_INGRESS_PORT: "70000" })).toBeNull();
  });

  test("setup 选端口：从 bridge 端口 + 1 起跳过被占的和网页端口（自定义 bridge 端口同理）", () => {
    expect(pickIngressPort(3847, () => false)).toBe(3848);
    expect(pickIngressPort(3847, (p) => p === 3848)).toBe(3849);
    expect(pickIngressPort(3332, () => false, 3333)).toBe(3334); // bridge 端口 + 1 正好是网页端口
    expect(pickIngressPort(4000, () => true)).toBeNull();
  });

  test("路径：反代保留前缀原样用，剥掉前缀的补回来——入口只可能落到 /api/v1 路由上", () => {
    expect(ingressApiPath("/api/v1/agents")).toBe("/api/v1/agents");
    expect(ingressApiPath("/agents")).toBe("/api/v1/agents");
    expect(ingressApiPath("/")).toBe("/api/v1");
    // /api/v1/../../hook 规整后是 /hook：主端口上这是控制面；在这个入口上只会变成一条不存在的 API 路由
    expect(ingressApiPath(new URL("http://x/api/v1/../../hook").pathname)).toBe("/api/v1/hook");
  });

  test("凭据：Bearer 或 GET /events 的 ?token=（与 authApi 同口径，防止用 query 绕过 peer 检查）", () => {
    const req = (h: Record<string, string>, method = "GET") => ({ method, headers: { get: (k: string) => h[k] ?? null } });
    expect(ingressSecret(req({ Authorization: "Bearer abc" }), new URL("http://x/api/v1/agents"))).toBe("abc");
    expect(ingressSecret(req({}), new URL("http://x/api/v1/events?token=q"))).toBe("q");
    expect(ingressSecret(req({}), new URL("http://x/api/v1/agents?token=q"))).toBe("");
  });

  test("判定：带凭据必须是 peer token；没带交给 API（兑换邀请或 401）", () => {
    expect(ingressVerdict("", null)).toBe("ok");
    expect(ingressVerdict("s", { peer: "HedeMacBook-Pro" })).toBe("ok");
    expect(ingressVerdict("s", {})).toBe("not-peer"); // 网页用的全权 token
    expect(ingressVerdict("s", null)).toBe("not-peer"); // 无效 token
  });

  test("开在哪：默认只听本机；标了直连且有 peer（或刚 hold）才对外，peer 全没了退回本机", () => {
    const now = 1_000_000;
    expect(ingressHost(false, true, now + 1, now)).toBe("127.0.0.1"); // 没标直连（HTTPS 反代的机器）：永远只听本机
    expect(ingressHost(true, true, 0, now)).toBe("0.0.0.0");
    expect(ingressHost(true, false, now + 1, now)).toBe("0.0.0.0"); // 邀请 token 还没签出来，hold 顶住
    expect(ingressHost(true, false, now - 1, now)).toBe("127.0.0.1"); // hold 过期又没有 peer
  });
});

import { portBusy } from "../src/lib/peer-ingress-config";

describe("portBusy：lsof 优先，lsof 不可用退回连接探测", () => {
  test("lsof 有结果就以它为准，连接探测不参与", () => {
    expect(portBusy([{ command: "bun", addr: "127.0.0.1:3848" }], false)).toBe(true);
    expect(portBusy([], true)).toBe(false);
  });
  test("lsof 不可用（null）时看连接探测", () => {
    expect(portBusy(null, true)).toBe(true);
    expect(portBusy(null, false)).toBe(false);
  });
});
