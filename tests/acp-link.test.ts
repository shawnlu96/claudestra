import { beforeAll, describe, expect, test } from "bun:test";
import { acpConfigOf, acpSetConfig, answerAcp, onAcpFrame } from "../src/bridge/acp-link.ts";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { startWatching, stopWatching } from "../src/bridge/jsonl-watcher.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";

// bridge 这一头：只认当前登记的那条连接；流式条目进 watcher 的推送模式；额度卡 / 权限卡的答案经宿主落地（不发键）

const CH = "local-acp-link";
const sockets = new Map<string, { sent: any[]; send(d: string): void }>();
const sock = (ch: string) => {
  const s = { sent: [] as any[], send: (d: string) => void s.sent.push(JSON.parse(d)) };
  sockets.set(ch, s);
  return s;
};
const discord = {} as any;
const CONFIG = [{ id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "sol" }, { value: "gpt-5.6-luna", name: "luna" }] }];
const who = { principal: "owner:self" };

beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), { deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any });
});

describe("onAcpFrame", () => {
  test("不是这个频道当前登记的连接发的帧：丢掉", async () => {
    sock(CH);
    const stranger = { sent: [] as any[], send: () => {} };
    await onAcpFrame({ type: "acp_config", channelId: CH, configOptions: CONFIG }, stranger, discord);
    expect(acpConfigOf(CH)).toEqual([]);
    await onAcpFrame({ type: "acp_config", channelId: CH, configOptions: CONFIG }, sockets.get(CH)!, discord);
    expect(acpConfigOf(CH).map((o) => o.currentValue)).toEqual(["gpt-5.6-sol"]);
  });

  test("流式条目进推送模式的 watcher：发 tool_start（sid 带 acp: 前缀，前端不拿 rollout 游标比）；回合末那批按 requestId 回包", async () => {
    const s = sock(CH);
    noteAcpChannel(CH, "acp");
    await startWatching("agent-acp-link", "/w", "019a-sid", CH, discord, { runtime: "codex" });
    const events: any[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === CH && events.push(e)));
    try {
      const entries = [{ type: "assistant", timestamp: "t", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } }];
      await onAcpFrame({ type: "acp_entries", channelId: CH, entries, requestId: "acphost_1" }, s, discord);
      const start = events.find((e) => e.type === "tool_start");
      expect(start?.data).toMatchObject({ toolId: "c1", name: "Bash", sid: "acp:019a-sid" });
      expect(s.sent.find((f) => f.requestId === "acphost_1")).toEqual({ type: "response", requestId: "acphost_1", result: true });
    } finally {
      unsub();
      stopWatching("agent-acp-link");
    }
  });
});

describe("额度卡：先「等重置」、只列其它模型、owner 点了才经宿主改", () => {
  test("切到某模型 → 宿主收到 set_config_option；等重置 → 什么都不改；过期的按钮 409", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_failure", channelId: CH, failure: { kind: "quota", key: "air:t1", message: "You've hit your usage limit." }, configOptions: CONFIG }, s, discord);
    const pending = answerAcp(CH, "acp_quota_1", who);
    await new Promise((r) => setTimeout(r, 0));
    const call = s.sent.find((f) => f.type === "acp_call");
    expect(call).toMatchObject({ op: "set_config", configId: "model", value: "gpt-5.6-luna" });
    await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ok: true, configOptions: CONFIG }, s, discord);
    expect(await pending).toEqual({ status: 200, body: { ok: true, model: "gpt-5.6-luna" } });
    expect((await answerAcp(CH, "acp_quota_1", who)).status).toBe(409);

    await onAcpFrame({ type: "acp_failure", channelId: CH, failure: { kind: "quota", key: "air:t2", message: "limit" }, configOptions: CONFIG }, s, discord);
    const before = s.sent.length;
    expect(await answerAcp(CH, "acp_quota_0", who)).toEqual({ status: 200, body: { ok: true, model: null } });
    expect(s.sent.length).toBe(before);
  });

  test("宿主拒了（选项不对等）→ 409 带原因，卡不结", async () => {
    const s = sock(CH);
    await onAcpFrame({ type: "acp_failure", channelId: CH, failure: { kind: "quota", key: "air:t3", message: "limit" }, configOptions: CONFIG }, s, discord);
    const pending = answerAcp(CH, "acp_quota_1", who);
    await new Promise((r) => setTimeout(r, 0));
    const call = s.sent.filter((f) => f.type === "acp_call").at(-1);
    await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ok: false, error: "Invalid params" }, s, discord);
    expect(await pending).toMatchObject({ status: 409, body: { error: expect.stringContaining("Invalid params") } });
  });
});

describe("权限卡与离线", () => {
  test("点了卡上的选项 → 按 requestId 回给宿主；不在卡上的 → 409", async () => {
    const s = sock(CH);
    const options = [{ id: "allow_once", label: "Allow", style: "success" }, { id: "decline", label: "Decline", style: "danger" }];
    const card = { toolCallId: "c9", title: "Codex 请求授权：rm", detail: "rm -rf x", mcp: false, options };
    await onAcpFrame({ type: "acp_permission", channelId: CH, requestId: "acphost_9", card }, s, discord);
    expect((await answerAcp(CH, "acp_perm_bogus", who)).status).toBe(409);
    expect(await answerAcp(CH, "acp_perm_decline", who)).toEqual({ status: 200, body: { ok: true } });
    expect(s.sent.find((f) => f.requestId === "acphost_9")).toEqual({ type: "response", requestId: "acphost_9", result: { optionId: "decline" } });
    expect((await answerAcp(CH, "acp_perm_decline", who)).status).toBe(409);
  });

  test("宿主不在线：改配置直接失败，不挂着", async () => {
    expect(await acpSetConfig("local-nobody", "model", "x")).toEqual({ ok: false, error: "ACP 宿主不在线" });
    expect((await answerAcp(CH, "whatever", who)).status).toBe(400);
  });
});
