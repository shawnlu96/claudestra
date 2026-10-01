/**
 * Pi 适配器的 /compact：pi 的 rpc prompt 不认内置命令（沙箱 e2e 实测，模型收到的是一句「/compact」），适配器把整条 `/compact [指示]`
 * 换成 rpc compact；回一句压缩结果；没压成（会话太短）也只回一句话、照常结束；session/cancel 的 abort 让它以 cancelled 收尾。
 * 带 <channel> 头的普通消息、句中的 /compact 不拦。
 */
import { describe, expect, test } from "bun:test";
import { compactCommand, compactNotice } from "../src/lib/acp/pi-adapter/map.ts";
import type { PiLink } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import { createRpcPeer, type RpcWire } from "../src/lib/acp/rpc.ts";

type Rec = Record<string, any>;

describe("compactCommand / compactNotice", () => {
  test("整条是 /compact 才算，指示原样带上；普通消息、句中提到的不算", () => {
    expect(compactCommand("/compact")).toEqual({ type: "compact" });
    expect(compactCommand("  /compact  只留结论\n和待办 ")).toEqual({ type: "compact", customInstructions: "只留结论\n和待办" });
    for (const t of ["/compacting", "<channel>/compact</channel>", "请 /compact 一下", "/clear"]) expect(compactCommand(t), t).toBeNull();
  });

  test("回包 → 一句话；失败原因 → 一句话", () => {
    expect(compactNotice({ tokensBefore: 13521, estimatedTokensAfter: 9326 }).content.text).toBe("上下文已压缩：13521 → 约 9326 tokens");
    expect(compactNotice({}).content.text).toBe("上下文已压缩");
    expect(compactNotice(null, "pi compact 失败：Nothing to compact").content.text).toBe("上下文没有压缩：pi compact 失败：Nothing to compact");
  });
});

/** 内存里的一对 RpcWire */
function pipePair(): [RpcWire, RpcWire] {
  const side = () => ({ data: (_: string) => {}, close: (_: string) => {} });
  const a = side(), b = side();
  const wire = (me: ReturnType<typeof side>, peer: ReturnType<typeof side>): RpcWire => ({
    write: (line) => peer.data(line), onData: (cb) => void (me.data = cb as (c: string) => void), onClose: (cb) => void (me.close = cb),
    close: (why) => (peer.close(why), me.close(why)),
  });
  return [wire(a, b), wire(b, a)];
}

/** 假 pi：记下每条命令；compact 的结局由 onCompact 决定 */
function harness(onCompact: () => Promise<unknown>) {
  const sent: Rec[] = [];
  const link: PiLink = {
    async command(cmd) {
      sent.push(cmd);
      if (cmd.type === "compact") return onCompact();
      if (cmd.type === "prompt") return { disposition: "handled" };
      return cmd.type === "get_state" ? { thinkingLevel: "off" } : {};
    },
    send: () => {}, onRecord: () => {}, onExit: () => {}, stop: () => {}, exited: Promise.resolve(0),
  };
  const [host, adapter] = pipePair();
  new PiAcpServer(adapter, { openPi: () => link, newSessionId: () => "sid", log: () => {}, exit: () => {} });
  const updates: Rec[] = [];
  const rpc = createRpcPeer(host, { log: () => {} });
  rpc.onNotification("session/update", (p: Rec) => void updates.push(p.update));
  const prompt = (text: string) => rpc.request("session/prompt", { sessionId: "sid", prompt: [{ type: "text", text }] }, { timeoutMs: 5_000 });
  return { rpc, sent, updates, prompt, open: () => rpc.request("session/new", { cwd: "/w", mcpServers: [] }, { timeoutMs: 5_000 }) };
}

const texts = (updates: Rec[]) => updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text);

describe("PiAcpServer 的 /compact", () => {
  test("换成 rpc compact（不发 prompt），回一句结果，end_turn", async () => {
    const h = harness(async () => ({ tokensBefore: 100, estimatedTokensAfter: 40 }));
    await h.open();
    expect(await h.prompt("/compact 只留结论")).toEqual({ stopReason: "end_turn" });
    expect(h.sent.filter((c) => c.type === "compact" || c.type === "prompt")).toEqual([{ type: "compact", customInstructions: "只留结论" }]);
    expect(texts(h.updates)).toEqual(["上下文已压缩：100 → 约 40 tokens"]);
    expect(await h.prompt("你好")).toEqual({ stopReason: "end_turn" }); // 普通消息照常走 prompt
    expect(h.sent.filter((c) => c.type === "prompt")).toMatchObject([{ message: "你好" }]);
  });

  test("没压成：回一句原因、照常 end_turn，不当回合失败", async () => {
    const h = harness(async () => { throw new Error("pi compact 失败：Nothing to compact (session too small)"); });
    await h.open();
    expect(await h.prompt("/compact")).toEqual({ stopReason: "end_turn" });
    expect(texts(h.updates)).toEqual(["上下文没有压缩：pi compact 失败：Nothing to compact (session too small)"]);
  });

  test("压缩中 session/cancel：发 abort，以 cancelled 收尾", async () => {
    let fail!: (e: Error) => void;
    const h = harness(() => new Promise((_, reject) => (fail = reject)));
    await h.open();
    const turn = h.prompt("/compact");
    while (!fail) await Bun.sleep(1);
    h.rpc.notify("session/cancel", { sessionId: "sid" });
    while (!h.sent.some((c) => c.type === "abort")) await Bun.sleep(1);
    fail(new Error("Compaction cancelled"));
    expect(await turn).toEqual({ stopReason: "cancelled" });
  });
});
