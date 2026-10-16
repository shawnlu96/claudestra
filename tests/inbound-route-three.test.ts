/**
 * 入站路由的三处一致（JRT 验收 2）：deliverToLocal（抢占 / 押后）、held-flush 到期过滤、check_inbox 领取都读同一个判定——
 * Jev 判了排队的人类消息，押后队列忙时不放出来（否则放出来又被抢占 / 押回，打架）；判了打断的照常插队。
 * merge 投递后回复归属不丢（验收 3）：两条 agent 请求并进一封载体，各自的回程槽各自在等、精确答一个只结那一个。
 * 真的 HeldQueue / flushHeld / takeInbox / AgentCallBook；投递层是照 deliverToLocal 写的替身，判据就是 bridge.ts 里那两处调用。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, unseenFrom, type HeldItem } from "../src/bridge/held-queue.js";
import { configureInboundRoute, routeAdmitsWhileBusy, routeHolds, routeInbound } from "../src/bridge/inbound-route.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { isHumanRequest, type Envelope, type LocalEndpoint } from "../src/bridge/router.js";
import { noteDelivered, settleStopTurn, type CallerSettleDeps } from "../src/bridge/stop-settle.js";
import { requestStillHeld } from "../src/lib/held-pac.js";
import type { RouteMode, StoredRoute } from "../src/lib/inbound-route.js";
import type { TurnState } from "../src/lib/turn-state.js";

const ws = { tag: "me" } as never;
const ME = "c-me";
const to: LocalEndpoint = { kind: "local", channelId: ME, agentName: "agent-me", ws };
const BUSY: TurnState = { main: "busy", bg: false };
let mode: RouteMode = "on";
beforeEach(() => {
  mode = "on";
  clearOpenedBy();
  configureInboundRoute({ readMode: () => mode, now: () => 0 });
});
afterAll(() => configureInboundRoute({ readMode: () => "off", now: () => Date.now(), queue: () => undefined }));

let n = 0;
function held(who: "owner" | "A" | "B" | "peer", route?: StoredRoute, id = `m${++n}`): HeldItem {
  const from: Envelope["from"] = who === "owner" ? { kind: "user", userId: "u1", username: "owner", channelId: "c-o" }
    : who === "peer" ? { kind: "api", tokenId: "tok-p", name: "peer-x", peer: "px" }
    : { kind: "local", channelId: `c-${who}`, agentName: `agent-${who}`, ws };
  const meta = { messageId: id, threadId: `t-${id}`, ts: "2026-10-16T00:00:00Z", triggerKind: "user_discord", ...(route ? { inboundRoute: route } : {}) };
  const env = { from, to, intent: "request", content: `${who} ${id}`, meta } as Envelope;
  return { env, to, heldAt: 1 };
}

/** 照 deliverToLocal：先按判定决定抢不抢（preemptForHuman 里那一查），再按判定决定押不押 */
function deliverLike(q: HeldQueue, busy: () => boolean, log: string[]): FlushDeps["deliver"] {
  return async (env) => {
    const preempt = isHumanRequest(env) && routeAdmitsWhileBusy(env) && busy();
    if (routeHolds(env, busy() && !preempt ? BUSY : { main: "idle", bg: false })) {
      q.holdEnv(env);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    log.push(`${preempt ? "preempt+" : ""}${env.meta.messageId}`);
    noteDelivered(ME, env.from, Date.now(), !busy(), true);
    return { envelope: env, outcome: { kind: "sent" } };
  };
}
function flushDeps(q: HeldQueue, busy: () => boolean, log: string[], over: Partial<FlushDeps> = {}): FlushDeps {
  return {
    held: q, compacting: () => false, working: async () => busy(), isHumanRequest, client: () => ({ ws }), deliver: deliverLike(q, busy, log),
    touch: () => {}, settled: async () => true, now: () => 1, agentBatch: () => false, render: async (e) => e.content, mirror: () => {}, ...over,
  };
}

describe("三处一致：目标忙时 owner 消息按判定放 / 押", () => {
  const cases: [string, StoredRoute | undefined, boolean][] = [
    ["没判过（现有规则：人类消息打断）", undefined, true],
    ["Jev 判 interrupt", { action: "interrupt", p: 0.99 }, true],
    ["Jev 判 queue", { action: "queue", p: 0.98 }, false],
    ["Jev 判 merge", { action: "merge", mergeWith: "nope", p: 0.98 }, false],
  ];
  for (const [name, route, admitted] of cases) {
    test(name, async () => {
      const it = held("owner", route);
      // deliverToLocal 的两处判据
      expect(routeAdmitsWhileBusy(it.env)).toBe(admitted);
      expect(routeHolds(it.env, BUSY)).toBe(!admitted);
      // held-flush：忙时到期过滤用同一判定——放出来的就是会抢占插进去的，押着的不动（不会放出来又押回）
      const q = new HeldQueue(null);
      q.set(ME, [it]);
      const log: string[] = [];
      await flushHeld(flushDeps(q, () => true, log), ME, "sweep");
      expect(log).toEqual(admitted ? [`preempt+${it.env.meta.messageId}`] : []);
      expect((q.get(ME) ?? []).length).toBe(admitted ? 0 : 1);
      // check_inbox：押着的 owner 消息照样能领（领取是 agent 自己拉，判定只管投递时机）
      if (!admitted) {
        initInbox({ clients: new Map([[ME, { ws }]]), held: q, calls: new AgentCallBook(null), render: async (e) => e.content, emitIn: () => {} });
        const r = await takeInbox(ws, 1);
        expect("result" in r && r.result.n).toBe(1);
      }
    });
  }
  test("开关切回 off：同一条立刻按现有规则（flush 放出来、抢占）", async () => {
    mode = "off";
    const it = held("owner", { action: "queue", p: 0.98 });
    const q = new HeldQueue(null);
    q.set(ME, [it]);
    const log: string[] = [];
    await flushHeld(flushDeps(q, () => true, log), ME, "sweep");
    expect(log).toEqual([`preempt+${it.env.meta.messageId}`]);
  });
  test("回合结束（空闲）：判了排队的照投", async () => {
    const it = held("owner", { action: "queue", p: 0.98 });
    const q = new HeldQueue(null);
    q.set(ME, [it]);
    const log: string[] = [];
    await flushHeld(flushDeps(q, () => false, log), ME, "stop");
    expect(log).toEqual([it.env.meta.messageId]);
  });
});

describe("merge：顺序与回复归属", () => {
  test("check_inbox：merge 的那条紧跟同伴（[A, peer, B→A] 领成 A、B、peer）", async () => {
    const a = held("A"), p = held("peer"), b = held("B", { action: "merge", mergeWith: a.env.meta.messageId, p: 0.98 });
    const q = new HeldQueue(null);
    q.set(ME, [a, p, b]);
    initInbox({ clients: new Map([[ME, { ws }]]), held: q, calls: new AgentCallBook(null), render: async (e) => e.content, emitIn: () => {} });
    const r = await takeInbox(ws, 1);
    if ("error" in r) throw new Error(r.error);
    const order = [...r.result.text.matchAll(/message_id=(\S+)/g)].map((m) => m[1]);
    expect(order).toEqual([a, b, p].map((i) => i.env.meta.messageId));
  });

  test("[A, peer, B→A]：A、B 并进一封载体送出，两个回程槽各自在等；精确答 A 只结 A，B 照旧能被答", async () => {
    const a = held("A"), p = held("peer"), b = held("B", { action: "merge", mergeWith: a.env.meta.messageId, p: 0.98 });
    const q = new HeldQueue(null);
    q.configureIdleBatch(undefined);
    for (const i of [a, p, b]) q.hold(ME, i);
    const calls = new AgentCallBook(null);
    for (const [who, it] of [["A", a], ["B", b]] as const) {
      calls.add(ME, { callerChannelId: `c-${who}`, callerName: `agent-${who}`, targetName: "agent-me", targetChannelId: ME, ts: 1 }, it.env.meta.messageId);
    }
    const stillHeld = (req: { messageId?: string; callerChannelId: string }) => requestStillHeld(req, unseenFrom(q, ME));
    const noop: CallerSettleDeps = {
      answerable: () => undefined, waiting: () => [], rearmResume: () => {}, consume: () => {}, pushBack: async () => {}, nudgeAmbiguous: () => {},
      markApiError: () => undefined, clearWithheld: () => {}, takeApiErrorNotice: () => [], notify: async () => {}, metric: () => {}, recovered: () => {},
    };
    await settleStopTurn(noop, { cid: ME, stopChannelId: ME, stopWs: ws, candidateWs: ws, event: "Stop", drain: { text: null } }); // 清掉别的用例留下的「这一轮谁开的」
    const sent: Envelope[] = [];
    let busy = false;
    const deliver: FlushDeps["deliver"] = async (env) => {
      if (busy && (env.from.kind === "local" || env.meta.waitForIdle)) {
        q.holdEnv(env);
        return { envelope: env, outcome: { kind: "sent", note: "queued" } };
      }
      sent.push(env);
      noteDelivered(ME, env.from, Date.now(), !busy, true);
      busy = true;
      return { envelope: env, outcome: { kind: "sent" } };
    };
    const touched: string[] = [];
    await flushHeld(flushDeps(q, () => busy, [], { deliver, agentBatch: () => true, touch: (_c, e) => touched.push(e.meta.messageId) }), ME, "stop");
    expect(sent).toHaveLength(1);
    expect(sent[0].from.kind).toBe("bridge"); // 合批载体
    expect([...String(sent[0].content).matchAll(/"message_id":"(m\d+)"/g)].map((m) => m[1])).toEqual([a, b].map((i) => i.env.meta.messageId));
    expect(touched).toEqual([a, b].map((i) => i.env.meta.messageId));
    expect((q.get(ME) ?? []).map((i) => i.env.meta.messageId)).toEqual([p.env.meta.messageId]);
    expect(calls.waiting(ME, stillHeld).map((c) => c.callerName).sort()).toEqual(["agent-A", "agent-B"]);
    expect(calls.answerable(ME, stillHeld)).toBeUndefined(); // 没指明答给谁的不认给任何一个（不串话）
    const pa = calls.exact(ME, "c-A", stillHeld)!;
    calls.consume(ME, "c-A", pa);
    expect(calls.waiting(ME, stillHeld).map((c) => c.callerName)).toEqual(["agent-B"]);
    expect(calls.exact(ME, "c-B", stillHeld)?.callerName).toBe("agent-B");
  });

  test("jrt-merge-split（同伴在租约里）：[A(check_inbox 领走未确认), B→A] 目标空闲也不单独投 B；A 确认出队后 B 照投", async () => {
    const a = held("A"), b = held("B", { action: "merge", mergeWith: "", p: 0.98 });
    b.env.meta.inboundRoute!.mergeWith = a.env.meta.messageId;
    a.lease = { batchId: "inbox_x", at: Date.now() };
    const q = new HeldQueue(null);
    q.set(ME, [a, b]);
    const log: string[] = [];
    await flushHeld(flushDeps(q, () => false, log, { agentBatch: () => true }), ME, "stop");
    expect(log).toEqual([]);
    q.remove(ME, a);
    await flushHeld(flushDeps(q, () => false, log, { agentBatch: () => true }), ME, "stop");
    expect(log).toEqual([b.env.meta.messageId]);
  });

  test("jrt-merge-split（人的消息）：owner 补充排队里自己那条，Jev 判 merge 也按排队（不承诺并不到一起的合并）", async () => {
    const a = held("owner", { action: "queue", p: 0.98 });
    const q = new HeldQueue(null);
    q.set(ME, [a]);
    configureInboundRoute({
      readMode: () => "on", probe: async () => BUSY, queue: () => q.get(ME), doing: async () => "", log: () => {},
      ask: (async () => ({ model: "t", answers: { route_action: { type: "choice", choice: "merge", probabilities: { merge: 1 } },
        route_merge_with: { type: "choice", choice: "q1", probabilities: { q1: 1 } } }, usage: { input_tokens: 0, output_tokens: 0 }, latencyMs: 0, costUsd: 0 })) as never,
    });
    const b = held("owner").env;
    await routeInbound(b, to, "agent-me");
    expect(b.meta.inboundRoute).toMatchObject({ action: "queue" });
  });

  test("对照（开关 off）：B 不越过 peer，A 单独一轮", async () => {
    mode = "off";
    const a = held("A"), p = held("peer"), b = held("B", { action: "merge", mergeWith: "x", p: 0.98 });
    const q = new HeldQueue(null);
    q.configureIdleBatch(undefined);
    for (const i of [a, p, b]) q.hold(ME, i);
    const log: string[] = [];
    let busy = false;
    await flushHeld(flushDeps(q, () => busy, log, {
      agentBatch: () => true,
      deliver: async (env) => { log.push(env.meta.messageId); busy = true; return { envelope: env, outcome: { kind: "sent" } }; },
    }), ME, "stop");
    expect(log[0]).toBe(a.env.meta.messageId);
  });
});
