/**
 * channel-server 该连哪个 bridge（v2.24+）。
 *
 * 由来是一个静默到离谱的 bug（2026-09-22 试装现场）：setup 把端口写成
 * `BRIDGE_PORT=13847`，但 `BRIDGE_URL` 从不写，而六个地方各自兜底成写死的
 * `ws://localhost:3847`。于是 bridge 在 13847 上跑得好好的（HTTP、用量抓取、
 * 归档全正常），每个 channel-server 却都去连 3847 —— 连不上也不报错（按设计
 * 指数退避重连），结果是网页上大总管和所有 agent 永远 offline，日志里没有一行
 * 说「我连错端口了」。
 */
import { describe, test, expect } from "bun:test";
import { DEFAULT_BRIDGE_PORT, bridgeUrlPortMismatch, resolveBridgeUrl } from "../src/lib/bridge-url.js";

describe("resolveBridgeUrl", () => {
  test("显式 BRIDGE_URL 优先——跨机场景要指向远程 bridge", () => {
    expect(resolveBridgeUrl({ BRIDGE_URL: "ws://10.0.0.2:9999", BRIDGE_PORT: "3847" }))
      .toBe("ws://10.0.0.2:9999");
  });

  test("没有 BRIDGE_URL 就从 BRIDGE_PORT 推（这正是当初漏掉的一步）", () => {
    expect(resolveBridgeUrl({ BRIDGE_PORT: "13847" })).toBe("ws://localhost:13847");
  });

  test("两者都没有才回默认端口", () => {
    expect(resolveBridgeUrl({})).toBe(`ws://localhost:${DEFAULT_BRIDGE_PORT}`);
  });

  test("BRIDGE_PORT 是垃圾值时回默认，不产出 ws://localhost:NaN", () => {
    expect(resolveBridgeUrl({ BRIDGE_PORT: "abc" })).toBe("ws://localhost:3847");
    expect(resolveBridgeUrl({ BRIDGE_PORT: "0" })).toBe("ws://localhost:3847");
    expect(resolveBridgeUrl({ BRIDGE_PORT: "99999" })).toBe("ws://localhost:3847");
  });

  test("空字符串的 BRIDGE_URL 不算显式指定", () => {
    expect(resolveBridgeUrl({ BRIDGE_URL: "   ", BRIDGE_PORT: "13847" })).toBe("ws://localhost:13847");
  });
});

describe("bridgeUrlPortMismatch", () => {
  test("显式 URL 的端口跟 BRIDGE_PORT 对不上 → 报出来（体检用）", () => {
    const msg = bridgeUrlPortMismatch({ BRIDGE_URL: "ws://localhost:3847", BRIDGE_PORT: "13847" });
    expect(msg).toContain("3847");
    expect(msg).toContain("13847");
  });

  test("对得上 / 没显式设 / 解析不出端口 → null", () => {
    expect(bridgeUrlPortMismatch({ BRIDGE_URL: "ws://localhost:13847", BRIDGE_PORT: "13847" })).toBeNull();
    expect(bridgeUrlPortMismatch({ BRIDGE_PORT: "13847" })).toBeNull();
    expect(bridgeUrlPortMismatch({ BRIDGE_URL: "ws://localhost", BRIDGE_PORT: "13847" })).toBeNull();
  });
});
