/**
 * T24 Workflow 第 2 轮 delivery-hold-1..4：押着的 API 请求不被别的回合结掉、扣下的话不按「谁已经扣着」去猜、
 * CC 自己续跑的回合中途来 peer 请求、终端里 Esc 打断后事件态还是 thinking。走 bridge 实际调用的 settleStopTurn / takeApiWaiters。
 */
import { describe, expect, test } from "bun:test";
import { AgentCallBook, type PendingAgentCall } from "../src/bridge/agent-calls.js";
import {
  noteDelivered, noteTurnCut, settleStopTurn, takeApiWaiters, unattributedNotice, type ApiWaiter, type CallerSettleDeps, type StopTurn,
} from "../src/bridge/stop-settle.js";

const wallErr = { error: "rate_limit", text: "You've hit your weekly limit · resets Sep 30 at 6am (Asia/Tokyo)" };
const overloaded = { error: "overloaded", text: "API Error: 529 Overloaded" };
const call = (caller: string): PendingAgentCall => ({ callerChannelId: caller, callerName: `agent-${caller}`, targetName: "agent-t", ts: 1000 });

let seq = 0;
function harness() {
  const cid = `c-wf2-${++seq}`;
  const book = new AgentCallBook(null);
  const pushed: { to: string; body: string }[] = [];
  const unattributed: string[] = [];
  const counts: { callers: number; waiting: number; wall: boolean }[] = [];
  const rearmed: string[] = [];
  const deps: CallerSettleDeps = {
    answerable: (c) => book.answerable(c, () => false),
    waiting: (c) => book.waiting(c, () => false),
    rearmResume: (c) => void rearmed.push(c),
    consume: (c, pac) => void book.consume(c, pac.callerChannelId, pac),
    pushBack: async (pac, _c, body) => void pushed.push({ to: pac.callerChannelId, body }),
    unattributed: (_c, text, n) => void (unattributed.push(text), counts.push(n)),
    nudgeAmbiguous: () => undefined,
    takeApiErrorNotice: (c) => book.takeApiErrorNotice(c, () => false),
    markApiError: (c, text, caller) => book.markApiError(c, () => false, text, caller),
    clearWithheld: (c, pac) => book.clearWithheld(c, pac.callerChannelId),
    notify: async () => undefined,
    metric: () => undefined,
  };
  const turn = (event: string, drain: StopTurn["drain"]): StopTurn => ({ cid, stopChannelId: cid, stopWs: 1, candidateWs: 1, event, drain });
  const stop = (event: string, drain: StopTurn["drain"]) => settleStopTurn(deps, turn(event, drain));
  const deliver = (from: Parameters<typeof noteDelivered>[1], at: number, idle = true) => noteDelivered(cid, from, at, idle);
  return { cid, book, pushed, unattributed, counts, rearmed, stop, turn, deliver };
}

describe("delivery-hold-2：扣下的话只归开这一轮的 caller，不按「谁已经扣着」去猜", () => {
  test("B 的槽已扣着话；A 开的一轮空手撞错；bridge 续跑那一轮答 A 又撞错 → A 的话扣进 A，不进 B", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-b"), "mb");
    h.deliver({ kind: "local", channelId: "c-b" }, 1_000);
    await h.stop("StopFailure", { text: "给 B 的前半段", apiError: true, error: overloaded });
    h.book.add(h.cid, call("c-a"), "ma");
    h.deliver({ kind: "local", channelId: "c-a" }, 100_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: overloaded });
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 160_000); // 60 秒续跑：接着做 A 那一轮
    await h.stop("StopFailure", { text: "给 A 的答复：A 项目的内部方案", apiError: true, error: overloaded });
    expect(h.book.slot(h.cid, "c-b")!.withheld).toEqual(["给 B 的前半段"]);
    expect(h.book.slot(h.cid, "c-a")!.withheld).toEqual(["给 A 的答复：A 项目的内部方案"]);
  });

  test("不是 agent 开的一轮（owner / 非续跑的 bridge 消息，callers 为空）撞错前说的话：不扣进任何一槽，只告诉 owner", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-b"), "mb");
    h.deliver({ kind: "local", channelId: "c-b" }, 1_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: overloaded }); // B 那一轮空手撞错，B 还在等
    h.deliver({ kind: "api", owner: true }, 100_000);
    await h.stop("StopFailure", { text: "给 owner 的半句", apiError: true, error: overloaded });
    expect(h.book.slot(h.cid, "c-b")?.withheld).toBeUndefined();
    expect(h.unattributed).toEqual(["给 owner 的半句"]);
    expect(h.counts).toEqual([{ callers: 0, waiting: 1, wall: false }]);
  });

  test("wf3 delivery-hold-5：说明按实际人数写；撞墙的标 wall（bridge 闸内静默）", async () => {
    expect(unattributedNotice("agent-t", { callers: 0, waiting: 1 })).toContain("不是 agent 开的");
    expect(unattributedNotice("agent-t", { callers: 0, waiting: 1 })).toContain("在等它的 1 个 caller");
    expect(unattributedNotice("agent-t", { callers: 2, waiting: 3 })).toContain("是 2 个 agent 的请求一起开的");
    expect(unattributedNotice("agent-t", { callers: 2, waiting: 3 })).not.toContain("好几个");
    const h = harness();
    h.book.add(h.cid, call("c-b"), "mb");
    h.deliver({ kind: "api", owner: true }, 1_000);
    await h.stop("StopFailure", { text: "给 owner 的半句", apiError: true, error: wallErr });
    expect(h.counts).toEqual([{ callers: 0, waiting: 1, wall: true }]);
  });
});

describe("delivery-hold-3：CC 到点自己续跑的回合中途送到 peer 请求", () => {
  test("整轮仍按撞墙那一轮（PM）结算：PM 收到扣下的话和续跑那一轮的答复，不 rearm", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: "PM 要的前半段", apiError: true, error: wallErr });
    h.deliver({ kind: "api", peer: "sekai" }, 5_000_000, false); // 回合进行中（CC 自己续跑）送到，不抢占、不押
    await h.stop("Stop", { text: "PM 要的结论" });
    expect(h.pushed.map((p) => p.to)).toEqual(["c-pm", "c-pm"]);
    expect(h.pushed[1]!.body).toContain("PM 要的结论");
    expect(h.rearmed).toEqual([]);
  });
});

describe("delivery-hold-4：终端里按 Esc 打断（没有 Stop、事件态还是 thinking）", () => {
  test("会话记录里的打断标记收掉这一轮：之后 peer 在「看起来还忙」时送到的开新一轮，按外人算，不结算给 PM", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 60_000);
    noteTurnCut(h.cid, 80_000); // owner 在终端里 Esc
    h.deliver({ kind: "api", peer: "sekai" }, 90_000, false);
    await h.stop("Stop", { text: "给 peer 的回答" });
    expect(h.pushed).toEqual([]);
    expect(h.rearmed).toEqual([h.cid]);
  });
});

describe("delivery-hold-1：押着的 API / peer 请求不被别的回合结掉", () => {
  const w = (cid: string, n: number, messageId: string): ApiWaiter => ({ agentChannelId: cid, agentName: "agent-t", threadId: `thr-${n}`, tokenId: "tok", messageId });
  test("guest 的消息还押着：T 答 PM 的那一轮 Stop 不结它；送到之后那一轮才结", () => {
    const h = harness();
    const q = new Map([["tok", [w(h.cid, 1, "m-guest")]]]);
    expect(takeApiWaiters(q, h.turn("Stop", { text: "给 PM 的答复：内部路线" }), true, new Set(), new Set(["m-guest"]))).toEqual([]);
    expect(q.get("tok")).toHaveLength(1);
    const r = takeApiWaiters(q, h.turn("Stop", { text: "给 guest 的答复" }), true, new Set(), new Set());
    expect(r.map((x) => x.result.reply)).toEqual(["给 guest 的答复"]);
  });
  test("押着的 peer 请求：T 另一轮以 API 错误结束也不把它结成 apiError", () => {
    const h = harness();
    const q = new Map([["tok", [w(h.cid, 1, "m-peer"), w(h.cid, 2, "m-sent")]]]);
    const r = takeApiWaiters(q, h.turn("StopFailure", { text: null, apiError: true, error: wallErr }), false, new Set(), new Set(["m-peer"]));
    expect(r.map((x) => x.waiter.messageId)).toEqual(["m-sent"]);
    expect(q.get("tok")!.map((x) => x.messageId)).toEqual(["m-peer"]);
  });

  test("抢占：插话那条已经记成新一轮之后打断标记才到，不把它收掉", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 60_000);
    h.deliver({ kind: "api" }, 90_000); // guest 抢占：C-c 在 88 秒，插话 90 秒送到（打断后目标闲着）
    noteTurnCut(h.cid, 88_000); // jsonl 里的打断标记晚一拍才读到
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 95_000, false); // guest 那一轮中途
    await h.stop("Stop", { text: "给 guest 的回答" });
    expect(h.pushed).toEqual([]);
  });
});

describe("wf3 delivery-hold-1：续跑继承撞错的那一轮，不是「上一轮」——中间插进一轮外人的不影响", () => {
  for (const label of ["quota-wall", "api-error-resume"]) {
    test(`PM 那一轮撞错 → guest 那一轮 → ${label} 续跑：答复推给 PM`, async () => {
      const h = harness();
      h.book.add(h.cid, call("c-pm"), "m1");
      h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
      await h.stop("StopFailure", { text: "撞墙前给 PM 的前半段", apiError: true, error: wallErr });
      h.deliver({ kind: "api" }, 100_000); // guest 那一轮（出闸补投 / 60 秒内来的）
      await h.stop("Stop", { text: "给 guest 的答复" });
      expect(h.pushed).toEqual([]);
      h.deliver({ kind: "bridge", label }, 200_000);
      await h.stop("Stop", { text: "给 PM 的结论" });
      expect(h.pushed.map((p) => p.to)).toEqual(["c-pm", "c-pm"]);
      expect(h.pushed[0]!.body).toContain("撞墙前给 PM 的前半段");
      expect(h.pushed[1]!.body).toContain("给 PM 的结论");
      expect(h.pushed.some((p) => p.body.includes("给 guest 的答复"))).toBe(false);
    });
  }

  test("PM 那一轮撞墙 → guest 那一轮 → CC 到点自己续跑（bridge 一条都没送）：仍结给 PM（T24 审查 P2-3）", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: "撞墙前给 PM 的前半段", apiError: true, error: wallErr });
    h.deliver({ kind: "api" }, 100_000);
    await h.stop("Stop", { text: "给 guest 的答复" });
    await h.stop("Stop", { text: "给 PM 的结论" });
    expect(h.pushed.map((p) => p.to)).toEqual(["c-pm", "c-pm"]);
    expect(h.pushed[1]!.body).toContain("给 PM 的结论");
    expect(h.pushed.some((p) => p.body.includes("给 guest 的答复"))).toBe(false);
  });

  test("重启后没有撞错那一轮的记录：续跑消息开的一轮来源未知，按外人算，不把它的话结给在等的 PM（adv3 P2-8）", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.book.markApiError(h.cid, () => false, null, "c-pm"); // 撞墙那一刻记在回程簿上（落盘），bridge 随后重启、内存里的来源记录没了
    h.deliver({ kind: "bridge", label: "quota-wall" }, 1_000);
    await h.stop("Stop", { text: "不知道是接着谁的活说的话" });
    expect(h.pushed).toEqual([]);
    expect(h.rearmed).toEqual([h.cid]);
  });

  test("CC 自己续跑 PM 那一轮时被 guest 抢占（Esc）：guest 那一轮按外人，之后出闸续跑仍结给 PM", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: wallErr });
    noteTurnCut(h.cid, 5_000_000); // CC 到点自己续跑，guest 补投时抢占
    h.deliver({ kind: "api" }, 5_000_100);
    await h.stop("Stop", { text: "给 guest 的答复" });
    expect(h.rearmed).toEqual([h.cid]);
    h.deliver({ kind: "bridge", label: "quota-wall" }, 5_100_000);
    await h.stop("Stop", { text: "给 PM 的结论" });
    expect(h.pushed.map((p) => [p.to, p.body.includes("给 PM 的结论")])).toEqual([["c-pm", true]]);
  });

  test("后撞错的那一轮说了算：PM 那一轮接着做完后，peer 那一轮又撞错，续跑按 peer（外人）算，不结给 B", async () => {
    const h = harness();
    h.book.add(h.cid, call("c-pm"), "m1");
    h.deliver({ kind: "local", channelId: "c-pm" }, 1_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: overloaded });
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 60_000);
    await h.stop("Stop", { text: "给 PM 的结论" });
    expect(h.pushed.map((p) => p.to)).toEqual(["c-pm"]);
    h.book.add(h.cid, call("c-b"), "m2"); // B 的请求押着（T 在 peer 那一轮里）
    h.deliver({ kind: "api", peer: "sekai" }, 100_000);
    await h.stop("StopFailure", { text: null, apiError: true, error: overloaded });
    h.deliver({ kind: "bridge", label: "api-error-resume" }, 160_000);
    await h.stop("Stop", { text: "给 peer 的答复" });
    expect(h.pushed.map((p) => p.to)).toEqual(["c-pm"]);
    expect(h.rearmed).toEqual([h.cid]);
  });
});
