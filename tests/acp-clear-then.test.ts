/**
 * ACP /clear 带 then（save-clear 回读交接，CXS-1 r1 P1）：宿主换代成功后、恢复入站之前把回读槽排到队首，
 * 轮换期间到的入站排它后面——回读是新会话真正的第一轮。失败 / 不带 then 时行为和以前一样。
 * 真 AcpTurnLoop + 真 rotateAcpHost（lib/acp/clear.ts），会话打桩；帧形状走真 acp-link。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AcpTurnLoop, type TurnIO } from "../src/lib/acp/turn.js";
import { clearThen, rotateAcpHost } from "../src/lib/acp/clear.js";
import { RpcLostError } from "../src/lib/acp/rpc.js";
import type { AcpSession } from "../src/lib/acp/session.js";

function rig(registryOk = true) {
  const prompts: string[] = [];
  const io: TurnIO = {
    prompt: async (text) => (prompts.push(text), { kind: "done" }),
    reportStop: async () => ({}),
    onFailure: () => {},
    log: () => {},
  };
  const loop = new AcpTurnLoop(io);
  const gate = Promise.withResolvers<void>();
  const session = { sessionId: "old", create: async () => (await gate.promise, (session.sessionId = "new")), prompt: async () => ({ kind: "done" }) };
  const rotate = (then?: { text: string; opId: string }) => rotateAcpHost({
    session: session as unknown as AcpSession, ready: true, pending: false, loop, oldId: "old", cwd: "/tmp", then,
    rotateRegistry: async () => (registryOk ? { ok: true } : { ok: false, error: "registry 写不进" }),
    configure: async () => {}, begin() {}, failed() {}, committed: async () => {}, end() {},
  });
  const settled = async (n: number) => {
    for (let i = 0; i < 50 && prompts.length < n; i++) await Bun.sleep(1);
  };
  return { loop, gate, rotate, prompts, settled };
}

const THEN = { text: "【回读交接】", opId: "restore-a" };

describe("rotateAcpHost then", () => {
  test("复现测试：轮换挂起时到的入站，不能抢在回读之前跑", async () => {
    const r = rig();
    const done = r.rotate(THEN);
    await r.loop.submit("普通入站", "m1"); // 宿主挂起中：入站留在队列
    r.gate.resolve();
    expect(await done).toEqual({ ok: true, sessionId: "new" });
    await r.settled(2);
    expect(r.prompts).toEqual(["【回读交接】", "普通入站"]);
    expect(r.loop.slotStatus("restore-a")).toMatchObject({ state: "ended", outcome: "done" });
  });

  test("不带 then：和以前一样，入站照常第一个跑", async () => {
    const r = rig();
    const done = r.rotate();
    await r.loop.submit("普通入站", "m1");
    r.gate.resolve();
    expect(await done).toEqual({ ok: true, sessionId: "new" });
    await r.settled(1);
    expect(r.prompts).toEqual(["普通入站"]);
  });

  test("换代失败：then 不提交（查不到这一槽），入站照常跑", async () => {
    const r = rig(false);
    const done = r.rotate(THEN);
    await r.loop.submit("普通入站", "m1");
    r.gate.resolve();
    expect(await done).toMatchObject({ ok: false, error: expect.stringContaining("registry") });
    await r.settled(1);
    expect(r.prompts).toEqual(["普通入站"]);
    expect(r.loop.slotStatus("restore-a")).toEqual({ state: "gone", opId: "restore-a" });
  });

  test("session/new 发出后超时：按「变了」处理（适配器可能已停掉旧线程，宿主要重起接回）", async () => {
    for (const [err, want] of [[new RpcLostError("session/new 超时（90000ms）", true), true], [new RpcLostError("连接已断", false), false]] as const) {
      const changed: boolean[] = [];
      const loop = new AcpTurnLoop({ prompt: async () => ({ kind: "done" }), reportStop: async () => ({}), onFailure: () => {}, log: () => {} });
      const session = { sessionId: "old", create: async () => { throw err; } };
      const r = await rotateAcpHost({
        session: session as unknown as AcpSession, ready: true, pending: false, loop, oldId: "old", cwd: "/tmp",
        rotateRegistry: async () => ({ ok: true }), configure: async () => {}, begin() {}, failed: (c) => void changed.push(c), committed: async () => {}, end() {},
      });
      expect(r.ok).toBe(false);
      expect(changed).toEqual([want]);
    }
  });

  test("clearThen：形状不对就当没带（clear 照旧）", () => {
    expect(clearThen(THEN)).toEqual(THEN);
    for (const bad of [undefined, null, "x", {}, { text: "", opId: "a" }, { text: "x", opId: "../a" }, { text: "x", opId: 1 }, { text: 1, opId: "a" }]) {
      expect(clearThen(bad)).toBeUndefined();
    }
  });
});

describe("acp-link acpClear 帧", () => {
  const CH = "local-clear-then-frame";
  const frames: Record<string, unknown>[] = [];
  let bridge!: typeof import("../src/bridge/acp-link.ts");
  const sock = {
    send: (d: string) => {
      const f = JSON.parse(d);
      frames.push(f);
      queueMicrotask(() => void bridge.onAcpFrame({ type: "acp_call_result", id: f.id, ok: true, sessionId: "new", channelId: CH }, sock, {} as never));
    },
  };
  beforeAll(async () => {
    bridge = await import("../src/bridge/acp-link.ts");
    const { setExtensionSocket } = await import("../src/bridge/pi-abort.ts");
    setExtensionSocket((ch) => (ch === CH ? sock : undefined), {
      deliver: async () => undefined, ownerId: () => "", books: () => ({}) as never, hold: () => { throw new Error("unused"); },
    });
  });
  afterAll(() => frames.splice(0));

  test("不带 then：帧和回包与改动前逐字一样", async () => {
    expect(await bridge.acpClear(CH)).toEqual({ ok: true, sessionId: "new" });
    expect(Object.keys(frames.at(-1)!).sort()).toEqual(["id", "op", "type"]);
    expect(frames.at(-1)).toMatchObject({ type: "acp_call", op: "clear" });
  });

  test("带 then：帧里多一个 then 字段，回包不变", async () => {
    expect(await bridge.acpClear(CH, THEN)).toEqual({ ok: true, sessionId: "new" });
    expect(frames.at(-1)).toMatchObject({ type: "acp_call", op: "clear", then: THEN });
  });
});
