/**
 * HMB-1：收件人在长回合里时几个同事发来的消息押在队里，回合边界把它们合成一封载体一次送达（src/lib/held-agent-batch.ts）。
 * 真的 HeldQueue + flushHeld + AgentCallBook + settleStopTurn；投递层是照 bridge.ts deliverToLocal 押后规则写的替身
 * （目标在回合中就把同一封押回；送出就开一轮、按它记 noteDelivered），不连 bridge、不读生产状态。
 * 开关关着的那几条就是改动前的行为（红）：一个回合边界只送出一条。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { clearOpenedBy, flushHeld, onHeldDelivered, type FlushDeps } from "../src/bridge/held-flush.js";
import { HeldQueue, onHeldSettled, unseenFrom, type HeldItem } from "../src/bridge/held-queue.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { answerableUnmixed, noteDelivered, settleStopTurn, type CallerSettleDeps } from "../src/bridge/stop-settle.js";
import { agentBatchMembers, HELD_AGENT_BATCH_ENV, heldAgentBatchOn } from "../src/lib/held-agent-batch.js";
import { requestStillHeld } from "../src/lib/held-pac.js";
import { INBOX_BUDGET, INBOX_MAX_TAKE } from "../src/lib/inbox-batch.js";

const ws = { tag: "target-ws" } as never;
const ME = "c-me";
const to: LocalEndpoint = { kind: "local", channelId: ME, agentName: "agent-me", ws };
const SENDERS = { A: { ch: "c-a", name: "agent-a" }, B: { ch: "c-b", name: "agent-b" }, C: { ch: "c-c", name: "agent-c" } } as const;
type Who = keyof typeof SENDERS | "owner" | "peer";

let seq = 0;
function msg(who: Who, over: Partial<Envelope["meta"]> = {}, intent: Envelope["intent"] = "request", content?: string): HeldItem {
  const n = ++seq;
  const from: Envelope["from"] = who === "owner" ? { kind: "user", userId: "u1", channelId: ME, username: "owner" }
    : who === "peer" ? { kind: "api", tokenId: "tok-peer", name: "peer-x", peer: "px" }
    : { kind: "local", channelId: SENDERS[who].ch, agentName: SENDERS[who].name, ws };
  const env = {
    from, to, intent, content: content ?? `body ${who}${n}`,
    meta: { messageId: `m${n}`, threadId: `thr${n}`, ts: `2026-10-14T00:00:${String(n).padStart(2, "0")}Z`, triggerKind: who === "owner" ? "discord" : "agent_tool", ...over },
  } as Envelope;
  return { env, to, heldAt: 1000 + n };
}

interface Sent { env: Envelope; content: string }
function rig(items: HeldItem[], opts: { batch?: boolean } = {}) {
  const held = new HeldQueue(null);
  held.configureIdleBatch(undefined); // 内部通知批次关着：只看 agent 消息合批
  for (const i of items) held.hold(ME, i);
  const sends: Sent[] = [], touched: string[] = [], mirrored: string[] = [];
  let busy = true, compacting = false, walled = false, turnAt: number | undefined, clock = 10;
  let fail: "error" | undefined;
  const deliver: FlushDeps["deliver"] = async (env, _to, stillWanted): Promise<Delivery> => {
    await Promise.resolve();
    if (stillWanted && !stillWanted()) return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } };
    if (fail) return { envelope: env, outcome: { kind: "error", error: new Error("ws closed") } };
    const waits = env.from.kind === "local" || !!env.meta.waitForIdle;
    if (compacting || (busy && waits)) {
      held.holdEnv(env);
      return { envelope: env, outcome: { kind: "sent", note: "queued" } };
    }
    sends.push({ env, content: String(env.content) });
    noteDelivered(ME, env.from, Date.now(), !busy, env.intent === "request" && !env.meta.skipInterAgentWatchdog); // deliverToLocal 同一处
    busy = true;
    turnAt ??= clock++;
    return { envelope: env, outcome: { kind: "sent" } };
  };
  const deps: FlushDeps = {
    held, compacting: () => compacting, working: async () => busy, isHumanRequest: (e) => e.from.kind === "user" && e.intent === "request",
    client: () => ({ ws }), deliver, walled: async () => walled, touch: (_c, e) => touched.push(e.meta.messageId),
    settled: async () => true, turnAt: () => turnAt, now: () => 5_000, render: async (e) => e.content,
    agentBatch: () => opts.batch ?? true, mirror: (_c, e) => mirrored.push(e.meta.messageId),
  };
  return {
    held, deps, sends, touched, mirrored,
    ids: () => (held.get(ME) ?? []).map((i) => i.env.meta.messageId),
    /** 这一轮结束，Stop 补投 */
    stop: async () => { busy = false; turnAt = undefined; await flushHeld(deps, ME, "stop"); },
    set: (s: { busy?: boolean; compacting?: boolean; walled?: boolean; fail?: "error" }) => {
      ({ busy = busy, compacting = compacting, walled = walled } = s);
      if ("fail" in s) fail = s.fail;
    },
  };
}
/** 载体正文里逐条的原始信息行 */
const originals = (content: string) => [...content.matchAll(/^\[\d+\/\d+ (\{.*\})\]$/gm)].map((m) => JSON.parse(m[1]) as
  { from: { kind: string; channelId?: string; agentName?: string }; message_id: string; intent: string; thread: string; ts: string; heldAt: number });

const offs: (() => void)[] = [];
let settled: string[] = [], hooked: string[] = [];
const noopSettle: CallerSettleDeps = {
  answerable: () => undefined, waiting: () => [], rearmResume: () => {}, consume: () => {}, pushBack: async () => {}, nudgeAmbiguous: () => {},
  markApiError: () => undefined, clearWithheld: () => {}, takeApiErrorNotice: () => [], notify: async () => {}, metric: () => {}, recovered: () => {},
};
beforeEach(async () => {
  // stop-settle 的「这一轮谁开的」是模块级状态：上一个用例没走 Stop 的话会并进下一个用例的这一轮，先空收一次
  await settleStopTurn(noopSettle, { cid: ME, stopChannelId: ME, stopWs: ws, candidateWs: ws, event: "Stop", drain: { text: null } });
  clearOpenedBy();
  settled = [];
  hooked = [];
  offs.push(onHeldSettled((e, o) => settled.push(`${e.meta.messageId}:${o}`)));
  let live = true; // onHeldDelivered 没有退订：只记这个用例的
  onHeldDelivered((_c, e) => { if (live) hooked.push(e.meta.messageId); });
  offs.push(() => { live = false; });
});
afterEach(() => { for (const f of offs.splice(0)) f(); });

describe("先红后绿：B、C 在 A 长回合里共排了 6 条", () => {
  const scene = () => [msg("B"), msg("C"), msg("B"), msg("C"), msg("B"), msg("C")];

  test("开关关着（改动前）：一个回合边界只送出一条，其余被投递层押回", async () => {
    const r = rig(scene(), { batch: false });
    await r.stop();
    expect(r.sends.map((s) => s.env.meta.messageId)).toHaveLength(1);
    expect(r.ids()).toHaveLength(5);
  });

  test("开着：一个回合边界一封载体送出全部 6 条，原条目逐条保留 id / from / intent / thread / ts，送达后才出队", async () => {
    const items = scene();
    const r = rig(items);
    await r.stop();
    expect(r.sends).toHaveLength(1);
    const carrier = r.sends[0].env;
    expect(carrier.from).toEqual({ kind: "bridge", label: "held-idle-batch" });
    expect(r.sends[0].content).toContain("排队给你的 agent 消息：6 条");
    expect(r.sends[0].content).toContain("send_to_agent");
    const got = originals(r.sends[0].content);
    expect(got.map((o) => o.message_id)).toEqual(items.map((i) => i.env.meta.messageId));
    for (const [k, o] of got.entries()) {
      const e = items[k].env;
      expect(o).toEqual({ from: { kind: "local", channelId: (e.from as { channelId: string }).channelId, agentName: (e.from as { agentName: string }).agentName },
        message_id: e.meta.messageId, intent: e.intent, thread: e.meta.threadId, ts: e.meta.ts, heldAt: items[k].heldAt });
    }
    expect(r.ids()).toEqual([]);
    const ids = items.map((i) => i.env.meta.messageId);
    expect(r.touched).toEqual(ids); // 回程簿失效钟逐条从送达起算
    expect(r.mirrored).toEqual(ids); // 网页逐条画入站气泡
    expect(hooked).toEqual(ids); // 送达回调每条一次
    expect(settled).toEqual(ids.map((id) => `${id}:delivered`)); // notifyHeldSettled 每条一次
  });

  test("超过条数上限：放不下的留到下一个回合边界（最早的排最前），超长的只给开头 + 分页读入口、原条目留着", async () => {
    const many = Array.from({ length: INBOX_MAX_TAKE + 2 }, (_, k) => msg(k % 2 ? "B" : "C"));
    const long = msg("B", {}, "request", "x".repeat(INBOX_BUDGET + 10));
    const r = rig([many[0], long, ...many.slice(1)]);
    await r.stop();
    expect(r.sends).toHaveLength(1);
    const first = r.sends[0].content;
    expect(originals(first)).toHaveLength(INBOX_MAX_TAKE + 1); // 10 条全文 + 1 条预览
    expect(first).toContain(`check_inbox({ read: "${long.env.meta.messageId}" })`);
    expect(first).toContain("其中 1 条超长只给开头，另有 2 条下一个回合边界送达");
    expect(r.ids()).toEqual([long, ...many.slice(INBOX_MAX_TAKE)].map((i) => i.env.meta.messageId));
    await r.stop(); // 下一个边界：最早的就是超长那条，不走批次、原路径整条送（不会饿死在后面短的后头）
    expect(r.sends[1].env.meta.messageId).toBe(long.env.meta.messageId);
    await r.stop(); // 再下一个：剩下两条短的一批走
    expect(originals(r.sends[2].content).map((o) => o.message_id)).toEqual(many.slice(INBOX_MAX_TAKE).map((i) => i.env.meta.messageId));
  });

  test("载体没送出去（投递报错 / 目标转忙）：原条目一条不少、heldAt 不变、不 touch、不报送达，载体不留在队里", async () => {
    const items = scene();
    const r = rig(items);
    r.set({ fail: "error" });
    await r.stop();
    expect(r.ids()).toEqual(items.map((i) => i.env.meta.messageId));
    expect(r.touched).toEqual([]);
    expect(hooked).toEqual([]);
    expect(settled).toEqual([]);
    expect((r.held.get(ME) ?? []).map((i) => i.heldAt)).toEqual(items.map((i) => i.heldAt));
  });
});

describe("回复不认错人：同一批里 A、B 各一条请求", () => {
  function scene() {
    const a = msg("A"), b = msg("B");
    const r = rig([a, b]);
    const calls = new AgentCallBook(null);
    for (const [who, it] of [["A", a], ["B", b]] as const) {
      calls.add(ME, { callerChannelId: SENDERS[who].ch, callerName: SENDERS[who].name, targetName: "agent-me", targetChannelId: ME, ts: 1 }, it.env.meta.messageId);
    }
    const stillHeld = (req: { messageId?: string; callerChannelId: string }) => requestStillHeld(req, unseenFrom(r.held, ME));
    const pushed: string[] = [], consumed: string[] = [];
    let nudged = 0;
    const d: CallerSettleDeps = {
      answerable: () => calls.answerable(ME, stillHeld), waiting: () => calls.waiting(ME, stillHeld), rearmResume: () => {},
      consume: (_c, pac) => { consumed.push(pac.callerName); calls.consume(ME, pac.callerChannelId, pac); },
      pushBack: async (pac, _c, body) => { pushed.push(`${pac.callerName}:${body}`); }, nudgeAmbiguous: () => { nudged++; },
      markApiError: () => undefined, clearWithheld: () => {}, takeApiErrorNotice: () => [], notify: async () => {}, metric: () => {}, recovered: () => {},
    };
    const stopTurn = (text: string | null) => settleStopTurn(d, { cid: ME, stopChannelId: ME, stopWs: ws, candidateWs: ws, event: "Stop", drain: { text } });
    return { r, calls, stillHeld, pushed, consumed, nudged: () => nudged, stopTurn };
  }

  test("押着时谁都不算在等；合批送达后两槽都在等，没指明答给谁的回复谁都不推", async () => {
    const s = scene();
    expect(s.calls.waiting(ME, s.stillHeld)).toEqual([]);
    await s.r.stop();
    expect(s.calls.waiting(ME, s.stillHeld).map((c) => c.callerName).sort()).toEqual(["agent-a", "agent-b"]);
    expect(s.calls.answerable(ME, s.stillHeld)).toBeUndefined();
    await s.stopTurn("答 A 也答 B 的一段话");
    expect(s.pushed).toEqual([]); // Stop 兜底不把一条答复结给两个人
    expect(s.consumed).toEqual([]);
    expect(s.nudged()).toBe(1);
  });

  test("只回 A（send_to_agent 精确消化 A 那槽）：B 的槽不结，Stop 兜底也不把这一轮的话推给 B（handoff-mixed-turn 同类：一轮里混了两个请求方）", async () => {
    const s = scene();
    await s.r.stop();
    const a = s.calls.exact(ME, SENDERS.A.ch, s.stillHeld)!;
    s.calls.consume(ME, SENDERS.A.ch, a); // bridge.ts send_to_agent 分支：target 回发给问它的人 = 那条回程答完
    expect(s.calls.waiting(ME, s.stillHeld).map((c) => c.callerName)).toEqual(["agent-b"]);
    await s.stopTurn("给 A 的答复写完了");
    expect(s.pushed).toEqual([]);
    expect(s.consumed).toEqual([]);
    expect(s.calls.slot(ME, SENDERS.B.ch)).toBeDefined(); // 等 target 用 send_to_agent 答 B
    await s.stopTurn(null); // 没文字的一轮同样不静默消化 B
    expect(s.calls.slot(ME, SENDERS.B.ch)).toBeDefined();
  });

  test("mixed-turn-own-reply：精确答 A 后在自己频道 reply——不推给 B、不占 B 的槽，B 之后仍能被精确答复（PR1528-r1 P1）", async () => {
    const s = scene();
    await s.r.stop();
    s.calls.consume(ME, SENDERS.A.ch, s.calls.exact(ME, SENDERS.A.ch, s.stillHeld)!);
    expect(s.calls.answerable(ME, s.stillHeld)?.callerName).toBe("agent-b"); // 只看回程簿（改动前 bridge.ts 的 answerablePac）就会认成 B
    expect(answerableUnmixed(s.calls, ME, s.stillHeld)).toBeUndefined(); // reply 分支和 Stop 兜底共用的判定：不认
    expect(s.calls.slot(ME, SENDERS.B.ch)).toBeDefined();
    const b = s.calls.exact(ME, SENDERS.B.ch, s.stillHeld)!; // target 之后用 send_to_agent 答 B：精确答复照常有效
    expect(b.callerName).toBe("agent-b");
    s.calls.consume(ME, SENDERS.B.ch, b);
    expect(s.calls.waiting(ME, s.stillHeld)).toEqual([]);
  });

  test("mixed-turn-stale-caller：更早一轮 C 的回程还挂着，本轮 A、B 合批且都被精确答掉——没指明收件人的答复不认给 C", async () => {
    const s = scene();
    s.calls.add(ME, { callerChannelId: SENDERS.C.ch, callerName: "agent-c", targetName: "agent-me", targetChannelId: ME, ts: 1 }, "old-c"); // 早已送到 C 的请求
    await s.r.stop();
    for (const w of [SENDERS.A.ch, SENDERS.B.ch]) s.calls.consume(ME, w, s.calls.exact(ME, w, s.stillHeld)!);
    expect(s.calls.answerable(ME, s.stillHeld)?.callerName).toBe("agent-c"); // 只看回程簿会认成 C
    expect(answerableUnmixed(s.calls, ME, s.stillHeld)).toBeUndefined();
    await s.stopTurn("这一轮答 A、B 的话");
    expect(s.pushed).toEqual([]);
    expect(s.consumed).toEqual([]);
    expect(s.calls.slot(ME, SENDERS.C.ch)).toBeDefined();
  });

  test("对照：只有一个请求方开的一轮，自己频道 reply 照旧归它", async () => {
    const s = scene();
    s.r.held.remove(ME, s.r.held.get(ME)![1]); // B 那条不在这一批（比如已被别处处理）
    s.calls.consume(ME, SENDERS.B.ch);
    await s.r.stop();
    expect(s.r.sends).toHaveLength(1);
    expect(answerableUnmixed(s.calls, ME, s.stillHeld)?.callerName).toBe("agent-a");
  });

  test("对照：同一批里另一条只是 oneShot 通知（不等回）——唯一的请求方照旧拿到 Stop 兜底", async () => {
    const note = msg("A", { skipInterAgentWatchdog: true }, "notification"), req = msg("B");
    const r = rig([note, req]);
    const calls = new AgentCallBook(null);
    calls.add(ME, { callerChannelId: SENDERS.B.ch, callerName: "agent-b", targetName: "agent-me", targetChannelId: ME, ts: 1 }, req.env.meta.messageId);
    const stillHeld = (q: { messageId?: string; callerChannelId: string }) => requestStillHeld(q, unseenFrom(r.held, ME));
    const pushed: string[] = [];
    await r.stop();
    expect(r.sends).toHaveLength(1);
    await settleStopTurn({
      answerable: () => calls.answerable(ME, stillHeld), waiting: () => calls.waiting(ME, stillHeld), rearmResume: () => {},
      consume: (_c, pac) => calls.consume(ME, pac.callerChannelId, pac), pushBack: async (pac) => { pushed.push(pac.callerName); }, nudgeAmbiguous: () => {},
      markApiError: () => undefined, clearWithheld: () => {}, takeApiErrorNotice: () => [], notify: async () => {}, metric: () => {}, recovered: () => {},
    }, { cid: ME, stopChannelId: ME, stopWs: ws, candidateWs: ws, event: "Stop", drain: { text: "给 B 的答复" } });
    expect(pushed).toEqual(["agent-b"]);
    expect(calls.slot(ME, SENDERS.B.ch)).toBeUndefined();
  });

  test("agent-batch-overtakes-peer：[A, peer, B] 不越过 peer——A 单独送，下一个边界 peer，再下一个 B（和逐条投递同序）", async () => {
    const a = msg("A"), p = msg("peer"), b = msg("B");
    const r = rig([a, p, b]);
    const order: string[] = [];
    for (let k = 0; k < 3; k++) {
      await r.stop();
      order.push(...r.sends.splice(0).map((x) => x.env.meta.messageId));
    }
    expect(order).toEqual([a, p, b].map((i) => i.env.meta.messageId));
  });

  test("[A, B, peer]：A、B 一批，peer 下一个边界；[A, owner, B]：A 单独，owner、B 依次在后", async () => {
    const a = msg("A"), b = msg("B"), p = msg("peer");
    const r = rig([a, b, p]);
    await r.stop();
    expect(originals(r.sends[0].content).map((o) => o.message_id)).toEqual([a, b].map((i) => i.env.meta.messageId));
    expect(r.ids()).toEqual([p.env.meta.messageId]);
    const a2 = msg("A"), o = msg("owner"), b2 = msg("B");
    const q = rig([a2, o, b2]);
    await q.stop();
    expect(q.sends.map((x) => x.env.meta.messageId)).toEqual([a2.env.meta.messageId]);
    expect(q.ids()).toEqual([o, b2].map((i) => i.env.meta.messageId));
  });

  test("外人（peer）不进合批：它先到就单独开一轮，agent 们等下一个边界一起送", async () => {
    const p = msg("peer"), a = msg("A"), b = msg("B");
    const r = rig([p, a, b]);
    await r.stop();
    expect(r.sends.map((s) => s.env.meta.messageId)).toEqual([p.env.meta.messageId]);
    expect(r.ids()).toEqual([a, b].map((i) => i.env.meta.messageId));
    await r.stop();
    expect(originals(r.sends[1].content).map((o) => o.message_id)).toEqual([a, b].map((i) => i.env.meta.messageId));
  });
});

describe("闸不回归", () => {
  test("压缩中不投、额度闸内不投、回合中不投", async () => {
    for (const s of [{ compacting: true }, { walled: true }] as const) {
      const r = rig([msg("A"), msg("B")]);
      r.set(s);
      await r.stop();
      expect(r.sends).toEqual([]);
      expect(r.ids()).toHaveLength(2);
    }
    const r = rig([msg("A"), msg("B")]);
    await flushHeld(r.deps, ME, "sweep"); // 还在回合中
    expect(r.sends).toEqual([]);
  });

  test("check_inbox 租约内的不进载体", async () => {
    const leased = msg("A"), free1 = msg("B"), free2 = msg("C");
    leased.lease = { batchId: "inbox_x", at: Date.now() };
    const r = rig([leased, free1, free2]);
    await r.stop();
    expect(originals(r.sends[0].content).map((o) => o.message_id)).toEqual([free1, free2].map((i) => i.env.meta.messageId));
    expect(r.ids()).toEqual([leased.env.meta.messageId]);
  });

  test("owner 的消息不进载体：空闲时它先单独送（开了一轮），agent 们等下一个边界", async () => {
    const o = msg("owner"), a = msg("A"), b = msg("B");
    const r = rig([o, a, b]);
    await r.stop();
    expect(r.sends.map((s) => s.env.meta.messageId)).toEqual([o.env.meta.messageId]);
    await r.stop();
    expect(originals(r.sends[1].content)).toHaveLength(2);
  });
});

describe("开关与成员", () => {
  test("缺省开；只有显式 off / 0 / false 关", () => {
    expect(heldAgentBatchOn({})).toBe(true);
    expect(heldAgentBatchOn({ [HELD_AGENT_BATCH_ENV]: "on" })).toBe(true);
    for (const v of ["off", "OFF", " 0 ", "false"]) expect(heldAgentBatchOn({ [HELD_AGENT_BATCH_ENV]: v })).toBe(false);
  });

  test("调度派单的 expectSession：载体只能带一个，和这一段第一个带会话的不同就停；带附件的、额度闸押的同样截断这一段", async () => {
    const ok = () => true;
    const s1 = msg("A", { expectSession: "s1" }), s2 = msg("B", { expectSession: "s2" }), plain = msg("C"), att = msg("B", { attachments: ["/x.png"] });
    expect(agentBatchMembers([s1, plain, s2], ok).items).toEqual([s1, plain]);
    expect(agentBatchMembers([s1, s2, plain], ok).items).toEqual([]); // 第二条就停，只剩一条 = 不合批
    const r = rig([s1, plain, s2]);
    await r.stop();
    expect(r.sends[0].env.meta.expectSession).toBe("s1");
    expect(originals(r.sends[0].content).map((o) => o.message_id)).toEqual([s1, plain].map((i) => i.env.meta.messageId));
    expect(r.ids()).toEqual([s2.env.meta.messageId]);
    const wall = msg("A");
    wall.reason = "quota_wall";
    for (const cut of [att, wall]) {
      const a = msg("A"), c = msg("C");
      const q = rig([a, cut, c]);
      await q.stop();
      expect(q.sends.map((x) => x.env.meta.messageId)).toEqual([a.env.meta.messageId]); // 不越过它：a 单独走，c 排在它后面
    }
  });
});
