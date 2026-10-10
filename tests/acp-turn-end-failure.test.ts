// 宿主侧给自研 Codex 适配器的两处兼容扩展（CX-2）：终态信封的失败分类（classifyTurnEndFailure）和 initialize 的 data.fatal。
// 重点是证明 Pi 和 codex-acp 2.1.0 不带新字段时结果和原来逐字相同。
import { describe, expect, test } from "bun:test";
import { classifyAirFailure, classifyNeutralFailure, classifyTurnEndFailure, FailureDedup } from "../src/lib/acp/failures.ts";
import { AcpIncompatibleError } from "../src/lib/acp/protocol.ts";
import { createRpcPeer, RpcError, type RpcWire } from "../src/lib/acp/rpc.ts";
import { AcpSession } from "../src/lib/acp/session.ts";
import type { PromptOutcome, SteerResult } from "../src/lib/acp/turn.ts";

/** 改动前 session.ts endOutcome 的原式（逐字搬来做对照） */
const before = (f: { kind?: unknown }, key: string, message: string) => classifyNeutralFailure(f.kind, key, message) ?? { kind: "error" as const, key, message };

describe("classifyTurnEndFailure", () => {
  test("Pi 的形状（只有 kind / message）：每种 kind 都和原式逐字相同", () => {
    for (const kind of ["quota", "auth", "rate_limit", "error", "weird", undefined, 3, null]) {
      expect(classifyTurnEndFailure({ kind, message: "m" }, "status:s#1", "m")).toEqual(before({ kind }, "status:s#1", "m"));
    }
  });

  test("带 id：键改成 air:<id>，和 prompt 回包的 AIR 失败共用同一个键，FailureDedup 只放过一张", () => {
    const air = { id: "T1:error", revision: 1, category: "limit", severity: "error", title: "额度用完", actions: [] };
    const fromAir = classifyAirFailure(air);
    const fromEnvelope = classifyTurnEndFailure({ kind: "quota", message: "额度用完", id: "T1:error" }, "status:s#9", "额度用完");
    expect(fromEnvelope).toEqual(fromAir);
    const d = new FailureDedup();
    expect([d.admit(fromAir), d.admit(fromEnvelope)]).toEqual([true, false]);
  });

  test("retry / newSession / deliveryUnknown 照原样带上（只给 error 种类）；键仍按 id", () => {
    const air = { id: "T2:error", revision: 1, category: "limit", severity: "error", title: "ctx", actions: ["new_session"] };
    expect(classifyTurnEndFailure({ kind: "error", message: "ctx", id: "T2:error", retry: false, newSession: true }, "k", "ctx")).toEqual(classifyAirFailure(air));
    const unknown = { kind: "error" as const, message: "m", retry: false, deliveryUnknown: true as const };
    expect(classifyTurnEndFailure(unknown, "k", "m")).toEqual({ ...unknown, key: "k" });
    expect(classifyTurnEndFailure({ kind: "rate_limit", message: "m", id: "x", retry: true }, "k", "m")).toEqual({ kind: "error", key: "air:x", message: "m", retry: true });
    expect(classifyTurnEndFailure({ kind: "auth", message: "m", retry: true, newSession: true }, "k", "m")).toEqual({ kind: "auth", key: "auth:k", message: "m" });
    expect(classifyTurnEndFailure({ kind: "error", message: "m", retry: "yes", newSession: "no", id: "" }, "k", "m")).toEqual(before({ kind: "error" }, "k", "m"));
  });
});

/** 只会做几件事的适配器（内存线路）：initialize 按给的结果回，steering 回 startedNewTurn，之后按剧本发 session/update */
function scripted(init: () => unknown) {
  const host = { data: (_: string) => {}, close: (_: string) => {} };
  const agent = { data: (_: string) => {}, close: (_: string) => {} };
  const end = (me: typeof host, peer: typeof host): RpcWire => ({
    write: (l) => queueMicrotask(() => peer.data(l)),
    onData: (cb) => void (me.data = cb as (c: string) => void),
    onClose: (cb) => void (me.close = cb),
    close: () => {},
  });
  const adapter = createRpcPeer(end(agent, host), { log: () => {} });
  adapter.onRequest("initialize", init);
  adapter.onRequest("_session/steering", () => ({ outcome: "startedNewTurn" }));
  const session = new AcpSession(end(host, agent), { onUpdate: () => {}, onPermission: async () => null, log: () => {}, label: "Pi" });
  session.sessionId = "s";
  const status = (meta: Record<string, unknown>) => adapter.notify("session/update", { sessionId: "s", update: { sessionUpdate: "session_info_update", _meta: meta } });
  return { session, status };
}
const OK_INIT = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } }, agentInfo: { name: "x", version: "1" } };

async function steerEnd(meta: Record<string, unknown>): Promise<PromptOutcome> {
  const s = scripted(() => OK_INIT);
  const r = (await s.session.steer("hi")) as Extract<SteerResult, { outcome: "startedNewTurn" }>;
  s.status({ claudestra: { threadStatus: { type: "active" } } });
  s.status(meta);
  return r.done;
}

describe("AcpSession 的回合结束（Pi / 2.1.0 不带新字段时不变）", () => {
  test("Pi：idle 带 {kind, message} 的失败 → 和原式同一个分类、同一个键", async () => {
    const out = await steerEnd({ claudestra: { threadStatus: { type: "idle" }, turn: { stopReason: "error", failure: { kind: "rate_limit", message: "Pi 回合失败：429" } } } });
    expect(out).toEqual({ kind: "failed", failure: before({ kind: "rate_limit" }, "status:s#2", "Pi 回合失败：429") });
  });

  test("2.1.0：idle 不带信封 → done；systemError → 原来的「线程出错」", async () => {
    expect(await steerEnd({ codex: { threadStatus: { type: "idle" } } })).toEqual({ kind: "done" });
    expect(await steerEnd({ codex: { threadStatus: { type: "systemError" } } })).toEqual({ kind: "failed", failure: { kind: "error", key: "status:s#2", message: "Pi 线程出错（systemError）" } });
  });

  test("自研：信封带 id / retry:false → 键 air:<id>、不可重试", async () => {
    const out = await steerEnd({ codex: { threadStatus: { type: "idle" } }, claudestra: { turn: { stopReason: "error", failure: { kind: "error", message: "拒了", id: "T3:error", retry: false } } } });
    expect(out).toEqual({ kind: "failed", failure: { kind: "error", key: "air:T3:error", message: "拒了", retry: false } });
  });
});

describe("initialize 的 data.fatal", () => {
  test("适配器明说起不来（data.fatal）→ AcpIncompatibleError，原因原样", async () => {
    const s = scripted(() => {
      throw new RpcError(-32603, "Codex 适配器拒绝启动：缺 CODEX_PATH", { fatal: true });
    });
    const err = await s.session.initialize().catch((e) => e);
    expect(err).toBeInstanceOf(AcpIncompatibleError);
    expect(err.message).toBe("Codex 适配器拒绝启动：缺 CODEX_PATH");
  });

  test("别的 initialize 错误（Pi / 2.1.0 会有的）原样抛，不当成拒起", async () => {
    for (const data of [undefined, { fatal: "yes" }, { codexErrorInfo: "x" }]) {
      const s = scripted(() => {
        throw new RpcError(-32603, "boom", data);
      });
      const err = await s.session.initialize().catch((e) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect(err).not.toBeInstanceOf(AcpIncompatibleError);
      expect(err).toMatchObject({ code: -32603, message: "boom" });
    }
  });
});
