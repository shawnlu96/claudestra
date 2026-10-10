// 自研 Codex 适配器的回合状态机（CX-2）：宿主真用的 AcpSession 在环，假 app-server 按剧本出事件。用例名前缀是设计里的 B / R 编号。
import { describe, expect, test } from "bun:test";
import { AcpTurnLoop, type StopReport } from "../src/lib/acp/turn.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { FailureDedup, type AcpFailure } from "../src/lib/acp/failures.ts";
import type { SteerResult } from "../src/lib/acp/turn.ts";
import { harness, tick, until, type Rec } from "./helpers/codex-fake-app.ts";

const idleOf = (u: Rec) => u._meta?.codex?.threadStatus?.type === "idle";

describe("握手与基本回合", () => {
  test("B1 B2 B5 initialize：ACP v1、身份、resume / fork、steering；app-server 只握手一次", async () => {
    const h = harness();
    const caps = await h.session.initialize();
    await h.session.initialize({ fork: true });
    expect(caps).toEqual({ resume: true, fork: true });
    expect(h.session.agentInfo).toEqual({ name: "claudestra-codex-acp", version: "test" });
    expect(h.session.steering).toBe(true);
    expect(h.f.calls("initialize")).toHaveLength(1);
    expect(h.f.calls("initialize")[0].clientInfo).toEqual({ name: "claudestra-acp-host", version: "1", title: "Codex ACP" });
    expect(h.f.sent.filter((m) => m.method === "initialized")).toHaveLength(1);
  });

  test("B16 B43 prompt：turn/start 带对账键和模式策略；正文拼对；idle 先于回包，每轮恰好一对 active / idle", async () => {
    const h = harness();
    await h.open();
    h.f.on("turn/start", (_p, id) => {
      const turnId = (h.f.turn = h.f.nextTurn());
      h.f.feed({ id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      h.f.started(turnId);
      h.f.text(turnId, "m1", "你");
      h.f.text(turnId, "m1", "好");
      h.f.complete(turnId);
      return undefined;
    });
    expect(await h.session.prompt("在吗")).toEqual({ kind: "done" });
    const start = h.f.calls("turn/start")[0];
    const input = [{ type: "text", text: "在吗", text_elements: [] }];
    expect(start).toMatchObject({ threadId: "th-1", input, approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, model: "gpt-x", effort: "medium" });
    expect(start.clientUserMessageId).toMatch(/^[0-9a-f-]{36}$/);
    const tr = createAcpTranslator(() => "t");
    const texts = [...h.updates.flatMap((u) => tr.push(u)), ...tr.flush()].map((e) => e.message?.content?.[0]?.text).filter(Boolean);
    expect(texts).toEqual(["你好"]);
    expect(h.statuses()).toEqual(["active", "idle"]);
    const out = h.out();
    const idleAt = out.findIndex((m) => idleOf(m.params?.update ?? {}));
    const respAt = out.findIndex((m) => m.result?.stopReason === "end_turn");
    expect(idleAt).toBeGreaterThan(-1);
    expect(idleAt).toBeLessThan(respAt);
    expect(out[idleAt]!.params.update._meta.claudestra.turn).toEqual({ stopReason: "end_turn" });
  });

  test("B26 R14 两个 prompt 并发：第二个回 -32600", async () => {
    const h = harness();
    await h.open();
    h.f.on("turn/start", () => undefined);
    const first = h.session.prompt("一");
    await until(() => h.f.calls("turn/start").length === 1, "第一个 turn/start");
    const second = await h.session.prompt("二");
    expect(second).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("同一时刻只能有一轮") } });
    expect(h.f.calls("turn/start")).toHaveLength(1);
    void first;
  });
});

/** 手动驱动 turn/start：回包由测试决定何时、和什么放在同一个 chunk */
function manualStart(h: ReturnType<typeof harness>) {
  const ids: number[] = [];
  h.f.on("turn/start", (_p, id) => void ids.push(id));
  return { ids, turn: (i: number) => `M${i}`, resp: (i: number) => ({ id: ids[i]!, result: { turn: { id: `M${i}`, items: [], status: "inProgress" } } }) };
}
const started = (h: ReturnType<typeof harness>, t: string) => ({ method: "turn/started", params: { threadId: h.f.thread, turn: { id: t, items: [], status: "inProgress" } } });
const completed = (h: ReturnType<typeof harness>, t: string, status = "completed", error: Rec | null = null) => ({
  method: "turn/completed",
  params: { threadId: h.f.thread, turn: { id: t, items: [], status, error } },
});
const rawStatus = (h: ReturnType<typeof harness>, type: string) => ({ method: "thread/status/changed", params: { threadId: h.f.thread, status: { type } } });

describe("I3 行序与早到缓冲", () => {
  test("R1 steer 另起：同一个 chunk 里 start 回包、turn/completed、原始 idle → 线路上 steer 回包先于 idle，done 正常兑现", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const steer = h.session.steer("插一句");
    await until(() => m.ids.length === 1, "steer 的 turn/start");
    h.f.feed(m.resp(0), started(h, "M0"), completed(h, "M0"), rawStatus(h, "idle"));
    const r = (await steer) as Extract<SteerResult, { outcome: "startedNewTurn" }>;
    expect(r.outcome).toBe("startedNewTurn");
    expect(await r.done).toEqual({ kind: "done" });
    const out = h.out();
    const steerAt = out.findIndex((x) => x.result?.outcome === "startedNewTurn");
    const idleAt = out.findIndex((x) => idleOf(x.params?.update ?? {}));
    expect(steerAt).toBeGreaterThan(-1);
    expect(steerAt).toBeLessThan(idleAt);
    expect(h.statuses()).toEqual(["active", "idle"]);
  });

  test("R11 turn/started、turn/completed 都早于 start 回包（prompt 和 steer 两种来源）：归到对的回合，steer 回包先于 idle、prompt 回包晚于 idle", async () => {
    for (const origin of ["prompt", "steer"] as const) {
      const h = harness();
      await h.open();
      const m = manualStart(h);
      const p = origin === "prompt" ? h.session.prompt("p") : h.session.steer("s");
      await until(() => m.ids.length === 1, "turn/start");
      h.f.feed(started(h, "M0"), { method: "item/agentMessage/delta", params: { threadId: h.f.thread, turnId: "M0", itemId: "a", delta: "早" } }, completed(h, "M0"), m.resp(0));
      const r = await p;
      const done = origin === "prompt" ? r : await (r as Extract<SteerResult, { outcome: "startedNewTurn" }>).done;
      expect(done).toEqual({ kind: "done" });
      const out = h.out();
      const idleAt = out.findIndex((x) => idleOf(x.params?.update ?? {}));
      const respAt = out.findIndex((x) => x.result !== undefined && (x.result.stopReason || x.result.outcome));
      expect(origin === "prompt" ? idleAt < respAt : respAt < idleAt).toBe(true);
      expect(h.updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "早")).toBe(true);
      expect(h.causes).toEqual([]);
    }
  });

  test("R2 上一轮的原始 idle 迟到、中间插进 steer 另起的回合：done 只在新回合收尾时兑现", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"), completed(h, "M0"));
    expect(await p).toEqual({ kind: "done" });
    const steer = h.session.steer("二");
    await until(() => m.ids.length === 2, "steer 的 turn/start");
    h.f.feed(m.resp(1), rawStatus(h, "idle"));
    const r = (await steer) as Extract<SteerResult, { outcome: "startedNewTurn" }>;
    let settled = false;
    void r.done.then(() => (settled = true));
    await tick(20);
    expect(settled).toBe(false);
    h.f.feed(completed(h, "M1"));
    expect(await r.done).toEqual({ kind: "done" });
  });

  test("R3 待开始期间来了 steer：拿到 turnId 后 turn/steer 注入，不另起", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    const steer = h.session.steer("二");
    await tick(10);
    expect(h.f.calls("turn/steer")).toHaveLength(0);
    h.f.feed(m.resp(0), started(h, "M0"));
    h.f.turn = "M0";
    expect(await steer).toEqual({ outcome: "injected" });
    expect(h.f.calls("turn/steer")[0]).toMatchObject({ expectedTurnId: "M0", input: [{ text: "二" }] });
    h.f.feed(completed(h, "M0"));
    expect(await p).toEqual({ kind: "done" });
    expect(h.f.calls("turn/start")).toHaveLength(1);
  });
});

describe("取消（I4、B21）", () => {
  test("R4 待开始期间 cancel：拿到 turnId 立刻 interrupt，prompt 回 cancelled", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    await h.session.cancel();
    await tick(10);
    h.f.feed(m.resp(0));
    await until(() => h.f.calls("turn/interrupt").length === 1, "interrupt");
    expect(h.f.calls("turn/interrupt")[0]).toEqual({ threadId: "th-1", turnId: "M0" });
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
  });

  test("R5 cancel 和 completed 撞在一起：prompt 回 cancelled，只收尾一次，信封不带失败", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"));
    await until(() => h.statuses().length === 1, "active");
    await h.session.cancel();
    await until(() => h.f.calls("turn/interrupt").length === 1, "适配器收到 cancel");
    h.f.feed(completed(h, "M0", "completed")); // interrupt 还没生效，回合照常完成
    expect(await p).toEqual({ kind: "cancelled" });
    expect(h.statuses()).toEqual(["active", "idle"]);
    expect(h.updates.find(idleOf)!._meta.claudestra.turn).toEqual({ stopReason: "cancelled" });
  });

  test("R37 对已经 interrupt 过的回合再 cancel：不发第二个 interrupt；下一轮正常开始、正常结束", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"));
    await h.session.cancel();
    await h.session.cancel();
    await tick(10);
    expect(h.f.calls("turn/interrupt")).toHaveLength(1);
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
    const p2 = h.session.prompt("二");
    await until(() => m.ids.length === 2, "第二轮");
    h.f.feed(m.resp(1), started(h, "M1"), completed(h, "M1"));
    expect(await p2).toEqual({ kind: "done" });
    expect(h.f.calls("turn/interrupt")).toHaveLength(1);
  });

  test("R24⑤ B21 cancel 时本地排着 3 个 steer：全部回 failed，app-server 没收到新的 turn/start", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    const steers = [h.session.steer("a"), h.session.steer("b"), h.session.steer("c")];
    await tick(10);
    await h.session.cancel();
    expect(await Promise.all(steers)).toEqual([{ outcome: "failed" }, { outcome: "failed" }, { outcome: "failed" }]);
    h.f.feed(m.resp(0));
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
    await tick(20);
    expect(h.f.calls("turn/start")).toHaveLength(1);
    expect(h.f.calls("turn/steer")).toHaveLength(0);
  });

  test("R38 B60 interrupt 时命令还在跑（只有 item/started）：收尾补一条 failed，宿主翻出 is_error 的 tool_result", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("跑命令");
    await until(() => m.ids.length === 1, "turn/start");
    const item = { type: "commandExecution", id: "c1", command: "sleep 30", cwd: "/w", status: "inProgress", commandActions: [] };
    h.f.feed(m.resp(0), started(h, "M0"), { method: "item/started", params: { threadId: h.f.thread, turnId: "M0", item } });
    await until(() => h.updates.some((u) => u.sessionUpdate === "tool_call"), "tool_call");
    await h.session.cancel();
    h.f.feed(completed(h, "M0", "interrupted"));
    expect(await p).toEqual({ kind: "cancelled" });
    const tr = createAcpTranslator(() => "t");
    const entries = h.updates.flatMap((u) => tr.push(u));
    const result = entries.find((e) => e.message?.content?.[0]?.type === "tool_result")?.message.content[0];
    expect(result).toMatchObject({ tool_use_id: "c1", is_error: true });
    const failedAt = h.updates.findIndex((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    expect(failedAt).toBeLessThan(h.updates.findIndex(idleOf));
  });

  test("R39 已 injected 的 steer 被 interrupt 吞掉：发「已丢弃」提示；观测不完整时改说「可能没有执行」", async () => {
    for (const degraded of [false, true]) {
      const h = harness();
      await h.open();
      const m = manualStart(h);
      const p = h.session.prompt("一");
      await until(() => m.ids.length === 1, "turn/start");
      h.f.feed(m.resp(0), started(h, "M0"));
      h.f.turn = "M0";
      expect(await h.session.steer("帮我把第二件事也做了")).toEqual({ outcome: "injected" });
      if (degraded) h.f.feed({ method: "item/agentMessage/delta", params: { threadId: h.f.thread, turnId: "M0", itemId: 5, delta: "x" } });
      await h.session.cancel();
      h.f.feed(completed(h, "M0", "interrupted"));
      await p;
      const notice = h.updates.map((u) => u._meta?.claudestra?.notice).find(Boolean) as string;
      expect(notice).toContain(degraded ? "可能没有执行" : "已丢弃");
      expect(notice).toContain("帮我把第二件事也做了");
    }
  });
});

/** 宿主的回合循环接在 session 上：数出卡和 Stop 上报 */
function withLoop(h: ReturnType<typeof harness>) {
  const cards: AcpFailure[] = [];
  const stops: StopReport[] = [];
  const steers: string[] = [];
  const dedup = new FailureDedup();
  let hold: Promise<void> | null = null;
  const loop = new AcpTurnLoop({
    prompt: (t) => h.session.prompt(t), steer: (t) => (steers.push(t), h.session.steer(t)), log: () => {},
    reportStop: async (r) => (stops.push(r), await hold, {}), onFailure: (f) => void (dedup.admit(f) && cards.push(f)),
  });
  /** 让下一次 Stop 上报停住，直到返回的函数被调用（模拟宿主在报 Stop 时收到插话） */
  const holdStop = () => {
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    return () => ((hold = null), release());
  };
  return { loop, cards, stops, steers, holdStop };
}

describe("非 prompt 回合的失败出口（B55）", () => {
  const FAILS: [string, Rec, Partial<AcpFailure>][] = [
    ["额度", { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" }, { kind: "quota" }],
    ["限流", { message: "slow down", codexErrorInfo: "rateLimitExceeded" }, { kind: "error", retry: true }],
    ["策略拒绝", { message: "policy", codexErrorInfo: "cyberPolicy" }, { kind: "error", retry: false }],
    ["上下文耗尽", { message: "ctx", codexErrorInfo: "contextWindowExceeded" }, { kind: "error", newSession: true }],
  ];
  for (const [what, error, want] of FAILS) {
    test(`R19 startedNewTurn 之后失败（${what}）：宿主按信封出 1 张卡、报 StopFailure`, async () => {
      const h = harness();
      await h.open();
      const w = withLoop(h);
      const m = manualStart(h);
      const release = w.holdStop();
      w.loop.submit("一");
      await until(() => m.ids.length === 1, "prompt 的 turn/start");
      h.f.feed(m.resp(0), started(h, "M0"), completed(h, "M0"));
      await until(() => w.stops.length === 1, "第一轮 Stop");
      void w.loop.submit("二"); // 宿主在报 Stop 时插话：走 steer，适配器另起一轮
      await until(() => w.steers.length === 1, "宿主发 steer");
      release();
      await until(() => m.ids.length === 2, "steer 的 turn/start");
      h.f.feed(m.resp(1), started(h, "M1"), completed(h, "M1", "failed", error));
      await until(() => w.stops.length >= 2, "第二轮 Stop");
      expect(w.cards).toHaveLength(1);
      expect(w.cards[0]).toMatchObject({ ...want, key: "air:M1:error" });
      expect(w.stops[1]).toMatchObject({ event: "StopFailure" });
    });
  }

  test("R20 自发回合失败：宿主当外部回合跟，1 张卡、StopFailure", async () => {
    const h = harness();
    await h.open();
    const w = withLoop(h);
    (h.session as any).deps.onSelfTurn = (d: any) => w.loop.track(d);
    h.f.feed(started(h, "S1"));
    await until(() => h.statuses().length === 1, "自发回合 active");
    h.f.feed(completed(h, "S1", "failed", { message: "boom", codexErrorInfo: "serverOverloaded" }));
    await until(() => w.stops.length === 1, "Stop");
    expect(w.cards).toEqual([expect.objectContaining({ kind: "error", retry: true, key: "air:S1:error", message: "boom" })]);
    expect(w.stops[0]).toMatchObject({ event: "StopFailure" });
  });

  test("R21 自发回合被取消：宿主得到 cancelled，StopFailure 带 interrupt，不出卡", async () => {
    const h = harness();
    await h.open();
    const w = withLoop(h);
    (h.session as any).deps.onSelfTurn = (d: any) => w.loop.track(d);
    h.f.feed(started(h, "S1"));
    await until(() => h.statuses().length === 1, "自发回合 active");
    h.f.feed(completed(h, "S1", "interrupted"));
    await until(() => w.stops.length === 1, "Stop");
    expect(w.cards).toEqual([]);
    expect(w.stops[0]).toEqual({ event: "StopFailure", stopHookActive: false, interrupt: true });
  });
});

describe("坏消息与线程级状态（I10）", () => {
  test("R13 收尾 status 是不认识的值：L 类，能关联，这一轮按协议错误失败（不重试）", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"), completed(h, "M0", "weird"));
    expect(await p).toMatchObject({ kind: "failed", failure: { kind: "error", retry: false, key: "air:M0:error" } });
    expect(h.causes).toEqual([]);
  });

  test("R16 turn/completed 坏掉（缺 status，turn.id 可读）：这一轮失败收尾，连接不作废", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), { method: "turn/completed", params: { threadId: h.f.thread, turn: { id: "M0", items: [] } } });
    expect(await p).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("turn/completed") } });
    expect(h.causes).toEqual([]);
  });

  test("R17 缺 turnId：作废连接，在途 prompt 失败，没有挂起", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), { method: "turn/completed", params: { threadId: h.f.thread, turn: {} } });
    expect(await p).toMatchObject({ kind: "failed" });
    expect(h.causes[0]).toMatchObject({ kind: "protocol" });
  });

  test("R25 R26 线程级通知：合法的 active / idle 只核对；不认识的状态有回合时让它失败、没回合只告警一次；缺 threadId 作废连接", async () => {
    const h = harness();
    await h.open();
    h.f.feed(rawStatus(h, "active"), rawStatus(h, "idle"), rawStatus(h, "paused"), rawStatus(h, "paused"));
    await tick(10);
    expect(h.statuses()).toEqual([]);
    expect(h.logs.filter((l) => l.includes("不合格的 thread/status/changed"))).toHaveLength(1);
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), rawStatus(h, "paused"));
    expect(await p).toMatchObject({ kind: "failed", failure: { retry: false } });
    h.f.feed({ method: "thread/status/changed", params: { status: { type: "idle" } } });
    await until(() => h.causes.length === 1, "作废连接");
    expect(h.causes[0]).toMatchObject({ kind: "protocol", why: expect.stringContaining("缺 threadId") });
  });

  test("R18 只有确认、一直没有终态：看门狗探 thread/read，active 继续等，idle 失败收尾；探测失败作废连接", async () => {
    const h = harness({ timings: { watchdogMs: 40 } });
    await h.open();
    const m = manualStart(h);
    const reads: string[] = ["active", "idle"];
    h.f.on("thread/read", (p) => ({ thread: { id: p.threadId, status: { type: reads.shift() ?? "idle" } } }));
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0));
    expect(await p).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("idle") } });
    expect(h.f.calls("thread/read").length).toBeGreaterThanOrEqual(2);
    expect(h.f.calls("thread/read")[0]).toEqual({ threadId: "th-1", includeTurns: false });

    const h2 = harness({ timings: { watchdogMs: 40 } });
    await h2.open();
    const m2 = manualStart(h2);
    h2.f.on("thread/read", (_p, id) => void queueMicrotask(() => h2.f.fail(id, -32603, "boom")));
    const p2 = h2.session.prompt("一");
    await until(() => m2.ids.length === 1, "turn/start");
    h2.f.feed(m2.resp(0));
    expect(await p2).toMatchObject({ kind: "failed" });
    expect(h2.causes[0]).toMatchObject({ kind: "protocol", why: expect.stringContaining("看门狗") });
  });
});

describe("失败回合与合成失败（I13）", () => {
  test("R41 R25 失败回合（systemError → error → turn/completed failed，之后 systemError 一直保持）：宿主恰好 1 张卡，按信封分类，下一轮正常", async () => {
    const h = harness();
    await h.open();
    const w = withLoop(h);
    const m = manualStart(h);
    w.loop.submit("一");
    await until(() => m.ids.length === 1, "turn/start");
    const err = { message: "We’re currently experiencing high demand", codexErrorInfo: "internalServerError" };
    h.f.feed(m.resp(0), started(h, "M0"), rawStatus(h, "systemError"), { method: "error", params: { threadId: h.f.thread, turnId: "M0", error: err, willRetry: false } });
    h.f.feed(completed(h, "M0", "failed", err), rawStatus(h, "systemError"));
    await until(() => w.stops.length === 1, "Stop");
    expect(w.cards).toEqual([expect.objectContaining({ kind: "error", key: "air:M0:error", retry: true, newSession: true, message: err.message })]);
    w.loop.submit("二");
    await until(() => m.ids.length === 2, "第二轮");
    h.f.feed(m.resp(1), started(h, "M1"), completed(h, "M1"));
    await until(() => w.stops.length === 2, "第二轮 Stop");
    expect(w.stops.map((s) => s.event)).toEqual(["StopFailure", "Stop"]);
    expect(w.cards).toHaveLength(1);
  });

  test("R45 systemError 之后 turn/completed 迟迟才到：合成失败 1 张卡；迟到的 completed 不出第二个 idle；下一轮先查 thread/read、interrupt 旧回合、等它收尾才 turn/start", async () => {
    const h = harness();
    await h.open();
    const w = withLoop(h);
    const m = manualStart(h);
    w.loop.submit("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"), rawStatus(h, "systemError"));
    await until(() => w.stops.length === 1, "合成失败的 Stop");
    expect(w.cards).toHaveLength(1);
    h.f.turn = "M0";
    w.loop.submit("二");
    await until(() => h.f.calls("turn/interrupt").length === 1, "interrupt 旧回合");
    expect(h.f.calls("turn/interrupt")[0]).toEqual({ threadId: "th-1", turnId: "M0" });
    expect(m.ids).toHaveLength(1);
    h.f.turn = null;
    h.f.feed(completed(h, "M0", "failed", { message: "late" }));
    await until(() => m.ids.length === 2, "下一轮 turn/start");
    h.f.feed(m.resp(1), started(h, "M1"), completed(h, "M1"));
    await until(() => w.stops.length === 2, "第二轮 Stop");
    expect(w.cards).toHaveLength(1);
    expect(h.statuses()).toEqual(["active", "idle", "active", "idle"]);
    expect(w.stops.map((s) => s.event)).toEqual(["StopFailure", "Stop"]);
  });

  test("R46 合成失败后旧回合一直不收尾：走 I12，不开第二轮；排着的消息没写出，按没投递回", async () => {
    const h = harness();
    await h.open();
    const m = manualStart(h);
    const p = h.session.prompt("一");
    await until(() => m.ids.length === 1, "turn/start");
    h.f.feed(m.resp(0), started(h, "M0"), rawStatus(h, "systemError"));
    expect(await p).toMatchObject({ kind: "failed" });
    h.f.turn = "M0";
    const p2 = await h.session.prompt("二");
    expect(h.causes[0]).toMatchObject({ kind: "stale" });
    expect(m.ids).toHaveLength(1);
    expect(p2).toMatchObject({ kind: "failed", failure: { message: expect.stringContaining("没有发给 Codex") } });
    expect(p2.kind === "failed" && p2.failure.kind === "error" && p2.failure.deliveryUnknown).toBeFalsy();
  });
});

describe("宿主没声明 AIR（B34）", () => {
  test("只有额度用完变成 -32603（codexErrorInfo），其余失败照常 end_turn；信封照样带失败", async () => {
    for (const [info, want] of [["usageLimitExceeded", { kind: "failed", failure: { kind: "quota" } }], ["serverOverloaded", { kind: "done" }]] as const) {
      const h = harness({ air: false });
      await h.open();
      h.f.on("turn/start", (_p, id) => {
        h.f.feed({ id, result: { turn: { id: "N1", items: [], status: "inProgress" } } });
        h.f.complete("N1", "failed", { message: "boom", codexErrorInfo: info });
        return undefined;
      });
      expect(await h.session.prompt("一")).toMatchObject(want);
      expect(h.updates.find(idleOf)!._meta.claudestra.turn).toMatchObject({ stopReason: "error", failure: { id: "N1:error" } });
    }
  });
});
