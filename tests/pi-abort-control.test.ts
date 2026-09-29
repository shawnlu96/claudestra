/**
 * src/pi/abort-control.ts（Pi 扩展里 bridge 叫停的那一段）与 bridge/pi-abort.ts 的回显文案。对抗式第 3 轮 P1-B + PM 的修法：
 * 停之后，已经 steer 进去、还没执行的消息一律作废，回执列出来，bridge 回显给发送方；TUI 下 Pi 退回输入框的不清（终端里的人可能在打字），
 * 回执报几条，⏹ 抬头里写明。
 * 行为在真 Pi 0.85.1 + 假模型上对照过（TUI 与 --mode rpc），见 docs/architecture/interrupts.md「Pi」。
 */
import { describe, expect, test } from "bun:test";
import { createAbortControl, type AbortableCtx } from "../src/pi/abort-control.js";
import {
  extensionAbort, onAbortAck, onCodexUndelivered, setAbortCapable, setExtensionSocket, stopAfterAbort, voidedEchoTo, voidedNotice,
} from "../src/bridge/pi-abort.js";
import type { Envelope } from "../src/bridge/router.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import { stopHeadline } from "../src/lib/turn-cuts.js";

/** 模拟 Pi：queue = 排队的 steer 消息；tui = 有中止处理（把排队的退回输入框），否则队列留着、中止后会拿它们续跑 */
function fakePi(opts: { tui: boolean; editor?: string }) {
  const s = { idle: false, aborts: 0, queue: [] as string[], editor: opts.editor ?? "" };
  const ctx: AbortableCtx = {
    isIdle: () => s.idle,
    hasPendingMessages: () => s.queue.length > 0,
    abort: () => {
      s.aborts++;
      if (opts.tui) {
        s.editor = [s.queue.join("\n\n"), s.editor].filter((x) => x.trim()).join("\n\n");
        s.queue = [];
      }
    },
    ...(opts.tui ? { ui: { getEditorText: () => s.editor } } : {}),
  };
  return { s, ctx };
}
const msg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("Pi：停之前 steer 进去、还没执行的消息作废", () => {
  test("TUI：回执列出作废的那条、报它被退回了输入框；输入框不动（人在终端里打了一半的字也在）", () => {
    let t = 0;
    const c = createAbortControl(() => t);
    const pi = fakePi({ tui: true, editor: "我在终端里打了一半" });
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "SLOW first", messageId: "m1" }, false);
    c.onMessageStart(msg("SLOW first"));
    c.onBridgeMessage({ text: "部署 Y", messageId: "m2" }, true);
    pi.s.queue.push("部署 Y");
    const r = c.abort();
    expect(r.result).toBe("aborted");
    expect(r.voided).toEqual(["m2"]);
    expect(r.inEditor).toBe(1);
    expect(pi.s.editor).toBe("部署 Y\n\n我在终端里打了一半");
    t += 100;
    expect(c.onSettled()).toEqual([]); // Pi 停稳了
    c.onRunStart(pi.ctx); // 之后的新一轮照常跑
    expect(pi.s.aborts).toBe(1);
  });

  test("TUI 自动重试的退避期里叫停（wf2 pi-2）：退避完 Pi continue 开的那一轮再中止；这期间的「停」押到 settle 后当新一轮投", () => {
    let t = 0;
    const c = createAbortControl(() => t);
    const pi = fakePi({ tui: true });
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "FAIL 部署 BASH", messageId: "m1" }, false);
    expect(c.abort().result).toBe("aborted"); // 退避中：ctx.abort() 不取消重试
    t += 1_200;
    expect(c.onBridgeMessage({ text: "等等", messageId: "m2" }, true)).toBe(true); // 不 steer：会被下面的再中止退回输入框
    t += 1_000;
    c.onRunStart(pi.ctx); // 退避完的重试
    expect(pi.s.aborts).toBe(2);
    expect(pi.s.editor).toBe("");
    expect(c.onSettled()).toEqual(["等等"]);
    c.onRunStart(pi.ctx); // 「等等」开的新一轮照常跑
    expect(pi.s.aborts).toBe(2);
  });

  test("叫停之后一直等不到 settle：60 秒后不再押消息、不再拦新一轮", () => {
    let t = 0;
    const c = createAbortControl(() => t);
    const pi = fakePi({ tui: true });
    c.onRunStart(pi.ctx);
    c.abort();
    t += 61_000;
    expect(c.onBridgeMessage({ text: "看下日志", messageId: "m2" }, true)).toBe(false);
    c.onRunStart(pi.ctx);
    expect(pi.s.aborts).toBe(1);
  });

  test("--mode rpc：中止后 Pi 拿排队消息续跑的那一轮也中止；这期间到的「停」押到 settle 后投", () => {
    let t = 0;
    const c = createAbortControl(() => t);
    const pi = fakePi({ tui: false });
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "部署 Y BASH", messageId: "m2" }, true);
    pi.s.queue.push("部署 Y BASH");
    const r = c.abort();
    expect(r.voided).toEqual(["m2"]);
    expect(r.inEditor).toBe(0); // RPC 没有输入框：在续跑的那一轮里被拦下
    t += 5;
    c.onRunStart(pi.ctx); // 续跑的那一轮
    expect(pi.s.aborts).toBe(2);
    expect(c.onBridgeMessage({ text: "等等", messageId: "m3" }, true)).toBe(true);
    expect(c.onSettled()).toEqual(["等等"]);
    c.onRunStart(pi.ctx); // 「等等」开的新一轮照常跑
    expect(pi.s.aborts).toBe(2);
  });

  test("已经注入上下文（message_start）的 steer 消息不算作废：模型已经看到了", () => {
    const c = createAbortControl();
    const pi = fakePi({ tui: true });
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "看下日志", messageId: "m1" }, true);
    c.onMessageStart({ role: "user", content: "看下日志" });
    c.onBridgeMessage({ text: "部署 Y", messageId: "m2" }, true);
    pi.s.queue.push("部署 Y");
    expect(c.abort().voided).toEqual(["m2"]);
  });

  test("没在跑 → idle，不中止、不作废；回合正常结束后清账", () => {
    const c = createAbortControl();
    const pi = fakePi({ tui: true });
    expect(c.abort()).toEqual({ result: "idle", voided: [], inEditor: 0 }); // 还没开过回合
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "x", messageId: "m1" }, true);
    c.onSettled();
    pi.s.idle = true;
    expect(c.abort()).toEqual({ result: "idle", voided: [], inEditor: 0 });
    expect(pi.s.aborts).toBe(0);
  });
});

describe("⏹ 抬头：Pi 输入框里退回的条数", () => {
  test("有退回就写明「Pi 输入框里退回了 N 条，未执行」；没有就不写", () => {
    expect(stopHeadline(undefined, "fired", [], 2)).toContain("Pi 输入框里退回了 2 条停之前送到的消息，未执行");
    expect(stopHeadline(undefined, "fired")).not.toContain("输入框");
  });
});

describe("作废回显的文案", () => {
  const t = (fromName: string, excerpt: string) => ({ messageId: "m", fromKind: "user", fromName, excerpt, replyTo: "ch", at: 0 });
  test("人：在 agent 频道里说一声，列出谁的哪条；agent：发回给它自己", () => {
    const h = voidedNotice("agent-pi", [t("shawn", "部署 Y")], false);
    expect(h).toContain("shawn：「部署 Y」");
    expect(h).toContain("没执行");
    expect(h).toContain("请重发");
    expect(voidedNotice("agent-pi", [t("agent-x", "跑一下测试")], true)).toContain("你发给 agent-pi 的「跑一下测试」");
  });
});

describe("bridge 侧（Workflow 复核 wf2）", () => {
  const sent: string[] = [];
  const delivered: Envelope[] = [];
  const sock = { send: (d: string) => void sent.push(d) };
  const books = {
    pendingReplies: new Map<string, { msgId: string; threadId?: string }>(),
    pendingThreads: new Map<string, unknown>(),
    pendingInterAgentMsg: new Map<string, { fromChannelId?: string; ts: number }>(),
    dropped: [] as string[],
    pendingAgentCalls: { dropRequest: (t: string, c: string, id: string) => void books.dropped.push(`${t}<-${c}:${id}`) },
  };
  const held: Envelope[] = [];
  setExtensionSocket((ch) => (ch === "pi" ? sock : undefined), { deliver: async (e) => void delivered.push(e), ownerId: () => "owner", books: () => books, hold: (e) => void held.push(e) });
  setAbortCapable("pi", true);
  const lastId = () => JSON.parse(sent.at(-1) ?? "{}").id as string;
  const inbound = (id: string, from: Envelope["from"]) => turnCuts.noteDelivered({
    from, to: { kind: "local", channelId: "pi", agentName: "agent-pi" }, intent: "request", content: `请求 ${id}`,
    meta: { messageId: id, triggerKind: "user_discord", ts: "", threadId: "t" },
  } as unknown as Envelope, "pi");

  test("pi-7：回执只认这个频道当前的连接，别的连接对上 id 也不算", async () => {
    const p = extensionAbort("pi");
    onAbortAck({ id: lastId(), result: "idle" }, { send() {} });
    onAbortAck({ id: lastId(), result: "aborted" }, sock);
    expect(await p).toEqual(["abort"]);
  });

  test("pi-1：叫停之后的第一次 Stop 不做补 reply 拦截（只这一次）；本来就空闲的不算", async () => {
    expect(stopAfterAbort("pi")).toBe(true);
    expect(stopAfterAbort("pi")).toBe(false);
    const p = extensionAbort("pi");
    onAbortAck({ id: lastId(), result: "idle" }, sock);
    expect(await p).toEqual([]);
    expect(stopAfterAbort("pi")).toBe(false);
    expect(stopAfterAbort("pi", Date.now() + 1)).toBe(false);
  });

  test("pi-7：回执晚于 1.5 秒才到，作废的消息照样回显给发送方", async () => {
    inbound("late1", { kind: "user", userId: "u", username: "shawn", channelId: "dc-1" } as Envelope["from"]);
    const p = extensionAbort("pi");
    const id = lastId();
    expect(await p).toEqual(["abort"]); // 没回执：如实写「已请求」
    delivered.length = 0;
    onAbortAck({ id, result: "aborted", voided: ["late1", "late1"] }, sock);
    expect(delivered).toHaveLength(1); // id 重复只回显一次
    expect(delivered[0].to).toMatchObject({ kind: "user", channelId: "dc-1" });
    expect(delivered[0].meta.inReplyTo).toBe("late1"); // 那条请求就此了结，不再被当成「还没回复」
    stopAfterAbort("pi");
  }, 5_000);

  test("pi-6：回显各回各的地址——API / 网页 / peer 回它的 api 地址（镜像开关、peer 的等待都按回复那条路走），不进 owner 的 Discord", async () => {
    inbound("peer1", { kind: "api", tokenId: "tok_peer", name: "peer-bob", peer: "bob" } as Envelope["from"]);
    inbound("ag1", { kind: "local", channelId: "ag-x", agentName: "agent-x" } as Envelope["from"]);
    const p = extensionAbort("pi");
    delivered.length = 0;
    onAbortAck({ id: lastId(), result: "aborted", voided: ["peer1", "ag1"] }, sock);
    await p;
    expect(delivered.map((e) => e.to)).toEqual([expect.objectContaining({ kind: "api", tokenId: "tok_peer" })]);
    expect(held.map((e) => [e.to, e.meta.inReplyTo])).toEqual([[expect.objectContaining({ kind: "local", channelId: "ag-x" }), "ag1"]]); // agent-x 不在线：押着等它连回来
    expect(delivered[0].content).toContain("你发给 agent-pi 的「请求 peer1」");
    stopAfterAbort("pi");
  });

  test("adv4：作废的消息从补答账、回程槽和看门狗上销掉（找不到发送方的也按 id 销），叫停之后才挂上的看门狗不动", async () => {
    books.dropped.length = 0; // 上面 pi-6 那条作废的 agent 消息已经撤过它的回程槽
    inbound("g1", { kind: "api", tokenId: "tok_guest", name: "guest" } as Envelope["from"]);
    inbound("ag2", { kind: "local", channelId: "ag-y", agentName: "agent-y" } as Envelope["from"]);
    books.pendingReplies.set("th-g1", { msgId: "g1", threadId: "th-g1" }).set("th-x", { msgId: "unknown1", threadId: "th-x" }).set("th-k", { msgId: "keep" });
    books.pendingThreads.set("th-g1", {}).set("th-x", {});
    books.pendingInterAgentMsg.set("pi", { fromChannelId: "ag-y", ts: Date.now() - 1_000 });
    const p = extensionAbort("pi");
    onAbortAck({ id: lastId(), result: "aborted", voided: ["g1", "ag2", "unknown1"] }, sock);
    await p;
    expect([...books.pendingReplies.keys()]).toEqual(["th-k"]);
    expect(books.pendingThreads.size).toBe(0);
    expect(books.pendingInterAgentMsg.has("pi")).toBe(false);
    expect(books.dropped).toEqual(["pi<-ag-y:ag2"]);
    stopAfterAbort("pi");

    books.pendingInterAgentMsg.set("pi", { fromChannelId: "ag-y", ts: Date.now() + 60_000 }); // 叫停之后 agent-y 又发来的新请求
    inbound("ag3", { kind: "local", channelId: "ag-y", agentName: "agent-y" } as Envelope["from"]);
    const q = extensionAbort("pi");
    onAbortAck({ id: lastId(), result: "aborted", voided: ["ag3"] }, sock);
    await q;
    expect(books.pendingInterAgentMsg.has("pi")).toBe(true);
    stopAfterAbort("pi");
  });

  describe("Codex 投递失败：只了结没投进去的这一条（T52 He 审 #204）", () => {
    const cx = (id: string, from: Envelope["from"], busy = true, ch = "cx") => turnCuts.noteDelivered({
      from, to: { kind: "local", channelId: ch, agentName: "agent-cx" }, intent: "request", content: `请求 ${id}`,
      meta: { messageId: id, triggerKind: "api_user", ts: "", threadId: "t" },
    } as unknown as Envelope, ch, false, busy);
    const calls: string[] = [];
    const deps = { stopTyping: (c: string) => void calls.push(`typing:${c}`), clearSafetyTimer: (c: string) => void calls.push(`timer:${c}`) };
    const statusEvents = () => calls.filter((c) => c.startsWith("typing:"));
    const reply = () => JSON.parse(sent.at(-1) ?? "{}");

    test("P1：同一回合里已经送到过别的消息（回合开着）——只回显这一条（inReplyTo），状态不动、不结别人的等待", async () => {
      cx("run1", { kind: "api", tokenId: "tok_a", name: "peer-a" } as Envelope["from"]);
      cx("bad1", { kind: "api", tokenId: "tok_b", name: "peer-b" } as Envelope["from"]);
      delivered.length = 0; calls.length = 0;
      await onCodexUndelivered({ requestId: "r1", channelId: "cx", messageId: "bad1", reason: "⚠️ 消息投递到 Codex 失败：boom" }, sock, true, deps);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({ intent: "response", to: { kind: "api", tokenId: "tok_b" }, content: "⚠️ 消息投递到 Codex 失败：boom" });
      expect(delivered[0].meta.inReplyTo).toBe("bad1");
      expect(statusEvents()).toEqual([]); // run1 还在跑：不收成 done
      expect(reply()).toEqual({ type: "response", requestId: "r1", result: { settled: 1 } });
      expect(turnCuts.deliveredMessage("cx", "run1")).toBeDefined();
      expect(turnCuts.deliveredMessage("cx", "bad1")).toBeUndefined();
    });

    test("P2：空闲时投的最后一条没投进去——收掉「工作中」（不走 Stop 收尾，不发完成通知）", async () => {
      turnCuts.dropUndelivered("cx", "run1");
      cx("bad2", { kind: "user", userId: "u", username: "alex", channelId: "dc-7" } as Envelope["from"], false);
      delivered.length = 0; calls.length = 0;
      await onCodexUndelivered({ requestId: "r2", channelId: "cx", messageId: "bad2", reason: "⚠️ Codex 会话不在线，消息未投递" }, sock, true, deps);
      expect(delivered.map((e) => e.to)).toEqual([expect.objectContaining({ kind: "user", channelId: "dc-7" })]);
      expect(calls).toEqual(["typing:cx", "timer:cx"]);
    });

    test("不是这个频道当前的连接 / 认不出这条：什么都不动，settled 0（channel-server 自己兜底说）", async () => {
      cx("bad3", { kind: "api", tokenId: "tok_c", name: "c" } as Envelope["from"]);
      delivered.length = 0; calls.length = 0;
      await onCodexUndelivered({ requestId: "r3", channelId: "cx", messageId: "bad3", reason: "x" }, sock, false, deps);
      expect(reply().result).toEqual({ settled: 0 });
      await onCodexUndelivered({ requestId: "r4", channelId: "cx", messageId: "nope", reason: "x" }, sock, true, deps);
      expect(reply().result).toEqual({ settled: 0 });
      expect(delivered).toEqual([]);
      expect(turnCuts.deliveredMessage("cx", "bad3")).toBeDefined();
    });
  });

  describe("Codex 投递失败：只有「空闲时投的最后一条」没投进去才收 done，不按消息推算哪一回合在跑（T52 复审 #204）", () => {
    const calls: string[] = [];
    const deps = { stopTyping: (c: string) => void calls.push(`typing:${c}`), clearSafetyTimer: (c: string) => void calls.push(`timer:${c}`) };
    const send = (ch: string, id: string, busy: boolean, from?: Envelope["from"]) => turnCuts.noteDelivered({
      from: from ?? { kind: "api", tokenId: `tok_${id}`, name: id }, to: { kind: "local", channelId: ch, agentName: "agent-cx" }, intent: "request",
      content: id, meta: { messageId: id, triggerKind: "api_user", ts: "", threadId: "t" },
    } as unknown as Envelope, ch, false, busy);
    const out: string[] = [];
    const cs = { send: (d: string) => void out.push(d) };
    const fail = (ch: string, id: string) => onCodexUndelivered({ requestId: id, channelId: ch, messageId: id, reason: "x" }, cs, true, deps);
    const settled = () => JSON.parse(out.at(-1)!).result.settled;

    test("复现①：A 经 StopFailure 结束，B 空闲时投、投失败——收成 done", async () => {
      send("cx1", "A", false);
      turnCuts.onStop("cx1", "StopFailure", "agent-cx");
      send("cx1", "B", false);
      calls.length = 0;
      await fail("cx1", "B");
      expect(calls).toEqual(["typing:cx1", "timer:cx1"]);
    });

    test("复现②：A 在跑，后面 8 条排队的全失败——不收 done", async () => {
      send("cx2", "A", false);
      for (let i = 0; i < 8; i++) send("cx2", `q${i}`, true);
      calls.length = 0;
      for (let i = 0; i < 8; i++) await fail("cx2", `q${i}`);
      expect(calls).toEqual([]);
    });

    test("复现③（第 3 轮）：A 空闲开跑、B/C 进 queue，A、B 先后 Stop、C 在跑，D 投失败——不收 done", async () => {
      send("cx3", "A", false);
      send("cx3", "B", true);
      send("cx3", "C", true);
      turnCuts.onStop("cx3", "Stop", "agent-cx");
      turnCuts.onStop("cx3", "Stop", "agent-cx");
      send("cx3", "D", true); // C 在跑：投 D 时回合态是忙
      calls.length = 0;
      await fail("cx3", "D");
      expect(calls).toEqual([]);
    });

    test("空闲时投的那条之后又投了别的：拿不准，不收 done", async () => {
      send("cx5", "E", false);
      send("cx5", "F", true);
      calls.length = 0;
      await fail("cx5", "E");
      expect(calls).toEqual([]);
    });

    test("P2：发送方 agent 断线——回显押进队列才算告诉到（settled 1）；bridge 自己的通知没有回信地址，settled 0", async () => {
      send("cx4", "off1", false, { kind: "local", channelId: "ag-off", agentName: "agent-off" } as Envelope["from"]);
      held.length = 0;
      await fail("cx4", "off1");
      expect(held.map((e) => [e.to.kind, e.meta.inReplyTo])).toEqual([["local", "off1"]]);
      expect(settled()).toBe(1);
      send("cx4", "br1", false, { kind: "bridge", label: "cron" } as Envelope["from"]);
      await fail("cx4", "br1");
      expect(settled()).toBe(0);
    });

    test("P2（第 3 轮）：发送方在线、回显投递报错 / 被丢 / 抛错——押进队列（不带旧连接）才算告诉到；API 发送方送不到不算", async () => {
      const wire = (mode: string) => setExtensionSocket((ch) => (ch === "pi" || ch === "caller" ? sock : undefined), {
        deliver: async () => {
          if (mode === "reject") throw new Error("socket closed during send");
          return { outcome: mode === "error" ? { kind: "error", error: new Error("socket closed") } : { kind: "dropped", reason: "offline" } };
        },
        ownerId: () => "owner", books: () => books, hold: (e) => void held.push(e),
      });
      try {
        for (const mode of ["error", "dropped", "reject"]) {
          wire(mode);
          held.length = 0;
          send("cx6", `on-${mode}`, false, { kind: "local", channelId: "caller", agentName: "caller" } as Envelope["from"]);
          await fail("cx6", `on-${mode}`);
          expect(held.map((e) => [e.to.kind, e.meta.inReplyTo, (e.to as { ws?: unknown }).ws])).toEqual([["local", `on-${mode}`, undefined]]);
          expect(settled()).toBe(1);
        }
        send("cx6", "api-err", false);
        await fail("cx6", "api-err");
        expect(settled()).toBe(0);
      } finally {
        setExtensionSocket((ch) => (ch === "pi" ? sock : undefined), { deliver: async (e) => void delivered.push(e), ownerId: () => "owner", books: () => books, hold: (e) => void held.push(e) });
      }
    });
  });

  test("回显地址：Discord 人 → 他发消息的频道；agent → 它自己；bridge 自己的通知不回显", () => {
    const t = (fromKind: string, replyTo: string) => ({ messageId: "m", fromKind, fromName: "x", excerpt: "", replyTo, at: 0 });
    expect(voidedEchoTo(t("user", "dc-9"))).toEqual({ kind: "user", address: "dc-9" });
    expect(voidedEchoTo(t("api", "api:tok_1"))).toEqual({ kind: "api", address: "tok_1" });
    expect(voidedEchoTo(t("local", "ag-x"))).toEqual({ kind: "local", address: "ag-x" });
    expect(voidedEchoTo(t("bridge", ""))).toBeNull();
  });
});
