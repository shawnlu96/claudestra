/**
 * router.ts 的纯逻辑测试（parseAddress / formatAddress / newThreadId /
 * endpointLabel / envelopeLabel / makeResponseEnvelope）。
 *
 * deliver() / renderContentForLocal 依赖 discord client + peers.json + ws 等
 * 外部状态，只做 smoke 测试，不在这里 mock。整体 bridge 行为用 E2E + live 验
 * 证。
 */

import { describe, test, expect } from "bun:test";
import {
  parseAddress,
  formatAddress,
  newThreadId,
  endpointLabel,
  envelopeLabel,
  makeResponseEnvelope,
  type Envelope,
  type UserEndpoint,
  type PeerEndpoint,
  type LocalEndpoint,
} from "../src/bridge/router.ts";

describe("parseAddress", () => {
  test("peer:X 形式", () => {
    expect(parseAddress("peer:claudestra_ahh")).toEqual({
      kind: "peer",
      primary: "claudestra_ahh",
    });
  });

  test("peer:X.Y 形式", () => {
    expect(parseAddress("peer:claudestra_ahh.future_data")).toEqual({
      kind: "peer",
      primary: "claudestra_ahh",
      secondary: "future_data",
    });
  });

  test("Y@X 短格式（peer 语法糖）", () => {
    expect(parseAddress("future_data@claudestra_ahh")).toEqual({
      kind: "peer",
      primary: "claudestra_ahh",
      secondary: "future_data",
    });
  });

  test("user:<id>", () => {
    expect(parseAddress("user:535144625355096076")).toEqual({
      kind: "user",
      primary: "535144625355096076",
    });
  });

  test("agent:<name>", () => {
    expect(parseAddress("agent:future_data")).toEqual({
      kind: "agent",
      primary: "future_data",
    });
  });

  test("channel:<id> escape hatch", () => {
    expect(parseAddress("channel:1495997330061791353")).toEqual({
      kind: "channel",
      primary: "1495997330061791353",
    });
  });

  test("无前缀 → 按 v1.x 兼容当 agent", () => {
    expect(parseAddress("future_data")).toEqual({
      kind: "agent",
      primary: "future_data",
    });
  });

  test("空串返回 null", () => {
    expect(parseAddress("")).toBeNull();
    expect(parseAddress("   ")).toBeNull();
  });

  test("trim 前后空白", () => {
    expect(parseAddress("  agent:foo  ")).toEqual({
      kind: "agent",
      primary: "foo",
    });
  });

  test("peer:X 跟 user:X / agent:X 互不混淆", () => {
    expect(parseAddress("peer:foo")?.kind).toBe("peer");
    expect(parseAddress("user:foo")?.kind).toBe("user");
    expect(parseAddress("agent:foo")?.kind).toBe("agent");
    expect(parseAddress("channel:foo")?.kind).toBe("channel");
  });

  test("带 : 的 address 不会被误解析成短格式 Y@X", () => {
    // `agent:foo@bar` 里有 :，不走短格式分支，按 agent 前缀解析
    expect(parseAddress("agent:foo@bar")).toEqual({
      kind: "agent",
      primary: "foo@bar",
    });
  });
});

describe("formatAddress (parseAddress 的逆)", () => {
  test("round-trip user/agent/channel/peer 四种 kind", () => {
    const cases: Array<string> = [
      "user:535144625355096076",
      "agent:future_data",
      "channel:1495997330061791353",
      "peer:claudestra_ahh",
      "peer:claudestra_ahh.future_data",
    ];
    for (const addr of cases) {
      const parsed = parseAddress(addr);
      expect(parsed).not.toBeNull();
      expect(formatAddress(parsed!)).toBe(addr);
    }
  });

  test("短格式 Y@X 正规化成 peer:X.Y", () => {
    const parsed = parseAddress("future_data@claudestra_ahh");
    expect(formatAddress(parsed!)).toBe("peer:claudestra_ahh.future_data");
  });
});

describe("newThreadId", () => {
  test("前缀固定 thr_", () => {
    expect(newThreadId().startsWith("thr_")).toBe(true);
  });

  test("多次调用互不相同", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newThreadId()));
    expect(ids.size).toBe(100);
  });

  test("格式 thr_<ts>_<rand>", () => {
    const id = newThreadId();
    expect(id).toMatch(/^thr_\d+_[a-z0-9]+$/);
  });
});

describe("endpointLabel", () => {
  test("local endpoint", () => {
    const ep: LocalEndpoint = {
      kind: "local",
      agentName: "agent-foo",
      channelId: "12345",
      ws: {} as any,
    };
    expect(endpointLabel(ep)).toBe("local:agent-foo(12345)");
  });

  test("local endpoint 没 agentName 打 ?", () => {
    const ep: LocalEndpoint = {
      kind: "local",
      channelId: "12345",
      ws: {} as any,
    };
    expect(endpointLabel(ep)).toBe("local:?(12345)");
  });

  test("peer endpoint，无 agent name", () => {
    const ep: PeerEndpoint = {
      kind: "peer",
      peerBotId: "111",
      peerBotName: "claudestra_ahh",
      sharedChannelId: "222",
    };
    expect(endpointLabel(ep)).toBe("peer:claudestra_ahh");
  });

  test("peer endpoint 带 agent name", () => {
    const ep: PeerEndpoint = {
      kind: "peer",
      peerBotId: "111",
      peerBotName: "claudestra_ahh",
      sharedChannelId: "222",
      peerAgentName: "future_data",
    };
    expect(endpointLabel(ep)).toBe("peer:claudestra_ahh.future_data");
  });

  test("user endpoint", () => {
    const ep: UserEndpoint = {
      kind: "user",
      userId: "u1",
      channelId: "c1",
    };
    expect(endpointLabel(ep)).toBe("user:u1@c1");
  });

  test("bridge endpoint 带 label", () => {
    expect(endpointLabel({ kind: "bridge", label: "notifyMaster" })).toBe("bridge:notifyMaster");
  });

  test("bridge endpoint 无 label 打 ?", () => {
    expect(endpointLabel({ kind: "bridge" })).toBe("bridge:?");
  });
});

describe("envelopeLabel", () => {
  test("格式：from → to [intent]", () => {
    const env: Envelope = {
      from: { kind: "user", userId: "u1", channelId: "c1" },
      to: { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      intent: "request",
      content: "hi",
      meta: {
        messageId: "m1",
        triggerKind: "user_discord",
        ts: "2026-04-22T00:00:00Z",
        threadId: "thr_1_aaa",
      },
    };
    expect(envelopeLabel(env)).toBe("user:u1@c1 → local:a1(c2) [request]");
  });
});

describe("makeResponseEnvelope", () => {
  const request: Envelope = {
    from: { kind: "user", userId: "u1", channelId: "c1" },
    to: { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
    intent: "request",
    content: "what's up",
    meta: {
      messageId: "msg_orig",
      triggerKind: "user_discord",
      ts: "2026-04-22T00:00:00Z",
      threadId: "thr_orig",
    },
  };

  test("继承 threadId + inReplyTo=请求的 messageId", () => {
    const resp = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "here you go",
    );
    expect(resp.intent).toBe("response");
    expect(resp.meta.threadId).toBe("thr_orig");
    expect(resp.meta.inReplyTo).toBe("msg_orig");
    expect(resp.content).toBe("here you go");
  });

  test("默认 triggerKind=bridge_synth，可覆盖", () => {
    const resp1 = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "x",
    );
    expect(resp1.meta.triggerKind).toBe("bridge_synth");

    const resp2 = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "x",
      { triggerKind: "agent_tool" },
    );
    expect(resp2.meta.triggerKind).toBe("agent_tool");
  });

  test("final / attachments 通过 opts 传入", () => {
    const resp = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "end",
      { final: true, attachments: ["/tmp/foo.png"] },
    );
    expect(resp.meta.final).toBe(true);
    expect(resp.meta.attachments).toEqual(["/tmp/foo.png"]);
  });

  test("没传 messageId 自动生成 synth_ 前缀", () => {
    const resp = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "x",
    );
    expect(resp.meta.messageId.startsWith("synth_")).toBe(true);
  });

  test("传了 messageId 就用传入的", () => {
    const resp = makeResponseEnvelope(
      request,
      { kind: "local", agentName: "a1", channelId: "c2", ws: {} as any },
      { kind: "user", userId: "u1", channelId: "c1" },
      "x",
      { messageId: "my_msg_id" },
    );
    expect(resp.meta.messageId).toBe("my_msg_id");
  });
});
