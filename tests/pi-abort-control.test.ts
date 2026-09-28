/**
 * src/pi/abort-control.ts（Pi 扩展里 bridge 叫停的那一段）与 bridge/pi-abort.ts 的回显文案。对抗式第 3 轮 P1-B + PM 的修法：
 * 停之后，已经 steer 进去、还没执行的消息一律作废，回执列出来，bridge 回显给发送方；TUI 下 Pi 退回输入框的不清（终端里的人可能在打字），
 * 回执报几条，⏹ 抬头里写明。
 * 行为在真 Pi 0.85.1 + 假模型上对照过（TUI 与 --mode rpc），见 docs/architecture/interrupts.md「Pi」。
 */
import { describe, expect, test } from "bun:test";
import { createAbortControl, type AbortableCtx } from "../src/pi/abort-control.js";
import {
  extensionAbort, onAbortAck, setAbortCapable, setExtensionSocket, stopAfterAbort, voidedEchoTo, voidedNotice,
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
  setExtensionSocket((ch) => (ch === "pi" ? sock : undefined), { deliver: async (e) => void delivered.push(e), ownerId: () => "owner" });
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
    expect(delivered.map((e) => e.to)).toEqual([expect.objectContaining({ kind: "api", tokenId: "tok_peer" })]); // agent-x 不在线：没法告诉它
    expect(delivered[0].content).toContain("你发给 agent-pi 的「请求 peer1」");
    stopAfterAbort("pi");
  });

  test("回显地址：Discord 人 → 他发消息的频道；agent → 它自己；bridge 自己的通知不回显", () => {
    const t = (fromKind: string, replyTo: string) => ({ messageId: "m", fromKind, fromName: "x", excerpt: "", replyTo, at: 0 });
    expect(voidedEchoTo(t("user", "dc-9"))).toEqual({ kind: "user", address: "dc-9" });
    expect(voidedEchoTo(t("api", "api:tok_1"))).toEqual({ kind: "api", address: "tok_1" });
    expect(voidedEchoTo(t("local", "ag-x"))).toEqual({ kind: "local", address: "ag-x" });
    expect(voidedEchoTo(t("bridge", ""))).toBeNull();
  });
});
