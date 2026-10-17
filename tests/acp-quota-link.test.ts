import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { answerAcp, liveAcpButtons, onAcpFrame, onAcpHostGone } from "../src/bridge/acp-link.ts";
import { useAcpQuotaPort } from "../src/bridge/acp-quota.ts";
import { onAsk } from "../src/bridge/asks.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";

// 额度卡经 acp-link 的端到端（QWC-1）：卡面前几行、Codex 同账号、重报不换代、备用链 on 的切 / 切回 / 切了没成。基础的代际 / 认领 / 409 在 tests/acp-link.test.ts

const CH = "local-acp-quota-link";
const sockets = new Map<string, { sent: any[]; send(d: string): void }>();
const sock = (ch: string) => {
  const s = { sent: [] as any[], send: (d: string) => void s.sent.push(JSON.parse(d)) };
  sockets.set(ch, s);
  return s;
};
const discord = {} as any;
const who = { principal: "owner:self" };
const SOL = "go/deepseek-v4.1-flash", LUNA = "ds/deepseek-v4-flash";
const QUOTA_CONFIG = [{ id: "model", name: "Model", type: "select", currentValue: SOL, options: [{ value: SOL, name: "sol" }, { value: LUNA, name: "luna" }] }];
const CONFIG = [{ id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-sol", options: [{ value: "gpt-5.6-sol", name: "sol" }, { value: "gpt-5.6-luna", name: "luna" }] }];
const quota = (key: string, message: string) => ({ type: "acp_failure", channelId: CH, failure: { kind: "quota", key, message }, configOptions: QUOTA_CONFIG });

beforeAll(() => {
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("ACP quota fixture must not queue a voided-message echo"); },
  });
});

describe("额度卡（acp-link 端到端）", () => {
  beforeAll(() => useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined }));
  afterAll(() => useAcpQuotaPort());

  test("卡面带原文和到顶的 provider；Codex 形状（几个模型同一个账号）只给等重置并写明原因", async () => {
    sock(CH);
    const asks: any[] = [];
    const unsub = onAsk((a) => void asks.push(a));
    try {
      await onAcpFrame({ ...quota("air:raw", '429 {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}'), label: "Pi" }, sockets.get(CH)!, discord);
      await onAcpFrame({ ...quota("air:codex", "You've hit your usage limit."), configOptions: CONFIG }, sockets.get(CH)!, discord);
      expect(liveAcpButtons(CH).quota).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(asks.every((a) => a.extra.quota === true && typeof a.extra.raw === "string")).toBe(true);
      expect(asks.some((a) => a.context.startsWith("go 额度到顶：GoUsageLimitError: Go usage limit exceeded；重置 未知\n推荐切到 ds/"))).toBe(true);
      expect(asks.some((a) => a.context.split("\n")[1] === "只能等重置（同一个账号的另外 1 个模型也用不了）")).toBe(true);
    } finally {
      unsub();
      await answerAcp(CH, liveAcpButtons(CH).quota[0]!, who);
    }
  });

  test("同一个失败晚一分钟重报：「等重置」上的时刻变了也沿用原卡，旧按钮照样能用", async () => {
    const s = sock(CH);
    let t = Date.now();
    useAcpQuotaPort({ now: () => t, codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    try {
      await onAcpFrame(quota("air:later", "usage limit, try again in 2 hours"), s, discord);
      const first = liveAcpButtons(CH).quota;
      t += 61_000;
      await onAcpFrame(quota("air:later", "usage limit, try again in 2 hours"), s, discord);
      expect(liveAcpButtons(CH).quota).toEqual(first);
      expect((await answerAcp(CH, first[0]!, who)).status).toBe(200);
    } finally {
      useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    }
  });

  test("备用链 on 切换没成：出额度卡，第 3 行写没成的原因；同一个失败重报不再试", async () => {
    const s = sock(CH);
    useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => undefined });
    const asks: any[] = [];
    const unsub = onAsk((a) => void asks.push(a));
    try {
      const calls = () => s.sent.filter((f) => f.type === "acp_call");
      const n = calls().length;
      const done = onAcpFrame(quota("air:refused", "Go usage limit exceeded"), s, discord);
      await new Promise((r) => setTimeout(r, 0));
      await onAcpFrame({ type: "acp_call_result", channelId: CH, id: calls().at(-1).id, ok: false, error: "Invalid params" }, s, discord);
      await done;
      expect(calls()).toHaveLength(n + 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(asks.some((a) => a.context.split("\n")[2] === `按备用链切到 ${LUNA} 没成：Invalid params`)).toBe(true);
      const buttons = liveAcpButtons(CH).quota;
      await onAcpFrame(quota("air:refused", "Go usage limit exceeded"), s, discord);
      expect(calls()).toHaveLength(n + 1);
      expect(liveAcpButtons(CH).quota).toEqual(buttons);
      await answerAcp(CH, buttons[0]!, who);
    } finally {
      unsub();
      useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    }
  });

  test("备用链 on：撞墙直接切过去，通知卡上「切回原模型」经宿主切回；同一个失败重报不再切", async () => {
    const s = sock(CH);
    useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => undefined });
    try {
      const done = onAcpFrame(quota("air:auto", "Go usage limit exceeded"), s, discord);
      await new Promise((r) => setTimeout(r, 0));
      const call = s.sent.filter((f) => f.type === "acp_call").at(-1);
      expect(call).toMatchObject({ op: "set_config", configId: "model", value: LUNA });
      await onAcpFrame({ type: "acp_call_result", channelId: CH, id: call.id, ok: true }, s, discord);
      await done;
      const n = s.sent.length;
      await onAcpFrame(quota("air:auto", "Go usage limit exceeded"), s, discord);
      expect(s.sent.length).toBe(n);
      const back = answerAcp(CH, liveAcpButtons(CH).quota[0]!, who);
      await new Promise((r) => setTimeout(r, 0));
      const undo = s.sent.filter((f) => f.type === "acp_call").at(-1);
      expect(undo).toMatchObject({ op: "set_config", configId: "model", value: SOL });
      await onAcpFrame({ type: "acp_call_result", channelId: CH, id: undo.id, ok: true }, s, discord);
      expect(await back).toEqual({ status: 200, body: { ok: true, model: SOL } });
    } finally {
      useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    }
  });
});

describe("额度处理途中换了宿主（Shawn PR1701-r1 P1 stale-quota-host-switch）", () => {
  const CH2 = "local-acp-quota-swap";
  const frame = (key: string) => ({ type: "acp_failure", channelId: CH2, failure: { kind: "quota", key, message: "Go usage limit exceeded" }, configOptions: QUOTA_CONFIG });
  const calls = (x: { sent: any[] }) => x.sent.filter((f) => f.type === "acp_call");
  const on = (codexQuota: () => Promise<null>) => useAcpQuotaPort({ codexQuota, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => undefined });
  afterAll(() => useAcpQuotaPort());

  test("凑卡时（读额度快照）换了宿主：新宿主收到 0 次调用，也不出卡", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    on(async () => (await gate, null));
    const old = sock(CH2);
    const done = onAcpFrame(frame("air:swap-plan"), old, discord);
    await new Promise((r) => setTimeout(r, 0));
    const fresh = sock(CH2);
    release();
    await done;
    expect(calls(old)).toHaveLength(0);
    expect(calls(fresh)).toHaveLength(0);
    expect(liveAcpButtons(CH2).quota).toEqual([]);
  });

  test("等切换结果时换了宿主：只发给了旧宿主，新宿主 0 次调用，不出通知卡", async () => {
    on(async () => null);
    const old = sock(CH2);
    const done = onAcpFrame(frame("air:swap-switch"), old, discord);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls(old)).toHaveLength(1);
    const fresh = sock(CH2);
    onAcpHostGone(CH2, old);
    await done;
    expect(calls(fresh)).toHaveLength(0);
    expect(liveAcpButtons(CH2).quota).toEqual([]);
  });

  test("旧宿主出的额度卡，换了宿主后再点「切到 X」：409，新宿主 0 次调用", async () => {
    useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    const old = sock(CH2);
    await onAcpFrame(frame("air:swap-answer"), old, discord);
    const [, luna] = liveAcpButtons(CH2).quota;
    const fresh = sock(CH2);
    expect(await answerAcp(CH2, luna!, who)).toMatchObject({ status: 409, body: { code: "ask_stale" } });
    expect(calls(fresh)).toHaveLength(0);
    expect(liveAcpButtons(CH2).quota).toEqual([]);
  });
});
