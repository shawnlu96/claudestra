/**
 * 入站路由的 insert（JRT-3）：本机 agent 发给本机 agent 的 request，目标忙时由 Jev 判进 inbox（queue）还是插进在跑的回合（insert，不打断）。
 * 判定与权限兜底（只给本机 agent、运行时插得进才算）、三种运行时的插法、observe 只记不改、off 与改动前一致、回合中送出失败退回押后队列。
 * Jev / 忙闲 / 运行时全是替身，不打外网、不读生产状态。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { configureInboundRoute, afterInsertSend, routeAdmitsWhileBusy, routeHolds, routeInbound } from "../src/bridge/inbound-route.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { decideRoute, holdsWhileBusy, insertsWhileBusy, insertVia, routeQuestions, type RouteMode } from "../src/lib/inbound-route.js";
import { jevAsk } from "../src/lib/jev.js";
import { controlFor } from "../src/lib/runtimes/index.js";
import type { TurnState } from "../src/lib/turn-state.js";

const to = { kind: "local", channelId: "ch1", agentName: "agent-pm", ws: { send() {} } } as unknown as LocalEndpoint;
const OWNER = { kind: "user", userId: "u1", username: "owner", channelId: "c-owner" };
const AGENT = { kind: "local", channelId: "c-exec", agentName: "agent-exec" };
const PEER = { kind: "api", tokenId: "tok-p", name: "Shawn", peer: "shawn" };
const GUEST = { kind: "api", tokenId: "guest:abc", name: "访客" };
const BRIDGE = { kind: "bridge", label: "scheduler" };
let seq = 0;
const env = (content: string, from: Record<string, unknown> = AGENT, meta: Record<string, unknown> = {}): Envelope =>
  ({
    from, to, intent: "request", content,
    meta: { messageId: `i${++seq}`, triggerKind: from === PEER ? "peer_http" : "agent_tool", ts: "2026-10-17T00:00:00Z", threadId: `t${seq}`, ...meta },
  }) as unknown as Envelope;
const choice = (c: string, p = 0.95) => ({ type: "choice", choice: c, probabilities: { [c]: p }, confidence: p });
const ans = (c: string, p?: number) => ({ route_action: choice(c, p) });

const BUSY: TurnState = { main: "busy", bg: false };
const IDLE: TurnState = { main: "idle", bg: false };
const COMPACTING: TurnState = { main: "compacting", bg: false };

describe("判定与权限兜底（lib decideRoute，不信 Jev）", () => {
  const d = (from: Record<string, unknown>, a: Record<string, unknown>, insert: "steer" | "channel" | null = "steer") => decideRoute(a, { env: env("x", from), queue: [], insert });

  test("本机 agent + 运行时插得进：insert", () => {
    expect(d(AGENT, ans("insert"))).toEqual({ ok: true, route: { action: "insert", p: 0.95, via: "steer" } });
    expect(d(AGENT, ans("insert"), "channel")).toEqual({ ok: true, route: { action: "insert", p: 0.95, via: "channel" } });
  });
  test("本机 agent 但运行时插不进：排队（no_insert）", () => {
    expect(d(AGENT, ans("insert"), null)).toEqual({ ok: true, route: { action: "queue", p: 0.95 }, downgraded: "no_insert" });
  });
  test("peer / guest / owner / bridge 判了 insert：一律排队（not_agent）", () => {
    for (const f of [PEER, GUEST, OWNER, BRIDGE]) expect(d(f, ans("insert"))).toEqual({ ok: true, route: { action: "queue", p: 0.95 }, downgraded: "not_agent" });
  });
  test("agent 判了 interrupt：不打断，改插队（插不进就排队），仍记 not_owner", () => {
    expect(d(AGENT, ans("interrupt"))).toEqual({ ok: true, route: { action: "insert", p: 0.95, via: "steer" }, downgraded: "not_owner" });
    expect(d(AGENT, ans("interrupt"), null)).toEqual({ ok: true, route: { action: "queue", p: 0.95 }, downgraded: "not_owner" });
  });
  test("peer 判了 interrupt：照旧排队；owner 的 interrupt 不变", () => {
    expect(d(PEER, ans("interrupt"))).toEqual({ ok: true, route: { action: "queue", p: 0.95 }, downgraded: "not_owner" });
    expect(d(OWNER, ans("interrupt"))).toEqual({ ok: true, route: { action: "interrupt", p: 0.95 } });
  });
  test("insert 拿不准（< 0.6）：按现有规则", () => {
    expect(d(AGENT, ans("insert", 0.55))).toEqual({ ok: false, reason: "unsure" });
  });
  test("插队选项只给本机 agent 的消息", () => {
    const opts = (canInsert: boolean) => Object.keys((routeQuestions(0, canInsert).route_action as { criteria: Record<string, unknown> }).criteria);
    expect(opts(true)).toEqual(["interrupt", "insert", "merge", "queue"]);
    expect(opts(false)).toEqual(["interrupt", "merge", "queue"]);
  });
});

describe("三种运行时怎么插（RuntimeControl.insertVia → lib insertVia）", () => {
  test("Pi（tmux 扩展）与 ACP 宿主：原生 steer", () => {
    expect(insertVia(controlFor("pi").insertVia, false)).toBe("steer");
    expect(insertVia(controlFor("pi", "acp").insertVia, false)).toBe("steer");
    expect(insertVia(controlFor("codex", "acp").insertVia, true)).toBe("steer");
  });
  test("CC：回合中直投 channel；oneShot（没有看门狗兜底）插不进", () => {
    expect(insertVia(controlFor(undefined).insertVia, false)).toBe("channel");
    expect(insertVia(controlFor("claude-code").insertVia, true)).toBeNull();
  });
  test("Codex tmux 没声明：插不进", () => {
    expect(insertVia(controlFor("codex").insertVia, false)).toBeNull();
  });
});

describe("开关下的押不押（lib）", () => {
  const ins = (): Envelope => env("x", AGENT, { inboundRoute: { action: "insert", p: 0.9 } });
  test("on：insert 不押（holdsWhileBusy 不补押，insertsWhileBusy 放行），也不算能抢占", () => {
    expect(holdsWhileBusy(ins() as never, "on")).toBe(false);
    expect(insertsWhileBusy(ins() as never, "on")).toBe(true);
  });
  test("observe / off：结论不生效", () => {
    for (const m of ["observe", "off"] as RouteMode[]) expect(insertsWhileBusy(ins() as never, m)).toBe(false);
  });
});

// ── 运行时（bridge/inbound-route.ts） ─────────────────────────────────────
let mode: RouteMode = "on", turn: TurnState = BUSY, decl: "steer" | "channel" | undefined = "steer";
let asks: { questions: Record<string, unknown> }[] = [], logs: Record<string, unknown>[] = [];
let answer: Record<string, unknown> = ans("insert");
let clock = 0;
beforeEach(() => {
  mode = "on"; turn = BUSY; decl = "steer"; asks = []; logs = []; answer = ans("insert"); clock += 10_000;
  configureInboundRoute({
    ask: (async (_s: unknown, questions: Record<string, unknown>) => {
      asks.push({ questions });
      return { model: "jev-test", answers: answer, usage: { input_tokens: 1, output_tokens: 0 }, latencyMs: 5, costUsd: 0 };
    }) as unknown as typeof jevAsk,
    probe: async () => turn, queue: () => [], doing: async () => "在等 agent-exec 回报 CI 结果", insertDecl: async () => decl, readMode: () => mode,
    log: (e) => logs.push(e), now: () => clock,
  });
});
afterAll(() => configureInboundRoute({ ask: jevAsk, readMode: () => "off", log: () => {}, now: () => Date.now() }));

describe("运行时：on 档", () => {
  test("agent 的答复判 insert（Pi）：记结论、忙时不押、不抢占，日志带 insertVia", async () => {
    const e = env("CI 绿了，可以继续合并");
    await routeInbound(e, to, "agent-pm");
    expect(Object.keys((asks[0]!.questions.route_action as { criteria: object }).criteria)).toContain("insert");
    expect(e.meta.inboundRoute).toEqual({ action: "insert", p: 0.95, via: "steer" });
    expect(routeHolds(e, BUSY)).toBe(false);
    expect(routeHolds(e, COMPACTING)).toBe(true); // 压缩中照押
    expect(routeAdmitsWhileBusy(e)).toBe(false); // 不走抢占，押后队列里的也不在回合中放
    expect(logs[0]).toMatchObject({ mode: "on", pick: "insert", jev: "insert", insertVia: "steer", actual: "insert", rule: "queue", role: "agent" });
  });

  test("CC 目标：channel；oneShot 的插不进，按排队", async () => {
    decl = "channel";
    const a = env("答复：用方案 B");
    await routeInbound(a, to, "agent-pm");
    expect(a.meta.inboundRoute?.action).toBe("insert");
    const b = env("进度：跑到第 3 步", AGENT, { skipInterAgentWatchdog: true });
    await routeInbound(b, to, "agent-pm");
    expect(b.meta.inboundRoute).toEqual({ action: "queue", p: 0.95 });
    expect(logs[1]).toMatchObject({ pick: "insert", jev: "queue", downgraded: "no_insert", insertVia: "none" });
    expect(routeHolds(b, BUSY)).toBe(true);
  });

  test("运行时插不进（Codex tmux）：insert 退成排队，忙时照押", async () => {
    decl = undefined;
    const e = env("答复：用方案 B");
    await routeInbound(e, to, "agent-pm");
    expect(e.meta.inboundRoute?.action).toBe("queue");
    expect(routeHolds(e, BUSY)).toBe(true);
  });

  test("取运行时失败：按插不进，不挡投递", async () => {
    configureInboundRoute({ insertDecl: async () => { throw new Error("registry 读不到"); } });
    const e = env("答复：用方案 B");
    await routeInbound(e, to, "agent-pm");
    expect(e.meta.inboundRoute?.action).toBe("queue");
  });

  test("owner / peer 的消息：问题里没有插队选项；Jev 硬选了也不插", async () => {
    answer = ans("insert");
    const o = env("看一下这个", OWNER, { triggerKind: "user_discord" });
    await routeInbound(o, to, "agent-pm");
    expect(Object.keys((asks[0]!.questions.route_action as { criteria: object }).criteria)).not.toContain("insert");
    expect(o.meta.inboundRoute).toEqual({ action: "queue", p: 0.95 });
    const p = env("看一下这个", PEER);
    await routeInbound(p, to, "agent-pm");
    expect(p.meta.inboundRoute?.action).toBe("queue");
    expect(logs[1]).toMatchObject({ role: "peer", downgraded: "not_agent" });
  });

  test("纯进度 Jev 判 queue：照旧押到回合结束", async () => {
    answer = ans("queue");
    const e = env("进度：第 2 步做完了");
    await routeInbound(e, to, "agent-pm");
    expect(e.meta.inboundRoute?.action).toBe("queue");
    expect(routeHolds(e, BUSY)).toBe(true);
  });

  test("目标空闲：不问 Jev，直接投", async () => {
    turn = IDLE;
    const e = env("答复：用方案 B");
    await routeInbound(e, to, "agent-pm");
    expect(asks).toHaveLength(0);
    expect(routeHolds(e, IDLE)).toBe(false);
  });
});

describe("运行时：observe / off", () => {
  test("observe：照记「Jev 会 insert」，不记结论、不改投递", async () => {
    mode = "observe";
    const e = env("答复：用方案 B");
    await routeInbound(e, to, "agent-pm");
    await Bun.sleep(5); // observe 不等 Jev
    expect(e.meta.inboundRoute).toBeUndefined();
    expect(routeHolds(e, BUSY)).toBe(true);
    expect(logs[0]).toMatchObject({ mode: "observe", pick: "insert", jev: "insert", insertVia: "steer", actual: "queue" });
  });
  test("off：不问 Jev；押后与改动前一致", async () => {
    mode = "off";
    const e = env("答复：用方案 B");
    await routeInbound(e, to, "agent-pm");
    expect(asks).toHaveLength(0);
    expect(routeHolds(e, BUSY)).toBe(true);
    expect(routeHolds(e, IDLE)).toBe(false);
  });
  test("on 档记下的 insert，切回 off 后：按老规则押（不在回合中投）", () => {
    mode = "off";
    const e = env("x", AGENT, { inboundRoute: { action: "insert", p: 0.9 } });
    expect(routeHolds(e, BUSY)).toBe(true);
  });
});

describe("回合中送出之后（afterInsertSend）：失败退回押后", () => {
  const held: Envelope[] = [];
  const q = { holdEnv: (e: Envelope) => held.push(e) };
  const ins = () => env("答复：用方案 B", AGENT, { inboundRoute: { action: "insert", p: 0.9 } });
  test("ws 丢了这条（send 回 0）：押回队列", () => {
    held.length = 0;
    const e = ins();
    expect(afterInsertSend(e, BUSY, 0, q)).toBe(true);
    expect(held).toEqual([e]);
  });
  test("送出去了 / 空闲投递 / 不是 insert / 不是 on：不动", () => {
    held.length = 0;
    expect(afterInsertSend(ins(), BUSY, 120, q)).toBe(false);
    expect(afterInsertSend(ins(), BUSY, -1, q)).toBe(false); // 背压 = 已入队，会送到
    expect(afterInsertSend(ins(), IDLE, 0, q)).toBe(false);
    expect(afterInsertSend(env("x"), BUSY, 0, q)).toBe(false);
    mode = "observe";
    clock += 10_000; // 档位缓存 2 秒
    expect(afterInsertSend(ins(), BUSY, 0, q)).toBe(false);
    expect(held).toHaveLength(0);
  });
});
