/**
 * ACP 宿主对「不是自己发的回合」和「停止」的处理（Pi 走 ACP 补齐 tmux 版的三样，Codex 行为不变）：
 * - Pi 自发回合（扩展 triggerTurn、压缩后续跑）：宿主报忙、跟到 idle 报 Stop；回合里叫停要真取消，不能答空闲；
 * - 叫停先 clear_queue 再 abort：steer 进去还没执行的消息被清掉，回执 voided 列出它们的 message_id；叫停中 pi 续跑的轮再中止，插话押到停稳后另起一轮；
 * - 扩展的 notify / setStatus 脱敏进日志；
 * - codex-acp：只在宿主的 prompt / steer 期间变 active，不触发自发回合；叫停照旧发 session/cancel 通知，voided 为空。
 * 宿主（AcpHost）、会话、回合调度、Pi 适配器、pi-link 都是真的；pi 和 bridge 连接是内存里的假货。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { AcpHost } from "../src/lib/acp/host.ts";
import { piLinkOver, type PiProc } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import type { PromptOutcome } from "../src/lib/acp/turn.ts";

type Rec = Record<string, any>;

function pipePair(): [RpcWire, RpcWire] {
  const side = () => ({ data: (_: string) => {}, close: (_: string) => {} });
  const a = side(), b = side();
  const wire = (me: ReturnType<typeof side>, peer: ReturnType<typeof side>): RpcWire => ({
    write: (line) => peer.data(line), onData: (cb) => void (me.data = cb as (c: string) => void), onClose: (cb) => void (me.close = cb),
    close: (why) => (peer.close(why), me.close(why)),
  });
  return [wire(a, b), wire(b, a)];
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await Bun.sleep(5);
  }
}

/**
 * 假 pi：空闲时的 prompt 当场跑完一整轮；在跑时的 prompt（steer / followUp）进队列（clear_queue 交出来）；带 `/handled` 的回 handled。
 * abort 只回包，停不停稳由单测调 settle() 决定（真 pi 的 abort 也要等回合停稳）。start / settle 模拟 pi 自己开、结束一轮
 */
function fakePi() {
  let onData: (c: string) => void = () => {};
  const cmds: Rec[] = [];
  let running = false;
  let queue: string[] = [];
  const emit = (...recs: Rec[]) => onData(`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const start = () => ((running = true), emit({ type: "agent_start" }));
  const settle = (stopReason = "stop") => ((running = false), emit({ type: "message_end", message: { role: "assistant", content: [], stopReason } }, { type: "agent_settled" }));
  const proc: PiProc = {
    wire: {
      write(line) {
        const c = JSON.parse(line);
        cmds.push(c);
        const ok = (data: unknown = {}) => emit({ id: c.id, type: "response", command: c.type, success: true, data });
        if (c.type === "clear_queue") return ok({ steering: queue.splice(0), followUp: [] });
        if (c.type !== "prompt") return ok();
        if (c.message.includes("/handled")) return ok({ disposition: "handled" });
        if (running) return queue.push(c.message), ok({ disposition: "queued" });
        ok({ disposition: "started" }), start(), settle();
      },
      onData: (cb) => void (onData = cb as (c: string) => void),
      onClose: () => {},
      close: () => {},
    },
    stop: () => {},
    exited: new Promise(() => {}),
  };
  return { proc, cmds, start, settle, emit, kinds: () => cmds.map((c) => c.type).filter((t) => t === "clear_queue" || t === "abort" || t === "prompt") };
}

/** 真 AcpHost 接 Pi 适配器 + 假 pi；bridge 连接和 /hook 是假的 */
async function piHost() {
  const pi = fakePi();
  const [hostWire, adapterWire] = pipePair();
  const logs: string[] = [];
  new PiAcpServer(adapterWire, { openPi: () => piLinkOver(pi.proc, (m) => logs.push(m)), newSessionId: () => "s1", log: (m) => logs.push(m), exit: () => {} });
  const sent: Rec[] = [];
  const stops: Rec[] = [];
  let link!: { onRegistered(): void; onFrame(m: Rec): void };
  const host = new AcpHost(
    {
      channelId: "ch", agentName: "pi-self", sessionId: "s1", cwd: "/tmp", mcpName: "claudestra", agentCmd: ["fake"],
      env: { base: {}, bunBin: "bun", channelServer: "x", mcpName: "claudestra", logsDir: "/tmp" }, timings: { retryMs: [5], drainMs: 1_000 },
    },
    {
      spawn: () => ({ wire: hostWire, stop() {}, exited: new Promise(() => {}) }),
      makeLink: (d) => ((link = d as typeof link), { connect: () => d.onRegistered(), send: (f: Rec) => (sent.push(f), true), request: async () => true, close() {}, up: true }) as any,
      startProxy: () => ({ url: "ws://127.0.0.1:1/?t=x", onBridgeFrame: () => false, failInFlight() {}, close() {} }) as any,
      postHook: async (b) => (stops.push(b), {}),
      markReady: async () => {},
      rotateSession: async () => ({ ok: true }),
      log: (m) => logs.push(m),
    },
  );
  host.start();
  await until(() => logs.some((l) => l.includes("已接上线程")), "宿主接上线程");
  const turnBusy = async (id: string) => {
    link.onFrame({ type: "acp_call", id, op: "turn" });
    await until(() => sent.some((f) => f.id === id), `turn ${id} 回包`);
    return sent.find((f) => f.id === id)!.busy;
  };
  const inbound = (content: string, message_id: string) => link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id } });
  const abort = async (id: string) => {
    link.onFrame({ type: "abort", id });
    await until(() => sent.some((f) => f.type === "abort_ack" && f.id === id), "abort_ack");
    return sent.find((f) => f.type === "abort_ack" && f.id === id)!;
  };
  return { host, pi, logs, sent, stops, turnBusy, inbound, abort };
}

describe("Pi 自发回合：宿主跟到结束", () => {
  test("pi 自己开的一轮：升级闸问到忙、idle 后报一次 Stop，回到空闲", async () => {
    const h = await piHost();
    expect(await h.turnBusy("t0")).toBe(false);
    h.pi.start();
    await until(() => h.logs.some((l) => l.includes("自己开了一轮")), "宿主认出自发回合");
    expect(await h.turnBusy("t1")).toBe(true);
    expect(h.stops).toEqual([]);
    h.pi.settle();
    await until(() => h.stops.length === 1, "自发回合报 Stop");
    expect(h.stops[0]).toMatchObject({ event: "Stop", stopHookActive: false });
    await until(() => !h.host.loop.busy, "调度器回到空闲");
    expect(await h.turnBusy("t2")).toBe(false);
    h.host.stop();
  });

  test("自发回合里叫停：先 clear_queue 再 abort，回合里 steer 进去的消息作废（voided），回合按 StopFailure+interrupt 收尾", async () => {
    const h = await piHost();
    h.pi.start();
    await until(() => h.host.loop.busy, "宿主跟上自发回合");
    h.inbound("回合中途插一句", "m-steer");
    await until(() => h.logs.some((l) => l.includes("插进当前回合")), "插话 steer 进去");
    const ack = await h.abort("a1");
    expect(ack).toEqual({ type: "abort_ack", id: "a1", result: "aborted", voided: ["m-steer"], inEditor: 0 });
    expect(h.pi.kinds()).toEqual(["prompt", "clear_queue", "abort"]);
    h.pi.settle("aborted");
    await until(() => h.stops.length === 1, "被打断的那一轮上报");
    expect(h.stops[0]).toMatchObject({ event: "StopFailure", interrupt: true });
    h.host.stop();
  });

  test("叫停中 pi 续跑的轮再中止；这期间的插话不进 pi 的队列，停稳后另起一轮", async () => {
    const h = await piHost();
    h.pi.start();
    await until(() => h.host.loop.busy, "宿主跟上自发回合");
    await h.abort("a1");
    h.pi.start(); // abort 之后 pi 自己续跑（重试 / 压缩后继续）
    await until(() => h.pi.kinds().filter((k) => k === "abort").length === 2, "续跑的那轮再中止");
    h.inbound("叫停时发来的话", "m-late");
    await until(() => h.logs.some((l) => l.includes("m-late") && l.includes("排队")), "插话押在宿主队列");
    expect(h.pi.cmds.some((c) => c.type === "prompt")).toBe(false);
    h.pi.settle("aborted");
    await until(() => h.stops.length === 2, "停稳后押着的话另起一轮");
    expect(h.stops.map((s) => s.event)).toEqual(["StopFailure", "Stop"]);
    expect(h.pi.cmds.filter((c) => c.type === "prompt").map((c) => c.streamingBehavior)).toEqual(["followUp"]);
    h.host.stop();
  });

  test("没有回合时叫停：答空闲，不发 abort", async () => {
    const h = await piHost();
    expect(await h.abort("a0")).toMatchObject({ result: "idle", voided: [] });
    expect(h.pi.kinds()).toEqual([]);
    h.host.stop();
  });
});

describe("Pi 适配器：handled 与扩展 UI", () => {
  test("handled 的扩展命令当场开了一轮：等它停稳才回；回包之后才开的由宿主当自发回合跟", async () => {
    const h = await piHost();
    h.pi.proc.wire.write = ((orig) => (line: string) => {
      const c = JSON.parse(line);
      if (c.type === "prompt" && c.message.includes("/handled-now")) return h.pi.start(), h.pi.emit({ id: c.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
      orig(line);
    })(h.pi.proc.wire.write);
    h.inbound("/handled-now", "m1");
    await Bun.sleep(30);
    expect(h.stops).toEqual([]); // 扩展开的那轮还在跑：prompt 没回
    h.pi.settle();
    await until(() => h.stops.length === 1, "handled 那一轮停稳后报 Stop");
    h.inbound("/handled-later", "m2");
    await until(() => h.stops.length === 2, "handled 立刻收尾");
    h.pi.start();
    await until(() => h.logs.some((l) => l.includes("自己开了一轮")), "回包后才开的一轮当自发回合");
    h.pi.settle();
    await until(() => h.stops.length === 3, "自发回合报 Stop");
    h.host.stop();
  });

  test("notify / setStatus 脱敏进日志；状态栏文字没变不重复记", async () => {
    const h = await piHost();
    const ui = (extra: Rec) => h.pi.emit({ type: "extension_ui_request", id: "u", ...extra });
    ui({ method: "notify", message: "subagent 完成，api_key=sk-live-abcdef1234567890", notifyType: "warning" });
    ui({ method: "setStatus", statusKey: "subagents", statusText: "2 running" });
    ui({ method: "setStatus", statusKey: "subagents", statusText: "2 running" });
    ui({ method: "setStatus", statusKey: "subagents" });
    await until(() => h.logs.some((l) => l.includes("（清除）")), "状态栏清除也记");
    const lines = h.logs.filter((l) => l.startsWith("Pi 扩展"));
    expect(lines).toEqual(["Pi 扩展通知（warning）：subagent 完成，api_key=[redacted]", "Pi 扩展状态栏 subagents：2 running", "Pi 扩展状态栏 subagents：（清除）"]);
    expect(h.logs.join("\n")).not.toContain("sk-live");
    h.host.stop();
  });
});

/** 假 codex-acp：只讲协议，线程状态放 _meta.codex（同 codex-acp 2.x 的 thread/status/changed） */
async function codexSession() {
  const sent: Rec[] = [];
  let onData: (c: string) => void = () => {};
  const wire: RpcWire = { write: (l) => void sent.push(JSON.parse(l)), onData: (cb) => void (onData = cb as typeof onData), onClose: () => {}, close: () => {} };
  const tracked: Promise<PromptOutcome>[] = [];
  const session = new AcpSession(wire, { onUpdate: () => {}, onPermission: async () => null, log: () => {}, onSelfTurn: (d) => void tracked.push(d) });
  const raw = (...msgs: Rec[]) => onData(msgs.map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n");
  const last = (method: string) => [...sent].reverse().find((m) => m.method === method);
  const reply = (method: string, result: unknown) => raw({ id: last(method)!.id, result });
  const status = (type: string, activeFlags: string[] = []) => {
    const threadStatus = { type, ...(type === "active" ? { activeFlags } : {}) };
    return { method: "session/update", params: { sessionId: "cx", update: { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus } } } } };
  };
  const init = session.initialize();
  reply("initialize", { agentCapabilities: { sessionCapabilities: { resume: {} } }, _meta: { steering: { supported: true } } });
  await init;
  const attach = session.attach("cx", "/w", true);
  reply("session/resume", {});
  await attach;
  return { session, sent, tracked, raw, reply, status };
}

describe("codex-acp：行为不变", () => {
  test("prompt 期间的 active（含 activeFlags 变化）与回包之后迟到的 idle 都不算自发回合", async () => {
    const c = await codexSession();
    const p = c.session.prompt("hi");
    c.raw(c.status("active"), c.status("active", ["waitingOnApproval"]), c.status("active"));
    c.reply("session/prompt", { stopReason: "end_turn" });
    c.raw(c.status("idle"));
    expect(await p).toEqual({ kind: "done" });
    expect(c.tracked).toEqual([]);
    expect(c.session.running).toBe(false);
  });

  test("叫停发 session/cancel 通知（不发 _claudestra/cancel），回空列表", async () => {
    const c = await codexSession();
    expect(await c.session.cancel()).toEqual([]);
    expect(c.sent.filter((m) => /cancel/.test(m.method ?? "")).map((m) => [m.method, "id" in m])).toEqual([["session/cancel", false]]);
  });

  test("回合调度器报 Stop 时插话：startedNewTurn 的 active 先于回包到 → 只跟一次（按 injected 答，那一轮由自发回合的等待收尾）", async () => {
    const c = await codexSession();
    const steer = c.session.steer("插话");
    c.raw(c.status("active"));
    expect(c.tracked).toHaveLength(1);
    c.reply("_session/steering", { outcome: "startedNewTurn" });
    expect(await steer).toEqual({ outcome: "injected" });
    c.raw(c.status("idle"));
    expect(await c.tracked[0]).toEqual({ kind: "done" });
  });

  test("Codex 真自己开了一轮（goal 续跑之类）也跟：等到 idle", async () => {
    const c = await codexSession();
    c.raw(c.status("active"));
    expect(c.session.running).toBe(true);
    expect(c.tracked).toHaveLength(1);
    c.raw(c.status("systemError"));
    expect(await c.tracked[0]).toMatchObject({ kind: "failed" });
  });
});

/**
 * 独占命令槽（codex-compact N1）走生产接线：bridge 的 acp-link（acpSlash / acpSlotStatus / acpCancelSlot）→ 内存 ws →
 * 真 AcpHost（acp_call）→ 真 AcpTurnLoop → 真 AcpSession → 假 codex-acp（只讲 JSON-RPC，session/prompt 由单测放行）。
 * 等的都是具体事件（适配器收到某个请求、宿主某行日志），不靠 sleep。
 */
type Bridge = typeof import("../src/bridge/acp-link.ts");
const SLOT_CH = "local-acp-slot";
let bridgeSock: { send(d: string): void } | undefined;
let bridge!: Bridge;

function signals() {
  const seen: string[] = [];
  const waits: { pred: (e: string) => boolean; resolve: (e: string) => void }[] = [];
  const push = (e: string) => {
    seen.push(e);
    for (const w of waits.filter((x) => x.pred(e))) waits.splice(waits.indexOf(w), 1), w.resolve(e);
  };
  const when = (pred: (e: string) => boolean) => new Promise<string>((resolve) => {
    const hit = seen.find(pred);
    if (hit !== undefined) resolve(hit);
    else waits.push({ pred, resolve });
  });
  return { seen, push, when };
}

/** 假 codex-acp：自动答 initialize / resume / steering（injected），session/prompt 挂着等 end(text) */
function fakeCodexWire(sig: ReturnType<typeof signals>) {
  let onData: (c: string) => void = () => {};
  const prompts = new Map<string, number>();
  const send = (m: Rec) => queueMicrotask(() => onData(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n"));
  const wire: RpcWire = {
    write(line) {
      const m = JSON.parse(line);
      const text = m.params?.prompt?.[0]?.text;
      sig.push(m.method === "session/prompt" || m.method === "_session/steering" ? `${m.method}:${text}` : String(m.method));
      if (m.method === "initialize") send({ id: m.id, result: { agentCapabilities: { sessionCapabilities: { resume: {} } }, _meta: { steering: { supported: true } } } });
      else if (m.method === "session/resume") send({ id: m.id, result: {} });
      else if (m.method === "_session/steering") send({ id: m.id, result: { outcome: "injected" } });
      else if (m.method === "session/prompt") prompts.set(text, m.id);
    },
    onData: (cb) => void (onData = cb as typeof onData), onClose: () => {}, close: () => {},
  };
  const end = (text: string, stopReason = "end_turn") => send({ id: prompts.get(text)!, result: { stopReason } });
  return { wire, end };
}

/** 起一个真宿主，接到 bridge 的 acp-link 上（当前登记的连接就是它）；返回事件流和操作 */
async function slotHost() {
  const sig = signals();
  const codex = fakeCodexWire(sig);
  let link!: { onRegistered(): void; onFrame(m: Rec): void };
  const ready = Promise.withResolvers<void>();
  const ws = { send: (d: string) => queueMicrotask(() => link.onFrame(JSON.parse(d))) };
  bridgeSock = ws;
  const host = new AcpHost(
    {
      channelId: SLOT_CH, agentName: "codex-slot", sessionId: "cx", cwd: "/tmp", mcpName: "claudestra", agentCmd: ["fake"],
      env: { base: {}, bunBin: "bun", channelServer: "x", mcpName: "claudestra", logsDir: "/tmp" }, timings: { retryMs: [5], drainMs: 1_000 },
    },
    {
      spawn: () => ({ wire: codex.wire, stop() {}, exited: new Promise(() => {}) }),
      makeLink: (d) => ((link = d as typeof link), {
        connect: () => d.onRegistered(), request: async () => true, close() {}, up: true,
        send: (f: Rec) => (f.type === "acp_call_result" && queueMicrotask(() => void bridge.onAcpFrame({ ...f, channelId: SLOT_CH }, ws, {} as any)), true),
      }) as any,
      startProxy: () => ({ url: "ws://127.0.0.1:1/?t=x", onBridgeFrame: () => false, failInFlight() {}, close() {} }) as any,
      postHook: async (b) => (sig.push(`hook:${b.event}`), {}),
      markReady: async () => ready.resolve(),
      rotateSession: async () => ({ ok: true }),
      log: (m) => sig.push(`log:${m}`),
    },
  );
  host.start();
  await ready.promise;
  const inbound = (content: string, message_id: string) => link.onFrame({ type: "message", content, meta: { chat_id: "api:owner", message_id } });
  const abort = (id: string) => link.onFrame({ type: "abort", id });
  return { host, sig, codex, inbound, abort, cancels: () => sig.seen.filter((e) => e === "session/cancel").length };
}

const isPrompt = (needle: string) => (e: string) => e.startsWith("session/prompt:") && e.includes(needle);

describe("独占命令槽：宿主 + bridge 接线（codex-compact N1）", () => {
  beforeAll(async () => {
    bridge = await import("../src/bridge/acp-link.ts");
    const { setExtensionSocket } = await import("../src/bridge/pi-abort.ts");
    setExtensionSocket((ch) => (ch === SLOT_CH ? bridgeSock : undefined), {
      deliver: async () => undefined, ownerId: () => "", books: () => ({}) as any, hold: () => { throw new Error("slot fixture must not echo"); },
    });
  });

  test("复现测试：/compact 槽在跑时入站排在命令之后、不发 _session/steering；在跑的槽 uncancellable、不发 session/cancel", async () => {
    const h = await slotHost();
    const sub = await bridge.acpSlash(SLOT_CH, "/compact", "op-1");
    expect(sub).toMatchObject({ ok: true, slot: { state: "running", opId: "op-1", gen: 1 } });
    const hostId = sub.slot!.hostId;
    await h.sig.when((e) => e === "session/prompt:/compact");
    h.inbound("压缩时发来的话", "m-1");
    await h.sig.when((e) => e.startsWith("log:") && e.includes("m-1"));
    expect(h.sig.seen.find((e) => e.includes("m-1"))).toContain("排队");
    expect(h.sig.seen.filter((e) => e.startsWith("_session/steering"))).toEqual([]);
    const ended = bridge.acpSlotStatus(SLOT_CH, "op-1", { hostId, gen: 1 }, 5_000);
    expect(await bridge.acpCancelSlot(SLOT_CH, "op-1", { hostId, gen: 1 })).toEqual({ ok: true, cancel: "uncancellable" });
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-1", { hostId })).toMatchObject({ ok: true, slot: { state: "running", gen: 1 } });
    h.codex.end("/compact");
    await h.sig.when(isPrompt("压缩时发来的话"));
    expect(await ended).toEqual({ ok: true, slot: { state: "ended", opId: "op-1", gen: 1, outcome: "done", hostId } });
    expect(await bridge.acpCancelSlot(SLOT_CH, "op-1", { hostId })).toEqual({ ok: true, cancel: "gone" });
    h.codex.end(h.sig.seen.find(isPrompt("压缩时发来的话"))!.slice("session/prompt:".length));
    await h.sig.when((e) => e === "log:槽 op-1#1 结束：done");
    expect(h.cancels()).toBe(0);
    h.host.stop();
  });

  test("业务轮在跑时排队的槽：cancel_slot → revoked，适配器既没收到这一槽的 prompt，也没收到 session/cancel；业务轮正常收尾", async () => {
    const h = await slotHost();
    h.inbound("业务", "m-biz");
    await h.sig.when(isPrompt("业务"));
    const sub = await bridge.acpSlash(SLOT_CH, "/compact", "op-q");
    expect(sub.slot).toMatchObject({ state: "queued", gen: 1 });
    expect(await bridge.acpCancelSlot(SLOT_CH, "op-q", { hostId: sub.slot!.hostId, gen: 1 })).toEqual({ ok: true, cancel: "revoked" });
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-q")).toMatchObject({ slot: { state: "ended", outcome: "revoked" } });
    h.codex.end(h.sig.seen.find(isPrompt("业务"))!.slice("session/prompt:".length));
    await h.sig.when((e) => e === "hook:Stop");
    await bridge.acpOpTurn(SLOT_CH, "哨兵", "op-sentinel"); // 独占槽不 steer：它开出来时，被撤的槽要是还在就会先跑
    await h.sig.when((e) => e === "session/prompt:哨兵");
    expect(h.sig.seen.filter((e) => e.startsWith("session/prompt:")).map((e) => e.includes("业务") ? "业务" : e.slice(15))).toEqual(["业务", "哨兵"]);
    expect(h.cancels()).toBe(0);
    h.host.stop();
  });

  test("停止按钮照旧只停当前业务轮；排着的槽不被它撤，也不扩大成撤槽（之后照常跑完）", async () => {
    const h = await slotHost();
    h.inbound("业务", "m-biz");
    await h.sig.when(isPrompt("业务"));
    const sub = await bridge.acpSlash(SLOT_CH, "/compact", "op-a");
    h.abort("a1");
    await h.sig.when((e) => e === "session/cancel");
    h.codex.end(h.sig.seen.find(isPrompt("业务"))!.slice("session/prompt:".length), "cancelled");
    await h.sig.when((e) => e === "session/prompt:/compact");
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-a", { hostId: sub.slot!.hostId })).toMatchObject({ slot: { state: "running", gen: 1 } });
    h.codex.end("/compact");
    await h.sig.when((e) => e === "log:槽 op-a#1 结束：done");
    expect(h.cancels()).toBe(1);
    h.host.stop();
  });

  test("op 槽独占一轮、不和相邻入站拼；同 opId 重复提交被拒；带错 gen 的查询回 gone", async () => {
    const h = await slotHost();
    h.inbound("前", "m-1");
    await h.sig.when(isPrompt("前"));
    const sub = await bridge.acpOpTurn(SLOT_CH, "保存交接", "op-s");
    expect(sub.slot).toMatchObject({ state: "queued", gen: 1 });
    expect(await bridge.acpOpTurn(SLOT_CH, "保存交接", "op-s")).toMatchObject({ ok: false });
    h.codex.end(h.sig.seen.find(isPrompt("前"))!.slice("session/prompt:".length));
    await h.sig.when((e) => e === "session/prompt:保存交接");
    h.inbound("后", "m-2");
    await h.sig.when((e) => e.startsWith("log:") && e.includes("m-2"));
    expect(h.sig.seen.find((e) => e.startsWith("log:") && e.includes("m-2"))).toContain("排队");
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-s", { gen: 99 })).toMatchObject({ ok: true, slot: { state: "gone" } });
    h.codex.end("保存交接");
    await h.sig.when(isPrompt("后"));
    expect(h.sig.seen.filter((e) => e.startsWith("session/prompt:")).map((e) => e.includes("保存交接") ? "op" : e.includes("前") ? "前" : "后")).toEqual(["前", "op", "后"]);
    h.host.stop();
  });

  test("宿主重起：新宿主不认旧 hostId 的槽（gone），不重放命令", async () => {
    const old = await slotHost();
    const sub = await bridge.acpSlash(SLOT_CH, "/compact", "op-r");
    await old.sig.when((e) => e === "session/prompt:/compact");
    old.host.stop();
    const h = await slotHost();
    const ref = { hostId: sub.slot!.hostId, gen: 1 };
    expect(sub.slot).toMatchObject({ state: "running", gen: 1 });
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-r", ref)).toMatchObject({ ok: true, slot: { state: "gone" } });
    expect(await bridge.acpCancelSlot(SLOT_CH, "op-r", ref)).toEqual({ ok: true, cancel: "gone" });
    expect(await bridge.acpSlotStatus(SLOT_CH, "op-r")).toMatchObject({ ok: true, slot: { state: "gone" } });
    expect(h.sig.seen.filter((e) => e.startsWith("session/prompt:"))).toEqual([]);
    h.host.stop();
  });
});

describe("独占命令槽：bridge 只认自己发出的调用的回包（codex-compact N1）", () => {
  test("别的连接发的、opId / gen 对不上的、形状不对的回包都不当结局", async () => {
    const sent: Rec[] = [];
    const ws = { send: (d: string) => void sent.push(JSON.parse(d)) };
    bridgeSock = ws;
    const stranger = { send: () => {} };
    const ask = (ref: { gen?: number } = {}) => {
      const p = bridge.acpSlotStatus(SLOT_CH, "op-x", ref, 5_000);
      return { p, id: sent.at(-1)!.id as string };
    };
    const a = ask({ gen: 3 });
    expect(sent.at(-1)).toMatchObject({ type: "acp_call", op: "slot_status", opId: "op-x", gen: 3, wait: true });
    const forged = { type: "acp_call_result", channelId: SLOT_CH, id: a.id, ok: true, slot: { state: "ended", opId: "op-x", gen: 3, outcome: "done", hostId: "h" } };
    await bridge.onAcpFrame(forged, stranger, {} as any);
    await bridge.onAcpFrame({ ...forged, slot: { ...forged.slot, gen: 2 } }, ws, {} as any);
    expect(await a.p).toEqual({ ok: false, error: "宿主回的槽信息和请求对不上" });
    const b = ask();
    await bridge.onAcpFrame({ ...forged, id: b.id, slot: { ...forged.slot, opId: "op-other" } }, ws, {} as any);
    expect(await b.p).toMatchObject({ ok: false });
    const c = ask();
    await bridge.onAcpFrame({ ...forged, id: c.id, slot: { ...forged.slot, outcome: "compacted" } }, ws, {} as any);
    expect(await c.p).toMatchObject({ ok: false });
    const d = ask();
    await bridge.onAcpFrame({ ...forged, id: d.id }, ws, {} as any);
    expect(await d.p).toEqual({ ok: true, slot: { state: "ended", opId: "op-x", gen: 3, outcome: "done", hostId: "h" } });
    const e = bridge.acpCancelSlot(SLOT_CH, "op-x");
    await bridge.onAcpFrame({ type: "acp_call_result", channelId: SLOT_CH, id: sent.at(-1)!.id, ok: true, cancel: "cancelled", opId: "op-x" }, ws, {} as any);
    expect(await e).toMatchObject({ ok: false });
  });
});
