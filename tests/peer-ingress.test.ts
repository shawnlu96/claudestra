import { describe, expect, test } from "bun:test";
import { configuredPeerIngressPort, ingressApiPath, ingressHost, ingressSecret, ingressVerdict } from "../src/bridge/peer-ingress";
import { RELAY_MARK_HEADER, relayMark, sanitizeRelayFrom } from "../src/bridge/relay-inbound";
import { pickIngressPort } from "../src/lib/peer-ingress-config";

describe("来源指纹头只认经中继进来的（relay-inbound 盖进程内标记，peer 入口验）", () => {
  const FROM = "x-claudestra-relay-from";
  test("标记对得上：保留指纹头、去掉标记头", () => {
    const h = new Headers({ [FROM]: "16f9-b5d1-30fb-8923", [RELAY_MARK_HEADER]: "m1", authorization: "Bearer t" });
    expect(sanitizeRelayFrom(h, "m1")).toBe(true);
    expect(h.get(FROM)).toBe("16f9-b5d1-30fb-8923");
    expect(h.get(RELAY_MARK_HEADER)).toBeNull();
    expect(h.get("authorization")).toBe("Bearer t");
  });
  test("没有标记 / 标记不对：直连 peer 伪造的指纹头被剥掉，标记头也不往 API 传", () => {
    const spoof = new Headers({ [FROM]: "dead-beef-dead-beef" });
    expect(sanitizeRelayFrom(spoof, "m1")).toBe(false);
    expect(spoof.get(FROM)).toBeNull();
    const wrong = new Headers({ [FROM]: "dead-beef-dead-beef", [RELAY_MARK_HEADER]: "guess" });
    expect(sanitizeRelayFrom(wrong, "m1")).toBe(false);
    expect(wrong.get(FROM)).toBeNull();
    expect(wrong.get(RELAY_MARK_HEADER)).toBeNull();
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
