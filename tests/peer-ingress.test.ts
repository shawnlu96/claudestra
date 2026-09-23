import { describe, expect, test } from "bun:test";
import { configuredPeerIngressPort, ingressApiPath, ingressSecret, ingressVerdict } from "../src/bridge/peer-ingress";
import { pickIngressPort } from "../src/lib/peer-ingress-config";

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
});
