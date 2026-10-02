/**
 * ACP 宿主对「不是自己发的回合」和「停止」的处理（Pi 走 ACP 补齐 tmux 版的三样，Codex 行为不变）：
 * - Pi 自发回合（扩展 triggerTurn、压缩后续跑）：宿主报忙、跟到 idle 报 Stop；回合里叫停要真取消，不能答空闲；
 * - 叫停先 clear_queue 再 abort：steer 进去还没执行的消息被清掉，回执 voided 列出它们的 message_id；叫停中 pi 续跑的轮再中止，插话押到停稳后另起一轮；
 * - 扩展的 notify / setStatus 脱敏进日志；
 * - codex-acp：只在宿主的 prompt / steer 期间变 active，不触发自发回合；叫停照旧发 session/cancel 通知，voided 为空。
 * 宿主（AcpHost）、会话、回合调度、Pi 适配器、pi-link 都是真的；pi 和 bridge 连接是内存里的假货。
 */
import { describe, expect, test } from "bun:test";
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
