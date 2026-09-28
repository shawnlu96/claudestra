/**
 * src/pi/abort-control.ts（Pi 扩展里 bridge 叫停的那一段）与 bridge/pi-abort.ts 的回显文案。对抗式第 3 轮 P1-B + PM 的修法：
 * 停之后，已经 steer 进去、还没执行的消息一律作废（TUI 输入框里退回来的那几条清掉），回执列出来，bridge 回显给发送方。
 * 行为在真 Pi 0.85.1 + 假模型上对照过（TUI 与 --mode rpc），见 docs/architecture/interrupts.md「Pi」。
 */
import { describe, expect, test } from "bun:test";
import { createAbortControl, type AbortableCtx } from "../src/pi/abort-control.js";
import { voidedNotice } from "../src/bridge/pi-abort.js";

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
    ...(opts.tui ? { ui: { getEditorText: () => s.editor, setEditorText: (t: string) => void (s.editor = t) } } : {}),
  };
  return { s, ctx };
}
const msg = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

describe("Pi：停之前 steer 进去、还没执行的消息作废", () => {
  test("TUI：回执列出作废的那条；Pi 退回输入框的这条被清掉，人在终端里打了一半的字留着", () => {
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
    expect(r.voided.map((v) => v.messageId)).toEqual(["m2"]);
    expect(pi.s.editor).toBe("我在终端里打了一半");
    t += 100;
    c.onRunStart(pi.ctx); // TUI 下队列已空：不会有续跑，就算有新一轮也不拦
    expect(pi.s.aborts).toBe(1);
  });

  test("--mode rpc：中止后 Pi 拿排队消息续跑的那一轮也中止；bridge 的下一条（「停」本身）到了就不再拦", () => {
    let t = 0;
    const c = createAbortControl(() => t);
    const pi = fakePi({ tui: false });
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "部署 Y BASH", messageId: "m2" }, true);
    pi.s.queue.push("部署 Y BASH");
    expect(c.abort().voided.map((v) => v.messageId)).toEqual(["m2"]);
    t += 5;
    c.onRunStart(pi.ctx); // 续跑的那一轮
    expect(pi.s.aborts).toBe(2);
    c.onBridgeMessage({ text: "等等", messageId: "m3" }, false);
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
    expect(c.abort().voided.map((v) => v.messageId)).toEqual(["m2"]);
  });

  test("没在跑 → idle，不中止、不作废；回合正常结束后清账", () => {
    const c = createAbortControl();
    const pi = fakePi({ tui: true });
    expect(c.abort()).toEqual({ result: "idle", voided: [] }); // 还没开过回合
    c.onRunStart(pi.ctx);
    c.onBridgeMessage({ text: "x", messageId: "m1" }, true);
    c.onSettled();
    pi.s.idle = true;
    expect(c.abort()).toEqual({ result: "idle", voided: [] });
    expect(pi.s.aborts).toBe(0);
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
