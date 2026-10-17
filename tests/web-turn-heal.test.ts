/**
 * agents-TURNSTUCK1:回合结束后网页卡「思考中」、侧栏卡「工作中」。
 * store 级:真 ChatStore,fetch 一律 404(列表 / 历史 / 流都拿不到),流用假 reader 装成「健康」——正是事故现场:
 * ping 照常到、done 已收,旧的反向对齐只布判活探针,迟到的 busy 轮询把锁重新锁上。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";
import { healRelock, healTick, newTurnHeal, noteListRequest, noteTurnDone, type HealView } from "../web/features/chat/turn-heal";
import { AGENT_LIST_TIMEOUT_MS } from "../web/features/chat/agent-list-state";

interface Agent { name: string; status: string; busy?: boolean }
interface Msg { id: string; role: "user" | "assistant" | "system"; content: string; ts: string }
interface Store {
  readonly state: { activeAgent: string; streaming: boolean; messages: Msg[] };
  produce(fn: (s: { activeAgent: string; streaming: boolean; messages: Msg[] }) => void): void;
  loadAgents(reason: "poll"): Promise<void>;
  bgTaskStart(id: string, kind: "subagent" | "shell", title: string): void;
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
const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
beforeAll(async () => {
  globalThis.fetch = notFound;
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "" });
  // 根 tsc 解析不了 chat-store 牵到的 zenith 别名,按运行时路径导入
  const spec = "@/features/chat/chat-store";
  ({ ChatStore } = (await import(spec)) as { ChatStore: new () => Store });
});
afterAll(() => void (globalThis.fetch = realFetch));
afterEach(() => void ((Date.now = realNow), (globalThis.fetch = notFound)));

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
  /** 走真实的 /agents 请求链(loader → fetch):请求现在发出,resolve 时落地 busy */
  function pendingAgents(store: Store, busy: boolean) {
    let land!: () => void;
    const gate = new Promise<void>((r) => (land = r));
    globalThis.fetch = (async (input: unknown) => {
      if (!String(input).includes("/agents")) return new Response("{}", { status: 404 });
      await gate;
      return new Response(JSON.stringify({ ok: true, agents: [{ name: "a", status: "active", busy }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const done = store.loadAgents("poll");
    return async () => (land(), await done);
  }

  test("[验收线 1] 收到 done 后,请求早于 done 发出的 busy:true 轮询不把 streaming 置回 true", async () => {
    const { store, logs } = setup();
    store.produce((s) => void (s.streaming = true));
    const land = pendingAgents(store, true); // Stop 之前发出的轮询
    advance(1_000);
    store.endTurn(false, true); // 主回合结束,后台子 agent 还在跑
    expect(store.state.streaming).toBe(false);
    advance(30_000); // 落地再晚也是迟到的
    await land();
    expect(store.state.streaming).toBe(false);
    expect(logs.some((l) => l.startsWith("heal: 补锁被拒") && l.includes("agent=a"))).toBe(true);
  });

  test("done 之后才发出的 busy 请求,落地离 done 再近也照常补锁(新回合)", async () => {
    const { store, logs } = setup();
    store.endTurn();
    advance(1_000);
    const land = pendingAgents(store, true);
    advance(1_000);
    await land();
    expect(store.state.streaming).toBe(true);
    expect(logs.some((l) => l.startsWith("heal: 补锁 agent=a"))).toBe(true);
  });

  test("补锁后只来后台事件(bg-start)、仍在全量对齐节流期内 → 两拍空闲照样直接解锁,不走对齐", () => {
    const { store, poll, busyLive, reconnects } = setup();
    store.produce((s) => void (s.streaming = true)); // 先来一次真实漏收 done → 全量对齐,占住 60s 节流
    advance(15_000);
    poll(false);
    advance(15_000);
    poll(false);
    expect(reconnects).toEqual([{ force: true }]);
    expect(store.state.streaming).toBe(false);
    store.lastEventSeq = 7;
    advance(15_000);
    poll(true); // busy 判定跳了一下 → 补锁
    expect(store.state.streaming).toBe(true);
    store.lastEventSeq = 8;
    store.bgTaskStart("t1", "subagent", "后台子 agent"); // 只有后台活动,没有主回合内容
    advance(15_000);
    poll(false);
    advance(15_000);
    poll(false);
    expect(store.state.streaming).toBe(false);
    expect(busyLive()).toBe(false);
    expect(reconnects).toEqual([{ force: true }]);
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
      const id = `m${i}`;
      store.produce((s) => void s.messages.push({ id, role: "assistant", content: "x".repeat(i + 1), ts: "" })); // 主回合内容
      poll(i === 0 ? false : true); // 第一拍刚起步瞬时空闲
    }
    expect(store.state.streaming).toBe(true);
    expect(reconnects).toEqual([]);
  });

  test("拿不到发出时刻时:done 之后超过请求超时窗口才落地的 busy 照常补锁", () => {
    const { store, poll } = setup();
    store.endTurn();
    advance(AGENT_LIST_TIMEOUT_MS + 1);
    poll(true);
    expect(store.state.streaming).toBe(true);
  });
});

describe("纯判定", () => {
  const v = (over: Partial<HealView> = {}): HealView => ({
    now: 100_000, agent: "a", streaming: false, browsing: false, cur: { status: "active", busy: true }, mark: "1:assistant:5:0:0:0", ...over,
  });

  test("补锁:本地已锁 / 浏览历史 / 非 active 不补", () => {
    expect(healRelock(newTurnHeal(), v({ streaming: true })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v({ browsing: true })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v({ cur: { status: "stopped", busy: true } })).kind).toBe("none");
    expect(healRelock(newTurnHeal(), v()).kind).toBe("lock");
  });

  test("补锁后主回合来过内容 → 不快解,两拍空闲按节流走全量对齐", () => {
    const h = newTurnHeal();
    healRelock(h, v());
    const idle = (over: Partial<HealView>) => healTick(h, v({ streaming: true, cur: { status: "active", busy: false }, ...over }));
    const mark = "2:assistant:3:0:0:0";
    expect(idle({ mark }).kind).toBe("none");
    expect(idle({ mark }).kind).toBe("realign");
    // 60s 内不再对齐
    expect(idle({ mark, now: 130_000 }).kind).toBe("none");
    expect(idle({ mark, now: 131_000 }).kind).toBe("none");
  });

  test("done 清掉补锁记号;本地解锁后补锁记号作废", () => {
    const h = newTurnHeal();
    healRelock(h, v());
    noteTurnDone(h, "a", 100_500);
    expect(h.healLock).toBeNull();
    const h2 = newTurnHeal();
    healRelock(h2, v());
    healTick(h2, v({ streaming: false }));
    expect(h2.healLock).toBeNull();
  });

  test("迟到按会话、按请求发出时刻判:别的会话的 done 不挡,done 之后发出的不挡", () => {
    const h = newTurnHeal();
    noteTurnDone(h, "b", 99_000);
    noteListRequest(h, 98_000);
    expect(healRelock(h, v()).kind).toBe("lock"); // a 没有 done
    const h2 = newTurnHeal();
    noteListRequest(h2, 98_000);
    noteTurnDone(h2, "a", 99_000);
    expect(healRelock(h2, v()).kind).toBe("late");
    noteListRequest(h2, 99_001);
    expect(healRelock(h2, v({ now: 99_500 })).kind).toBe("lock");
  });
});
