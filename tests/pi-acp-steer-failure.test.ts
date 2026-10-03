/**
 * steering 另起的回合失败要出卡、报 StopFailure（#300 r1 P1-1），失败按种类进额度 / 登录通道（P2-1）。
 * 真 AcpTurnLoop + AcpSession + PiAcpServer + piLinkOver，假 pi 在内存里。审查复现：第一轮结束、宿主还在等 Stop hook 时来了第二条消息
 * → steering → pi 另起一轮 → 这一轮以 provider 错误收尾。修前 idle 是中性的，宿主报两次 Stop、不出卡。Codex 的 idle 不带结局，解释不变。
 */
import { describe, expect, test } from "bun:test";
import type { AcpFailure } from "../src/lib/acp/failures.ts";
import { piLinkOver, type PiProc } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import type { RpcWire } from "../src/lib/acp/rpc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import { AcpTurnLoop } from "../src/lib/acp/turn.ts";

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

/** 假 pi：followUp 的 prompt 正常收尾；steer 的 prompt 另起一轮，以 steerError 收尾（不给就正常） */
function fakePi(errors: { steer?: string; prompt?: string }): PiProc {
  let onData: (c: string) => void = () => {};
  const emit = (...recs: Rec[]) => onData(`${recs.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const turn = (error?: string) => [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", content: [], stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}) } },
    { type: "agent_settled" },
  ];
  return {
    wire: {
      write(line) {
        const c = JSON.parse(line);
        const ok = (data: unknown = {}) => ({ id: c.id, type: "response", command: c.type, success: true, data });
        if (c.type === "get_state") return emit(ok({ model: { provider: "ds", id: "v4" }, thinkingLevel: "off" }));
        if (c.type !== "prompt") return emit(ok());
        emit(ok({ disposition: "started" }), ...turn(c.streamingBehavior === "steer" ? errors.steer : errors.prompt));
      },
      onData: (cb) => void (onData = cb as (c: string) => void),
      onClose: () => {},
      close: () => {},
    },
    stop: () => {},
    exited: new Promise(() => {}),
  };
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 3_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等不到：${what}`);
    await Bun.sleep(5);
  }
}

async function run(errors: { steer?: string; prompt?: string }) {
  const [host, adapter] = pipePair();
  new PiAcpServer(adapter, { openPi: () => piLinkOver(fakePi(errors), () => {}), newSessionId: () => "s1", log: () => {}, exit: () => {} });
  const session = new AcpSession(host, { onUpdate: () => {}, onPermission: async () => null, log: () => {}, label: "Pi" });
  const stops: string[] = [];
  const failures: AcpFailure[] = [];
  let releaseFirst = () => {};
  const loop = new AcpTurnLoop({
    prompt: (t) => session.prompt(t),
    steer: (t) => session.steer(t),
    reportStop: async (r) => {
      stops.push(r.event);
      if (stops.length === 1) await new Promise<void>((res) => (releaseFirst = res)); // 第一轮的 Stop hook 迟迟不回
      return {};
    },
    onFailure: (f) => void failures.push(f),
    log: () => {},
  });
  await session.initialize();
  await session.create("/w");
  return { session, loop, stops, failures, release: () => releaseFirst() };
}

describe("steering 另起的回合失败", () => {
  for (const [error, kind] of [
    ["401 Unauthorized: invalid API key", "auth"],
    ["429 insufficient_quota: credits exhausted", "quota"],
    ["429 Too Many Requests: rate limit reached", "error"],
    ["socket hang up", "error"],
  ] as const) {
    test(`${error} → StopFailure + 失败卡（${kind}）`, async () => {
      const h = await run({ steer: error });
      expect(await h.loop.submit("one")).toBe("prompt");
      await until(() => h.stops.length === 1, "第一轮报 Stop（hook 压着）");
      expect(await h.loop.submit("two")).toBe("steer");
      h.release();
      await until(() => h.stops.length === 2, "插话那一轮上报");
      expect(h.stops).toEqual(["Stop", "StopFailure"]);
      expect(h.failures).toEqual([expect.objectContaining({ kind, message: `Pi 回合失败：${error}` })]);
      if (error.includes("rate limit")) expect(h.failures[0]).toMatchObject({ retry: true }); // 暂时限流：可重试，不进额度通道
    });
  }

  test("插话那一轮正常收尾仍是 Stop（中性结局不误报失败）", async () => {
    const h = await run({});
    await h.loop.submit("one");
    await until(() => h.stops.length === 1, "第一轮");
    expect(await h.loop.submit("two")).toBe("steer");
    h.release();
    await until(() => h.stops.length === 2, "插话那一轮");
    expect(h.stops).toEqual(["Stop", "Stop"]);
    expect(h.failures).toEqual([]);
  });
});

describe("普通 prompt 的失败也带结构化种类（P2-1）", () => {
  test("401 → auth、429 insufficient_quota → quota，原因原样带上", async () => {
    for (const [error, kind] of [["401 Unauthorized", "auth"], ["429 insufficient_quota", "quota"]] as const) {
      const h = await run({ prompt: error });
      expect(await h.session.prompt("x")).toEqual({ kind: "failed", failure: expect.objectContaining({ kind, message: `Pi 回合失败：${error}` }) });
    }
  });
});
