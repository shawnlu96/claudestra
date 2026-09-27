import { describe, expect, test } from "bun:test";
import { envSnippet, fmtRemaining, relayMode, remainingSeconds } from "@/features/chat/relay-card-logic";

describe("Peer 面板「中继」卡的纯逻辑", () => {
  test("状态归类：读不到 / 没配 / 连接中 / 在线", () => {
    expect(relayMode(null)).toBe("unknown");
    expect(relayMode({ ok: false, error: "bridge 404" })).toBe("unknown");
    expect(relayMode({ ok: true, enabled: false })).toBe("off");
    expect(relayMode({ ok: true, enabled: true, connected: false, state: "offline" })).toBe("connecting");
    expect(relayMode({ ok: true, enabled: true, connected: true, url: null })).toBe("connecting"); // 连着但 welcome 还没到
    expect(relayMode({ ok: true, enabled: true, connected: true, url: "https://mini.relay.example.com" })).toBe("online");
  });

  test(".env 示例：知道中继地址 / 名字就填进去，否则给占位", () => {
    expect(envSnippet(null, null)).toBe("RELAY_URL=wss://relay.example.com\nRELAY_NAME=my-mac");
    expect(envSnippet("wss://relay.acme.io", "mini")).toBe("RELAY_URL=wss://relay.acme.io\nRELAY_NAME=mini");
  });

  test("倒计时：向上取整到秒，过期归零，坏时间当已过期", () => {
    const now = Date.parse("2026-09-27T00:00:00.000Z");
    expect(remainingSeconds("2026-09-27T00:09:59.400Z", now)).toBe(600);
    expect(remainingSeconds("2026-09-26T23:59:59.000Z", now)).toBe(0);
    expect(remainingSeconds("not a date", now)).toBe(0);
    expect(fmtRemaining(598, "zh")).toBe("9 分 58 秒");
    expect(fmtRemaining(598, "en")).toBe("9m 58s");
    expect(fmtRemaining(42, "zh")).toBe("42 秒");
    expect(fmtRemaining(42, "en")).toBe("42s");
  });
});
