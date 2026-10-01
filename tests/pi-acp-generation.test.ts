/**
 * Pi 适配器的「代」：/clear（再来一次 session/new）作废旧 pi 的一切在途请求。审查复现：prompt 已发给 pi、确认还没回时 /clear，
 * 旧 pi 收尾时吐出确认 + agent_settled 再退出 → 修前旧 prompt 在清理之后才登记等待、永远没回包（还可能被新会话的回合错误兑现）。
 * 用真 piLinkOver（每条记录一个宏任务，与生产同）+ 可控的假 pi 进程。
 */
import { describe, expect, test } from "bun:test";
import { piLinkOver, type PiProc } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import { createRpcPeer, type RpcWire } from "../src/lib/acp/rpc.ts";

type Rec = Record<string, any>;

const STARTUP: Record<string, unknown> = {
  get_state: { model: { provider: "ds", id: "v4", name: "V4" }, thinkingLevel: "off" },
  get_available_models: { models: [{ provider: "ds", id: "v4", name: "V4" }] },
  get_available_thinking_levels: { levels: ["off"] },
};

/** 假 pi：hold(cmd) 为 true 的命令先压着不回；stop() 时先跑 onStop（模拟退出前吐的收尾输出），过一会儿才真退出 */
function fakePi(hold: (cmd: Rec) => boolean) {
  let onData: (c: string) => void = () => {};
  const closeCbs: ((why: string) => void)[] = [];
  const held: Rec[] = [];
  let exit!: (code: number) => void;
  const emit = (...recs: Rec[]) => onData(`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const respond = (cmd: Rec, data: unknown) => emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
  const pi = {
    held,
    emit,
    respond,
    onStop: () => {},
    proc: {
      wire: {
        write(line: string) {
          const cmd = JSON.parse(line);
          if (hold(cmd)) held.push(cmd);
          else respond(cmd, STARTUP[cmd.type] ?? {});
        },
        onData: (cb) => void (onData = cb as (c: string) => void),
        onClose: (cb) => void closeCbs.push(cb),
        close: () => {},
      },
      stop: () => {
        pi.onStop();
        setTimeout(() => (closeCbs.splice(0).forEach((cb) => cb("exit 0")), exit(0)), 20);
      },
      exited: new Promise<number>((r) => (exit = r)),
    } satisfies PiProc,
  };
  return pi;
}

function pipePair(): [RpcWire, RpcWire] {
  const side = () => ({ data: (_: string) => {}, close: (_: string) => {} });
  const a = side(), b = side();
  const wire = (me: ReturnType<typeof side>, peer: ReturnType<typeof side>): RpcWire => ({
    write: (line) => peer.data(line), onData: (cb) => void (me.data = cb as (c: string) => void), onClose: (cb) => void (me.close = cb),
    close: (why) => (peer.close(why), me.close(why)),
  });
  return [wire(a, b), wire(b, a)];
}

function harness(...pis: ReturnType<typeof fakePi>[]) {
  const [host, adapter] = pipePair();
  let n = 0;
  new PiAcpServer(adapter, {
    openPi: () => piLinkOver(pis[n++]!.proc, () => {}), newSessionId: () => `s${n + 1}`, log: () => {}, exit: () => {},
  });
  const rpc = createRpcPeer(host, { log: () => {} });
  const updates: Rec[] = [];
  rpc.onNotification("session/update", (p: Rec) => void updates.push(p));
  const req = (method: string, params: Rec) => rpc.request<Rec>(method, params, { timeoutMs: 2_000 });
  const prompt = (sessionId: string, text: string) => req("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  return { req, prompt, updates, open: () => req("session/new", { cwd: "/w", mcpServers: [] }) };
}

const settle = (pi: ReturnType<typeof fakePi>) => pi.emit({ type: "agent_start" }, { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } }, { type: "agent_settled" });

describe("Pi 适配器 · /clear 作废旧一代", () => {
  test("/clear 发生在 prompt 已提交、确认未回：旧 prompt 以错误收尾不悬着；新会话的回合照常、不被旧等待冒领", async () => {
    const pi1 = fakePi((c) => c.type === "prompt");
    const pi2 = fakePi((c) => c.type === "prompt");
    const h = harness(pi1, pi2);
    expect((await h.open()).sessionId).toBe("s1");
    const old = h.prompt("s1", "long").then((r) => ({ ok: r }), (e: Error) => ({ err: e.message }));
    await Bun.sleep(10);
    expect(pi1.held.map((c) => c.type)).toEqual(["prompt"]);
    pi1.onStop = () => (pi1.respond(pi1.held[0]!, { disposition: "started" }), settle(pi1)); // 关闭收尾时吐出确认和 settled
    expect((await h.open()).sessionId).toBe("s2");
    expect(await old).toEqual({ err: expect.stringContaining("会话被换掉或关闭了") });

    const fresh = h.prompt("s2", "hi");
    await Bun.sleep(10);
    pi2.respond(pi2.held[0]!, { disposition: "started" });
    settle(pi2);
    expect(await fresh).toEqual({ stopReason: "end_turn" });
  });

  test("旧一代迟到的用量 / steer 确认不记到新会话头上", async () => {
    const pi1 = fakePi((c) => c.type === "get_session_stats" || c.type === "prompt");
    const pi2 = fakePi(() => false);
    const h = harness(pi1, pi2);
    await h.open();
    const steer = h.req("_session/steering", { sessionId: "s1", prompt: [{ type: "text", text: "x" }] }).then((r) => ({ ok: r }), (e: Error) => ({ err: e.message }));
    await Bun.sleep(10);
    settle(pi1); // 上一回合结束 → 适配器去取用量（压着）
    await Bun.sleep(10);
    const [prompt, stats] = [pi1.held.find((c) => c.type === "prompt")!, pi1.held.find((c) => c.type === "get_session_stats")!];
    pi1.onStop = () => (pi1.respond(stats, { contextUsage: { tokens: 999, contextWindow: 1000 } }), pi1.respond(prompt, { disposition: "started" }));
    await h.open();
    await Bun.sleep(40);
    expect(await steer).toEqual({ err: expect.stringContaining("会话被换掉或关闭了") });
    expect(h.updates.filter((u) => u.update.sessionUpdate === "usage_update")).toEqual([]);
    expect(h.updates.every((u) => u.sessionId === "s1")).toBe(true); // s2 还没有任何回合
  });
});
