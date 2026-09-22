import { test, expect, describe } from "bun:test";
import { bridgeDrift, bridgeHttpBase, bridgeHttpUrlOf, bridgePortOf, parseTmuxEnvLine } from "../src/lib/bridge-port";
import { buildClaudeCommand } from "../src/lib/claude-launch";
import { buildPiCommand } from "../src/lib/pi-launch";

describe("bridge 端口派生", () => {
  test("bridgePortOf：显式端口 / 协议默认 / 解析失败", () => {
    expect(bridgePortOf("ws://localhost:13847")).toBe(13847);
    expect(bridgePortOf("wss://bridge.example")).toBe(443);
    expect(bridgePortOf("not a url")).toBeNull();
  });

  test("hook 的 HTTP 基址：BRIDGE_URL 优先于（可能停在旧值的）BRIDGE_PORT", () => {
    expect(bridgeHttpBase({ BRIDGE_URL: "ws://localhost:13847", BRIDGE_PORT: "3847" })).toBe("http://127.0.0.1:13847");
    expect(bridgeHttpBase({ BRIDGE_PORT: "4000" })).toBe("http://127.0.0.1:4000");
    expect(bridgeHttpBase({})).toBe("http://127.0.0.1:3847");
  });

  test("探活地址保留远程主机", () => {
    expect(bridgeHttpUrlOf("ws://mac-mini:3847/")).toBe("http://mac-mini:3847");
    expect(bridgeHttpUrlOf("wss://b.example:8443")).toBe("https://b.example:8443");
  });

  test("启动命令显式带 BRIDGE_PORT，且与 BRIDGE_URL 端口一致", () => {
    const cc = buildClaudeCommand({ channelId: "1", bridgeUrl: "ws://localhost:13847" });
    expect(cc).toContain("BRIDGE_URL=ws://localhost:13847 BRIDGE_PORT=13847 ");
    const pi = buildPiCommand({ channelId: "1", bridgeUrl: "ws://localhost:13847", agentName: "a" });
    expect(pi).toContain("BRIDGE_PORT=13847 ");
  });
});

describe("bridgeDrift（launcher / doctor 判定会话是否连着旧地址）", () => {
  test("端口变了 → 漂移", () => {
    expect(bridgeDrift({ BRIDGE_PORT: "3847" }, "ws://localhost:13847")).toEqual({
      from: "ws://localhost:3847",
      to: "ws://localhost:13847",
    });
  });
  test("tmux 里什么都没有 = 默认 3847；当前也是默认 → 不漂移", () => {
    expect(bridgeDrift({}, "ws://localhost:3847")).toBeNull();
  });
  test("localhost 与 127.0.0.1 写法差异不算漂移（否则白白全员重启）", () => {
    expect(bridgeDrift({ BRIDGE_URL: "ws://127.0.0.1:3847" }, "ws://localhost:3847")).toBeNull();
  });
  test("显式 BRIDGE_URL 优先于 BRIDGE_PORT", () => {
    expect(bridgeDrift({ BRIDGE_URL: "ws://localhost:13847", BRIDGE_PORT: "3847" }, "ws://localhost:13847")).toBeNull();
  });
  test("换了远程主机 → 漂移；解析不了的当前值不动", () => {
    expect(bridgeDrift({ BRIDGE_PORT: "3847" }, "ws://mac-mini:3847")).not.toBeNull();
    expect(bridgeDrift({ BRIDGE_PORT: "3847" }, "garbage")).toBeNull();
  });
  test("解析 tmux show-environment 输出：已 unset 的（-NAME）视为没有", () => {
    const out = "HOME=/Users/x\n-BRIDGE_URL\nBRIDGE_PORT=13847\nPATH=/usr/bin";
    expect(parseTmuxEnvLine(out, "BRIDGE_PORT")).toBe("13847");
    expect(parseTmuxEnvLine(out, "BRIDGE_URL")).toBeUndefined();
  });
});
