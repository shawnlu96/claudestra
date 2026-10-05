/**
 * 过期再提示在真实过期扫描里的接线（bridge/ask-expire.ts sweepExpired → lib/ask-recovery.ts）：真 reply 建授权 ask → 到点 → 扫描；
 * 缺策略 = observe 只记一次日志；on 时开新卡、发 SSE、告诉发起方新 id；新卡作答照常回投、旧卡 409；重复扫描不再开。库是临时文件。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { answerFromCard } from "../src/bridge/ask-entry.js";
import { setAskReminderPorts, sweepExpired } from "../src/bridge/ask-expire.js";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { ownerPresence, setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import { subscribeEvents, type BridgeEvent } from "../src/bridge/event-bus.js";
import type { Envelope } from "../src/bridge/router.js";
import { remindOne } from "../src/lib/ask-recovery.js";
import { getAsk, listAsks, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { at, owner } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const ws = { tag: "ws" } as never;
const BUTTONS = [{ type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] }];
const RELEASE = { action: "release", params: { tag: "v2.32.0" }, approve: ["go"] };
const s = { path: "", sent: [] as Envelope[], asks: [] as BridgeEvent[], unsub: () => {} };

beforeEach(() => {
  s.path = tempLedgerPath("ask-recovery-expire-");
  openLedger(s.path);
  Object.assign(s, { sent: [], asks: [] });
  const deps: AsksDeps = {
    clients: new Map([["111", { ws }]]), controlChannelId: "999", hold: () => {},
    deliver: async (env) => (s.sent.push(env), { envelope: env, outcome: { kind: "sent" } }),
  };
  setAsksForTest({ path: s.path, deps, registry: [{ name: "agent-x", channelId: "111", status: "active", projectId: "p" } as RegistryAgent], ownerChats: ["api:owner:self"] });
  s.unsub = subscribeEvents({}, (e) => void (e.type === "ask" && s.asks.push(e)));
  ownerPresence.setVisible("dev_recovery", true);
});
afterEach(() => {
  ownerPresence.setVisible("dev_recovery", false);
  setAskReminderPorts(undefined);
  s.unsub();
  setAsksForTest(undefined);
  closeLedger(s.path);
});

/** agent-x 用真 reply 路径发一条授权 ask，再把它拨到已到点 */
async function expiringAuthorize(content = "发 v2.32.0 吗", messageId = "reply_1", bind = RELEASE): Promise<Ask> {
  const env: Envelope = {
    from: { kind: "local", channelId: "111", ws }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content,
    meta: { messageId, triggerKind: "agent_tool", ts: at, threadId: "thr_1", components: BUTTONS },
  };
  await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => ({ envelope: e, outcome: { kind: "sent", discordMessageIds: [] } }), { kind: "authorize", bind });
  openLedger(s.path).run("UPDATE asks SET expiresAt = ? WHERE id = ?", [Date.now() - 1000, env.meta.askId!]);
  return getAsk(openLedger(s.path), env.meta.askId!)!;
}
const reminders = () => listAsks(openLedger(s.path)).filter((a) => a.extra.recoveryOf);

/** 模拟「落库后、发布前进程没了」：缺策略的扫描把原卡结成 expired，再直接开出一张带 pending 待办、还没发过的再提示卡 */
async function pendingReminder(): Promise<Ask> {
  const a = await expiringAuthorize();
  await sweepExpired();
  const on = { policy: () => ({ mode: "on" as const, manualAfterMs: null }), ownerActive: () => ({ active: true, evidence: "t" }), askerLive: () => true };
  const r = await remindOne(openLedger(s.path), getAsk(openLedger(s.path), a.id)!, on, Date.now());
  expect(r.result).toBe("opened");
  const n = reminders()[0];
  expect(n.extra.remindNotice).toBe("pending");
  expect(s.asks.some((e) => (e.data as { askId: string }).askId === n.id)).toBe(false);
  expect(s.sent.some((e) => e.content.includes(n.id))).toBe(false);
  return n;
}

describe("过期扫描里的再提示", () => {
  test("缺策略（CFG 还没接）= observe：只发原有的过期通知，不开卡；observe 日志每条只记一次", async () => {
    const log = spyOn(console, "log");
    try {
      await expiringAuthorize();
      expect(await sweepExpired()).toBe(1);
      await sweepExpired();
      expect(reminders()).toEqual([]);
      expect(s.sent.map((e) => e.content)).toEqual([expect.stringContaining("按未批准处理")]);
      expect(log.mock.calls.filter((c) => String(c[0]).includes("[askReminder observe]"))).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  test("on：开新卡 + SSE + 告诉发起方新 id；新卡作答回投、旧卡 409；再扫不再开", async () => {
    setAskReminderPorts({ policy: () => ({ mode: "on", manualAfterMs: null }) });
    const a = await expiringAuthorize();
    await sweepExpired();
    const [n] = reminders();
    expect(n).toMatchObject({ state: "open", kind: "authorize", fromAgent: "agent-x", extra: { recoveryOf: a.id } });
    expect(getAsk(openLedger(s.path), a.id)!.state).toBe("expired");
    expect(s.asks.some((e) => (e.data as { askId: string }).askId === n.id)).toBe(true);
    expect(s.sent.map((e) => e.content)).toEqual([expect.stringContaining("按未批准处理"), expect.stringContaining(`新卡 ${n.id}`)]);
    expect(s.sent[1].content).toContain("ask-check");

    expect((await answerFromCard("p", a.id, { choices: ["[button:go]"] }, owner())).status).toBe(409);
    expect((await answerFromCard("p", n.id, { choices: ["[button:go]"] }, owner())).status).toBe(202);
    expect(s.sent).toHaveLength(3);
    await sweepExpired();
    expect(reminders()).toHaveLength(1);
    expect(s.sent).toHaveLength(3);
  });

  test("on 但 owner 不在（只认心跳 / 动作）→ 等，不开", async () => {
    setAskReminderPorts({ policy: () => ({ mode: "on", manualAfterMs: null }) });
    ownerPresence.setVisible("dev_recovery", false);
    await expiringAuthorize();
    await sweepExpired();
    expect(reminders()).toEqual([]);
  });

  test("批里后一条查询抛错：前面开出的照样发 SSE + 告诉发起方，不丢；下一轮只补没发的，不重发", async () => {
    const a = await expiringAuthorize("发 v2.32.0 吗", "reply_1");
    const b = await expiringAuthorize("部署 v2.32.0 吗", "reply_2", { ...RELEASE, action: "deploy" }); // 不同 action = 不同 askKey，不互相取代
    let calls = 0;
    setAskReminderPorts({
      policy: () => ({ mode: "on", manualAfterMs: null }),
      // 每条问两次 owner 活跃（判定 + 写锁内复核）：第 3 次 = 第二条
      ownerActive: () => { if (calls++ === 2) throw new Error("presence temporarily down"); return { active: true, evidence: "test" }; },
    });
    await sweepExpired();
    const [first] = reminders();
    expect(reminders()).toHaveLength(1);
    expect(s.asks.some((e) => (e.data as { askId: string }).askId === first.id)).toBe(true);
    expect(s.sent.filter((e) => e.content.includes(`新卡 ${first.id}`))).toHaveLength(1);
    expect(getAsk(openLedger(s.path), first.id)!.extra.remindNotice).toBe("done");
    await sweepExpired();
    expect(reminders().map((x) => x.extra.recoveryOf).sort()).toEqual([a.id, b.id].sort());
    expect(s.sent.filter((e) => e.content.includes("新卡"))).toHaveLength(2);
  });

  test("落库后、发布前进程没了（卡带 pending 待办）：策略 on + owner 活跃时下一次扫描补发 SSE + 发起方通知，补一次就记 done", async () => {
    const n = await pendingReminder();
    setAskReminderPorts({ policy: () => ({ mode: "on", manualAfterMs: null }) });
    await sweepExpired();
    expect(s.asks.some((e) => (e.data as { askId: string }).askId === n.id)).toBe(true);
    expect(s.sent.filter((e) => e.content.includes(`新卡 ${n.id}`))).toHaveLength(1);
    expect(getAsk(openLedger(s.path), n.id)!.extra.remindNotice).toBe("done");
    await sweepExpired();
    expect(s.sent.filter((e) => e.content.includes(`新卡 ${n.id}`))).toHaveLength(1);
  });

  test("待办重放也过闸：缺策略 / observe / off、owner 无证据 / 不在 → 不推不告诉、待办留着；之后 on + 活跃了补一次，不丢不重", async () => {
    const n = await pendingReminder();
    const published = () => s.asks.filter((e) => (e.data as { askId: string }).askId === n.id).length;
    const told = () => s.sent.filter((e) => e.content.includes(`新卡 ${n.id}`)).length;
    let queries = 0;
    const gates: Parameters<typeof setAskReminderPorts>[0][] = [
      undefined,
      { policy: () => ({ mode: "observe", manualAfterMs: null }) },
      { policy: () => ({ mode: "off", manualAfterMs: null }) },
      { policy: () => ({ mode: "on", manualAfterMs: null }), ownerActive: () => (queries++, null) },
      { policy: () => ({ mode: "on", manualAfterMs: null }), ownerActive: async () => (queries++, { active: false, evidence: "away" }) },
    ];
    for (const g of gates) {
      setAskReminderPorts(g);
      await sweepExpired();
      expect([published(), told()]).toEqual([0, 0]);
      expect(getAsk(openLedger(s.path), n.id)!.extra.remindNotice).toBe("pending");
    }
    expect(queries).toBe(2);
    setAskReminderPorts({ policy: () => ({ mode: "on", manualAfterMs: null }), ownerActive: async () => ({ active: true, evidence: "later" }) });
    await sweepExpired();
    await sweepExpired();
    expect([published(), told()]).toEqual([1, 1]);
    expect(getAsk(openLedger(s.path), n.id)!.extra.remindNotice).toBe("done");
  });
  test("活跃查询悬着时 owner 改 on→off / on→observe / 暂停：回来不推不告诉、待办留着；恢复后补一次，原卡仍 expired", async () => {
    const n = await pendingReminder();
    const orig = String(n.extra.recoveryOf);
    const published = () => s.asks.filter((e) => (e.data as { askId: string }).askId === n.id).length;
    const told = () => s.sent.filter((e) => e.content.includes(`新卡 ${n.id}`)).length;
    const flips: { mode: "off" | "observe" | "on"; paused: boolean }[] = [
      { mode: "off", paused: false },
      { mode: "observe", paused: false },
      { mode: "on", paused: true },
    ];
    for (const flip of flips) {
      const st = { mode: "on" as "on" | "off" | "observe", paused: false };
      setAskReminderPorts({
        policy: () => ({ mode: st.mode, manualAfterMs: null }),
        paused: () => st.paused,
        // 查询悬着的这段时间里 owner 动了手，然后才返回「活跃」
        ownerActive: async () => (await Promise.resolve(), Object.assign(st, flip), { active: true, evidence: "heartbeat" }),
      });
      await sweepExpired();
      expect([published(), told()]).toEqual([0, 0]);
      expect(getAsk(openLedger(s.path), n.id)!.extra.remindNotice).toBe("pending");
    }
    setAskReminderPorts({ policy: () => ({ mode: "on", manualAfterMs: null }), paused: () => false, ownerActive: async () => ({ active: true, evidence: "later" }) });
    await sweepExpired();
    await sweepExpired();
    expect([published(), told()]).toEqual([1, 1]);
    expect(getAsk(openLedger(s.path), n.id)!.extra.remindNotice).toBe("done");
    expect(getAsk(openLedger(s.path), orig)!.state).toBe("expired");
    expect(reminders()).toHaveLength(1);
  });
});
