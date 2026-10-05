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
async function expiringAuthorize(): Promise<Ask> {
  const env: Envelope = {
    from: { kind: "local", channelId: "111", ws }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content: "发 v2.32.0 吗",
    meta: { messageId: "reply_1", triggerKind: "agent_tool", ts: at, threadId: "thr_1", components: BUTTONS },
  };
  await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => ({ envelope: e, outcome: { kind: "sent", discordMessageIds: [] } }), { kind: "authorize", bind: RELEASE });
  openLedger(s.path).run("UPDATE asks SET expiresAt = ? WHERE id = ?", [Date.now() - 1000, env.meta.askId!]);
  return getAsk(openLedger(s.path), env.meta.askId!)!;
}
const reminders = () => listAsks(openLedger(s.path)).filter((a) => a.extra.recoveryOf);

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
});
