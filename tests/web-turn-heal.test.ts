/**
 * agents-TURNSTUCK1:回合结束后网页卡「思考中」、侧栏卡「工作中」。
 * store 级:真 ChatStore,fetch 一律 404(列表 / 历史 / 流都拿不到),流用假 reader 装成「健康」——正是事故现场:
 * ping 照常到、done 已收,旧的反向对齐只布判活探针,迟到的 busy 轮询把锁重新锁上。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";
import { healRelock, healTick, newTurnHeal, noteTurnDone, type HealView } from "../web/features/chat/turn-heal";
import { AGENT_LIST_TIMEOUT_MS } from "../web/features/chat/agent-list-state";

interface Agent { name: string; status: string; busy?: boolean }
interface Store {
  readonly state: { activeAgent: string; streaming: boolean };
  produce(fn: (s: { activeAgent: string; streaming: boolean }) => void): void;
  applyAgents(next: Agent[], reason: "poll" | "event" | "action" | "manual"): void;
  endTurn(interrupted?: boolean, bgPending?: boolean): void;
  maybeReconnect(opts?: { fast?: boolean; force?: boolean }): void;
  clientLog(m: string): void;
  streamReader: unknown;
  streamAgent: string | null;
  lastStreamByteAt: number;
  lastEventSeq: number;
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
let ChatStore: new () => Store;
beforeAll(async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "" });
  // 根 tsc 解析不了 chat-store 牵到的 zenith 别名,按运行时路径导入
  const spec = "@/features/chat/chat-store";
  ({ ChatStore } = (await import(spec)) as { ChatStore: new () => Store });
});
afterAll(() => void (globalThis.fetch = realFetch));
afterEach(() => void (Date.now = realNow));

let clock = 1_800_000_000_000;
const advance = (ms: number) => void (clock += ms);

/** 打开会话 a、流健康(假 reader,刚收到字节),记下重连参数与 client.log */
function setup() {
  Date.now = () => clock;
  const store = new ChatStore();
  const reconnects: ({ fast?: boolean; force?: boolean } | undefined)[] = [];
  const logs: string[] = [];
  const real = store.maybeReconnect.bind(store);
  store.maybeReconnect = (o) => (reconnects.push(o), real(o));
  store.clientLog = (m) => void logs.push(m);
  store.produce((s) => void ((s.activeAgent = "a"), (s.streaming = false)));
  const healthy = () => {
    store.streamReader = { cancel: async () => {} };
    store.streamAgent = "a";
    store.lastStreamByteAt = clock;
  };
  healthy();
  const poll = (busy: boolean) => {
    store.lastStreamByteAt = clock; // ping 照常到
    store.applyAgents([{ name: "a", status: "active", busy }], "poll");
  };
  const busyLive = () => store.state.activeAgent === "a" && store.state.streaming; // sidebar.tsx 的口径
  return { store, reconnects, logs, poll, busyLive, healthy };
}

describe("store 级", () => {
  test("[验收线 1] 收到 done 后,请求早于 done 发出的 busy:true 轮询不把 streaming 置回 true", () => {
    const { store, poll, logs } = setup();
    store.produce((s) => void (s.streaming = true));
    advance(1_000);
    store.endTurn(false, true); // 主回合结束,后台子 agent 还在跑
    expect(store.state.streaming).toBe(false);
    advance(3_000); // Stop 之前算好的结果 done 之后才落地
    poll(true);
    expect(store.state.streaming).toBe(false);
    expect(logs.some((l) => l.startsWith("heal: 补锁被拒") && l.includes("agent=a"))).toBe(true);
  });

  test("[验收线 2] 补锁后两拍服务端空闲、流里没有回合内容 → 自动解锁,busyLive 随之 false,不走对齐", () => {
    const { store, poll, busyLive, reconnects, logs } = setup();
    poll(true); // busy 判定跳了一下
    expect(store.state.streaming).toBe(true);
    expect(logs.some((l) => l.startsWith("heal: 补锁 agent=a"))).toBe(true);
    advance(15_000);
    poll(false);
    expect(store.state.streaming).toBe(true); // 单拍不动
    advance(15_000);
    poll(false);
    expect(store.state.streaming).toBe(false);
    expect(busyLive()).toBe(false);
    expect(reconnects).toEqual([]);
    expect(logs.some((l) => l.startsWith("heal: 补锁后自动解开 agent=a"))).toBe(true);
  });

  test("[验收线 3] UI streaming、服务端连续两拍空闲 → 全量对齐(force),对齐后 streaming 为 false", () => {
    const { store, poll, reconnects, logs } = setup();
    store.produce((s) => void (s.streaming = true)); // 回合里漏收了 done
    advance(15_000);
    poll(false);
    expect(reconnects).toEqual([]);
    advance(15_000);
    poll(false);
    expect(reconnects).toEqual([{ force: true }]);
    expect(logs.some((l) => l.startsWith("reconnect(full)"))).toBe(true);
    expect(store.state.streaming).toBe(false);
  });

  test("[验收线 4] 回合真在跑(busy、流里不断有内容)不解锁不对齐;刚起步单拍 busy=false 也不触发", () => {
    const { store, poll, reconnects } = setup();
    store.produce((s) => void (s.streaming = true));
    for (let i = 0; i < 6; i++) {
      advance(15_000);
      store.lastEventSeq += 3;
      poll(i === 0 ? false : true); // 第一拍刚起步瞬时空闲
    }
    expect(store.state.streaming).toBe(true);
    expect(reconnects).toEqual([]);
  });

  test("done 之后超过请求超时窗口才落地的 busy 照常补锁(新回合)", () => {
    const { store, poll } = setup();
    store.endTurn();
    advance(AGENT_LIST_TIMEOUT_MS + 1);
    poll(true);
    expect(store.state.streaming).toBe(true);
  });
});

describe("纯判定", () => {
  const v = (over: Partial<HealView> = {}): HealView => ({
    now: 100_000, agent: "a", streaming: false, browsing: false, cur: { status: "active", busy: true }, eventSeq: 7, ...over,
  });

  test("补锁:本地已锁 / 浏览历史 / 非 active 不补", () => {
    expect(healRelock(newTurnHeal(), v({ streaming: true })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v({ browsing: true })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v({ cur: { status: "stopped", busy: true } })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v()).kind).toBe("lock");
  });

  test("补锁后流里来过事件 → 不快解,两拍空闲按节流走全量对齐", () => {
    const h = newTurnHeal();
    healRelock(h, v());
    const idle = (over: Partial<HealView>) => healTick(h, v({ streaming: true, cur: { status: "active", busy: false }, ...over }));
    expect(idle({ eventSeq: 9 }).kind).toBe("none");
    expect(idle({ eventSeq: 9 }).kind).toBe("realign");
    // 60s 内不再对齐
    expect(idle({ eventSeq: 9, now: 130_000 }).kind).toBe("none");
    expect(idle({ eventSeq: 9, now: 131_000 }).kind).toBe("none");
  });

  test("done 清掉补锁记号;本地解锁后补锁记号作废", () => {
    const h = newTurnHeal();
    healRelock(h, v());
    noteTurnDone(h, 100_500);
    expect(h.healLock).toBeNull();
    const h2 = newTurnHeal();
    healRelock(h2, v());
    healTick(h2, v({ streaming: false }));
    expect(h2.healLock).toBeNull();
  });
});
