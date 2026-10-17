import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { answerAcp, liveAcpButtons, onAcpFrame, onAcpHostGone } from "../src/bridge/acp-link.ts";
import { useAcpQuotaPort } from "../src/bridge/acp-quota.ts";
import { onAsk, setAsksForTest } from "../src/bridge/asks.ts";
import { openRuntimeAsk, resetRuntimeAsksForTest, settleRuntimeAsk, settleRuntimeAskInstance } from "../src/bridge/ask-runtime.ts";
import { setExtensionSocket } from "../src/bridge/pi-abort.ts";
import { closeLedger, openLedger } from "../src/lib/ledger-store.ts";
import { closeAsk, getAsk, listAsks, type Ask } from "../src/lib/ledger-asks.ts";
import { tempLedgerPath } from "./ledger-test-helpers.ts";

// 额度卡经 acp-link 的端到端（QWC-1）：卡面前几行、Codex 同账号、重报不换代、备用链 on 的切 / 切回 / 切了没成。基础的代际 / 认领 / 409 在 tests/acp-link.test.ts

const CH = "local-acp-quota-link";
const ledgerPath = tempLedgerPath("acp-quota-link-");
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

async function frameAndAsk(frame: ReturnType<typeof quota>, s: ReturnType<typeof sock>): Promise<Ask> {
  let unsubscribe = () => {};
  const next = new Promise<Ask>((resolve) => {
    unsubscribe = onAsk((a) => { if (a.fromChannelId === frame.channelId && a.source === "codex" && a.state === "open") resolve(a); });
  });
  try {
    await onAcpFrame(frame, s, discord);
    return await next;
  } finally {
    unsubscribe();
  }
}

beforeAll(() => {
  openLedger(ledgerPath);
  setAsksForTest({ path: ledgerPath, registry: [], ownerChats: [] });
  resetRuntimeAsksForTest();
  setExtensionSocket((ch) => sockets.get(ch), {
    deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any,
    hold: () => { throw new Error("ACP quota fixture must not queue a voided-message echo"); },
  });
});

afterAll(() => {
  resetRuntimeAsksForTest();
  setAsksForTest(undefined);
  closeLedger(ledgerPath);
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

  test("身份无记录 / 查询抛错：全局 on、项目 off 仍出普通卡，宿主收不到 set_config", async () => {
    const asks: any[] = [];
    const unsub = onAsk((a) => void asks.push(a));
    try {
      for (const throws of [false, true]) {
        const s = sock(CH);
        useAcpQuotaPort({
          codexQuota: async () => null,
          fallbackConfig: () => ({ mode: "on", chain: ["ds"], projects: { p: { mode: "off" } } }),
          agentOf: async () => { if (throws) throw new Error("registry unavailable"); return undefined; },
        });
        await onAcpFrame(quota(`quota:unknown-${throws}`, "Go usage limit exceeded: unknown identity"), s, discord);
        expect(s.sent.filter((f) => f.op === "set_config")).toHaveLength(0);
        onAcpHostGone(CH, s);
      }
      await new Promise((r) => setTimeout(r, 50));
      const opened = asks.filter((a) => a.state === "open" && a.extra.raw === "Go usage limit exceeded: unknown identity");
      expect(opened).toHaveLength(2);
      expect(opened.every((a) => a.extra.quota === true && a.context.split("\n")[2].includes("无法核对项目"))).toBe(true);
    } finally {
      unsub();
      useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined });
    }
  });

  test("备用链 on 切换没成：出额度卡，第 3 行写没成的原因；同一个失败重报不再试", async () => {
    const s = sock(CH);
    useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => ({ name: "agent-x" }) });
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
    useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => ({ name: "agent-x" }) });
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
  const on = (codexQuota: () => Promise<null>) => useAcpQuotaPort({ codexQuota, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => ({ name: "agent-x" }) });
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

describe("额度去重按宿主连接隔离", () => {
  const CH3 = "local-acp-quota-restart";
  const frame = { ...quota("quota:same-session#1", "Go usage limit exceeded"), channelId: CH3 };
  const calls = (s: { sent: any[] }) => s.sent.filter((f) => f.type === "acp_call");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const fail = async (s: ReturnType<typeof sock>, ok: boolean) => {
    const done = onAcpFrame(frame, s, discord);
    await tick();
    const call = calls(s).at(-1);
    if (call) await onAcpFrame({ type: "acp_call_result", channelId: CH3, id: call.id, ok, error: "refused" }, s, discord);
    await done;
  };
  beforeAll(() => useAcpQuotaPort({
    codexQuota: async () => null, fallbackConfig: () => ({ mode: "on", chain: ["ds"] }), agentOf: async () => ({ name: "agent-x" }),
  }));
  afterAll(() => useAcpQuotaPort());

  for (const ok of [true, false]) test(`旧宿主自动切换${ok ? "成功" : "失败"}：新连接同 key 重新切，同连接只切一次`, async () => {
    const old = sock(CH3);
    await fail(old, ok);
    expect(calls(old)).toHaveLength(1);
    await onAcpFrame(frame, old, discord);
    expect(calls(old)).toHaveLength(1);
    const previous = liveAcpButtons(CH3).quota;
    const fresh = sock(CH3);
    try {
      await fail(fresh, true);
      expect(calls(fresh)).toHaveLength(1);
      expect(liveAcpButtons(CH3).quota).not.toEqual(previous);
      onAcpHostGone(CH3, old); // 延迟到达的旧连接 close 不能清新卡
      expect(liveAcpButtons(CH3).quota).toHaveLength(2);
    } finally {
      onAcpHostGone(CH3, fresh);
    }
  });

  test("当前宿主断线：清额度按钮、旧卡失效，同连接对象重新报也不继承已尝试", async () => {
    const s = sock(CH3);
    await fail(s, false);
    const old = liveAcpButtons(CH3).quota[0]!;
    onAcpHostGone(CH3, s);
    expect(liveAcpButtons(CH3).quota).toEqual([]);
    expect((await answerAcp(CH3, old, who)).status).toBe(409);
    await fail(s, true);
    expect(calls(s)).toHaveLength(2);
    onAcpHostGone(CH3, s);
  });
});

describe("宿主断线只撤对应代际的额度卡", () => {
  beforeAll(() => useAcpQuotaPort({ codexQuota: async () => null, fallbackConfig: () => undefined, agentOf: async () => undefined }));
  afterAll(() => useAcpQuotaPort());

  for (const kind of ["auth", "error", "tmux-quota"] as const) for (const pending of [false, true]) {
    test(`额度卡 → ${kind} 卡${pending ? "尚在创建" : "已经打开"} → 断线：后卡保持 open`, async () => {
      const ch = `local-acp-quota-hostgone-${kind}-${pending}`;
      const s = sock(ch);
      const q = await frameAndAsk({ ...quota(`quota:${ch}`, "usage limit"), channelId: ch }, s);
      const button = liveAcpButtons(ch).quota[0]!;
      const replacement = { type: "acp_failure", channelId: ch,
        failure: { kind, key: `${kind}:${ch}`, message: kind === "auth" ? "not logged in" : "cyber policy blocked", retry: false } };
      let unsubscribe = () => {};
      let opened = false;
      const next = new Promise<Ask>((resolve) => {
        unsubscribe = onAsk((a) => {
          if (a.fromChannelId === ch && a.source === "codex" && a.state === "open" && a.id !== q.id) opened = true, resolve(a);
        });
      });
      try {
        const incoming = kind === "tmux-quota" ? openRuntimeAsk({ source: "codex", channelId: ch, agentName: ch,
          kind: "decide", title: "Codex tmux 额度卡", context: "usage limit from tmux", options: [], quota: true }) : onAcpFrame(replacement, s, discord);
        if (pending) {
          expect(opened).toBe(false);
          onAcpHostGone(ch, s);
        }
        await incoming;
        const card = await next;
        if (!pending) onAcpHostGone(ch, s);
        expect(getAsk(openLedger(ledgerPath), q.id)?.state).toBe("cancelled");
        expect(getAsk(openLedger(ledgerPath), card.id)?.state).toBe("open");
        expect(card.title).toContain(kind === "auth" ? "需要 owner 登录" : kind === "error" ? "回合失败" : "tmux 额度卡");
        if (kind === "error") expect(card.extra.failure).toBe("error");
        if (kind === "tmux-quota") expect(card.extra).toMatchObject({ quota: true, raw: "usage limit from tmux" });
        expect(liveAcpButtons(ch).quota).toEqual([]);
        expect((await answerAcp(ch, button, who)).status).toBe(409);
      } finally {
        unsubscribe();
        onAcpHostGone(ch, s);
      }
    });
  }

  test("槽位仍是这张额度卡：断线照常撤卡", async () => {
    const ch = "local-acp-quota-hostgone-owned";
    const s = sock(ch);
    const card = await frameAndAsk({ ...quota(`quota:${ch}`, "usage limit"), channelId: ch }, s);
    onAcpHostGone(ch, s);
    expect(getAsk(openLedger(ledgerPath), card.id)?.state).toBe("cancelled");
    expect(liveAcpButtons(ch).quota).toEqual([]);
  });

  for (const mode of ["pending", "adopt", "suppressed"] as const) {
    test(`按 instance 结卡涵盖 ${mode} 槽位，旧入口继续能结后来的无 instance 卡`, async () => {
      const ch = `local-acp-quota-instance-${mode}`;
      const input = { source: "codex" as const, channelId: ch, agentName: ch, kind: "decide" as const,
        title: "Codex 额度卡", context: "usage limit", options: [], quota: true as const, instance: `quota-${mode}` };
      const db = openLedger(ledgerPath);
      if (mode !== "pending") {
        await openRuntimeAsk(input);
        if (mode === "suppressed") closeAsk(db, listAsks(db, { source: "codex", states: ["open"] }).find((a) => a.fromChannelId === ch)!.id, "expired");
        resetRuntimeAsksForTest();
      }
      const building = openRuntimeAsk(input);
      settleRuntimeAskInstance("codex", ch, input.instance);
      await building;
      expect(listAsks(db, { source: "codex", states: ["open"] }).filter((a) => a.fromChannelId === ch)).toEqual([]);
      // 清掉已匹配的 suppressed 槽也要记消失：同样的卡再出现应当重新开，而不是一直压住。
      await openRuntimeAsk(input);
      expect(listAsks(db, { source: "codex", states: ["open"] }).filter((a) => a.fromChannelId === ch)).toHaveLength(1);
      await openRuntimeAsk({ ...input, instance: undefined, title: "Codex 登录卡" });
      settleRuntimeAskInstance("codex", ch, input.instance);
      expect(listAsks(db, { source: "codex", states: ["open"] }).filter((a) => a.fromChannelId === ch)).toHaveLength(1);
      settleRuntimeAsk("codex", ch);
      expect(listAsks(db, { source: "codex", states: ["open"] }).filter((a) => a.fromChannelId === ch)).toEqual([]);
    });
  }
});
