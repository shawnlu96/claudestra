/**
 * Pi 压缩打断的回合按正常结束、压缩中被拒的输入等压完重投（PCF-1）。
 * pi 的 compact()（扩展 ctx.compact，如 save-compact 收尾的 request_compact；rpc compact）先 abort 在跑的回合，停稳后才发 compaction_start；
 * 压缩进行中 pi 拒收 prompt（「compaction is in progress」）。夹具 tests/fixtures/pi-acp/compaction-abort-1053.jsonl 照 10-16 10:53
 * agent-dn-review-pi 的真实序列手写（会话文件 #148-156 + host.log 的拒收），正文与路径已换掉，事件形状照 pi 1.3.0 agent-session.js。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abortedLike, createPiEventMapper, stopReasonOf, turnEnd } from "../src/lib/acp/pi-adapter/map.ts";
import type { PiLink } from "../src/lib/acp/pi-adapter/pi-link.ts";
import { PiAcpServer } from "../src/lib/acp/pi-adapter/server.ts";
import { createRpcPeer } from "../src/lib/acp/rpc.ts";
import { CWD, harness, type Line, pipePair, type Rec, until } from "./acp-contract/pi-replay.ts";

const FIXTURE_1053: Line[] = readFileSync(join(import.meta.dir, "fixtures", "pi-acp", "compaction-abort-1053.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ABORTED = { stopReason: "error", errorMessage: "This operation was aborted" };
const turnOf = (u: Rec) => u?._meta?.claudestra?.turn;

describe("map：压缩打断的中止不算失败", () => {
  test("abortedLike 认 aborted 和「…aborted」的 error，别的 error 不认", () => {
    expect(abortedLike({ stopReason: "aborted" })).toBe(true);
    expect(abortedLike(ABORTED)).toBe(true);
    expect(abortedLike({ stopReason: "error", errorMessage: "Request was aborted." })).toBe(true);
    for (const o of [{ stopReason: "error", errorMessage: "Connection error." }, { stopReason: "error" }, { stopReason: "stop" }]) expect(abortedLike(o), JSON.stringify(o)).toBe(false);
  });

  test("带 compaction 的中止 → end_turn 不带 failure；没压缩的照旧；网络错误有压缩也照旧失败；用户叫停仍是 cancelled", () => {
    expect(turnEnd({ ...ABORTED, compaction: true }, false)).toEqual({ stopReason: "end_turn" });
    expect(turnEnd({ stopReason: "aborted", compaction: true }, false)).toEqual({ stopReason: "end_turn" });
    expect(turnEnd(ABORTED, false)).toMatchObject({ stopReason: "error", failure: { message: "Pi 回合失败：This operation was aborted" } });
    expect(turnEnd({ stopReason: "error", errorMessage: "Connection error.", compaction: true }, false)).toMatchObject({ failure: { kind: "error" } });
    expect(stopReasonOf({ stopReason: "aborted" }, false)).toBe("cancelled");
    expect(stopReasonOf({ ...ABORTED, compaction: true }, true)).toBe("cancelled");
  });

  test("映射器：回合里见过 compaction_start 才带 compaction；下一回合 agent_start 清掉", () => {
    const m = createPiEventMapper();
    const end = (msg: Rec) => m.push({ type: "message_end", message: { role: "assistant", content: [], ...msg } });
    m.push({ type: "agent_start" });
    m.push({ type: "compaction_start", reason: "threshold" });
    end({ stopReason: "aborted" });
    expect(m.takeOutcome()).toEqual({ stopReason: "aborted", compaction: true });
    m.push({ type: "compaction_start", reason: "manual" }); // 停稳之后的压缩（rpc / 扩展 compact）
    m.push({ type: "agent_start" });
    end(ABORTED);
    expect(m.takeOutcome()).toEqual(ABORTED);
  });
});

describe("回放 10:53：save-compact 收尾的 request_compact", () => {
  test("被压缩打断的回合正常结束，压缩中到的消息等压完重投一次，整段没有回合失败", async () => {
    const h = harness(FIXTURE_1053);
    await h.session.initialize();
    await h.session.create(CWD);
    expect(await h.session.prompt("<channel>复核 X-1 的修复，结论写进报告并回 PM</channel>")).toEqual({ kind: "done" });
    expect(await h.session.prompt("<channel>X-2 也看一下</channel>")).toEqual({ kind: "done" });
    await until(() => h.pi.done(), "夹具回放完");
    expect(h.pi.mismatches).toEqual([]);
    const turns = h.updates.map(turnOf).filter(Boolean);
    expect(turns).toEqual([{ stopReason: "end_turn" }, { stopReason: "end_turn" }]);
    expect(h.logs.filter((l) => l.includes("等压完"))).toHaveLength(1);
  });
});

const COMPACTING = new Error("pi prompt 失败：Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");

/** 假 pi：emit 推事件；输入命令（prompt）的回包由 onInput 决定 */
function rig(onInput: (cmd: Rec, n: number) => Promise<unknown>, deps: { compactionWaitMs?: number; compactionLinkMs?: number } = {}) {
  const sent: Rec[] = [];
  let emit: (r: Rec) => void = () => {};
  const link: PiLink = {
    async command(cmd) {
      sent.push(cmd);
      if (cmd.type === "prompt") return onInput(cmd, sent.filter((c) => c.type === "prompt").length);
      return cmd.type === "get_state" ? { thinkingLevel: "off" } : {};
    },
    send: () => {}, onRecord: (cb) => void (emit = cb), onExit: () => {}, stop: () => {}, exited: Promise.resolve(0),
  };
  const [host, adapter] = pipePair();
  const logs: string[] = [];
  new PiAcpServer(adapter, { openPi: () => link, newSessionId: () => "sid", log: (m) => logs.push(m), exit: () => {}, ...deps });
  const updates: Rec[] = [];
  const rpc = createRpcPeer(host, { log: () => {} });
  rpc.onNotification("session/update", (p: Rec) => void updates.push(p.update));
  const body = (text: string) => ({ sessionId: "sid", prompt: [{ type: "text", text }] });
  return {
    sent, updates, logs, emit: (r: Rec) => emit(r),
    open: () => rpc.request("session/new", { cwd: "/w", mcpServers: [] }, { timeoutMs: 5_000 }),
    prompt: (text: string) => rpc.request("session/prompt", body(text), { timeoutMs: 5_000 }),
    steer: (text: string) => rpc.request("_session/steering", body(text), { timeoutMs: 5_000 }),
    cancel: () => rpc.request("_claudestra/cancel", { sessionId: "sid" }, { timeoutMs: 5_000 }),
  };
}

/** prompt 已发出且回包已到（适配器挂上了等停稳的 waiter）：之后再推这一轮的事件 */
const accepted = async (h: ReturnType<typeof rig>, text: string) => {
  await until(() => h.sent.some((c) => c.message === text), `${text} 发出`);
  await Bun.sleep(5);
};

/** 一轮：开始 → 最后一条助手消息 → 停稳 */
const turn = (h: ReturnType<typeof rig>, msg: Rec, settled: Rec = {}) => {
  h.emit({ type: "agent_start" });
  h.emit({ type: "message_end", message: { role: "assistant", content: [], ...msg } });
  h.emit({ type: "agent_settled", ...settled });
};

describe("server：中止收尾的回合关联压缩", () => {
  test("中止后紧接着 compaction_start → end_turn；没等到压缩 → 照旧失败；pi 明说没被 abort 的不等", async () => {
    const h = rig(async () => ({ disposition: "started" }), { compactionLinkMs: 50 });
    await h.open();
    const a = h.prompt("a");
    await accepted(h, "a");
    turn(h, ABORTED, { aborted: true });
    await Bun.sleep(10);
    expect(h.updates.map(turnOf).filter(Boolean)).toEqual([]); // 还在等是不是压缩
    h.emit({ type: "compaction_start", reason: "manual" });
    expect(await a).toEqual({ stopReason: "end_turn" });

    const b = h.prompt("b");
    await accepted(h, "b");
    turn(h, ABORTED, { aborted: true });
    await expect(b).rejects.toThrow("Pi 回合失败：This operation was aborted");

    const c = h.prompt("c");
    await accepted(h, "c");
    turn(h, ABORTED, { aborted: false });
    h.emit({ type: "compaction_start", reason: "threshold" }); // 来晚了也不算：pi 说这轮不是被 abort 的
    await expect(c).rejects.toThrow("Pi 回合失败");
  });

  test("等压缩期间来了新一轮：先报上一轮的结局再报 active", async () => {
    const h = rig(async () => ({ disposition: "started" }), { compactionLinkMs: 5_000 });
    await h.open();
    const a = h.prompt("a");
    await accepted(h, "a");
    turn(h, { stopReason: "aborted" }, { aborted: true });
    h.emit({ type: "agent_start" });
    expect(await a).toEqual({ stopReason: "cancelled" }); // 没压缩的 aborted 照旧
    const kinds = h.updates.map((u) => u?._meta?.claudestra?.threadStatus?.type).filter(Boolean);
    expect(kinds.slice(-2)).toEqual(["idle", "active"]);
  });
});

describe("server：压缩中被拒的输入", () => {
  test("prompt 被拒 → 等 compaction_end 后重投一次，回合照常结束", async () => {
    const h = rig(async (_c, n) => (n === 1 ? Promise.reject(COMPACTING) : { disposition: "started" }));
    await h.open();
    h.emit({ type: "compaction_start", reason: "manual" });
    const p = h.prompt("hi");
    await until(() => h.logs.some((l) => l.includes("等压完")), "进入等待");
    expect(h.sent.filter((c) => c.type === "prompt")).toHaveLength(1);
    h.emit({ type: "compaction_end", reason: "manual", result: {}, aborted: false });
    await until(() => h.sent.filter((c) => c.type === "prompt").length === 2, "重投");
    turn(h, { stopReason: "stop" });
    expect(await p).toEqual({ stopReason: "end_turn" });
  });

  test("压缩一直不结束 → 超时按失败报（没投出去，不带 deliveryUnknown），不再重投", async () => {
    const h = rig(async () => Promise.reject(COMPACTING), { compactionWaitMs: 30 });
    await h.open();
    h.emit({ type: "compaction_start", reason: "manual" });
    const err = await h.prompt("hi").then(() => null, (e) => e);
    expect(String(err?.message)).toContain("等上下文压缩结束超时");
    expect(err?.data?.deliveryUnknown).toBeUndefined();
    expect(h.sent.filter((c) => c.type === "prompt")).toHaveLength(1);
  });

  test("等的期间被叫停 → 不重投，prompt 以 cancelled 收尾", async () => {
    const h = rig(async (_c, n) => (n === 3 ? { disposition: "started" } : Promise.reject(COMPACTING)));
    await h.open();
    h.emit({ type: "compaction_start", reason: "manual" });
    const p = h.prompt("hi");
    await until(() => h.logs.some((l) => l.includes("等压完")), "进入等待");
    await h.cancel();
    h.emit({ type: "compaction_end", reason: "manual", aborted: true });
    expect(await p).toEqual({ stopReason: "cancelled" });
    expect(h.sent.filter((c) => c.type === "prompt")).toHaveLength(1);
    h.emit({ type: "compaction_start", reason: "manual" }); // 下一条照常：叫停没留给下一回合
    const next = h.prompt("next");
    await until(() => h.logs.filter((l) => l.includes("等压完")).length === 2, "又进入等待");
    h.emit({ type: "compaction_end", reason: "manual", result: {}, aborted: false });
    await until(() => h.sent.filter((c) => c.type === "prompt").length === 3, "重投");
    await Bun.sleep(5);
    turn(h, { stopReason: "stop" });
    expect(await next).toEqual({ stopReason: "end_turn" });
  });

  test("叫停先于拒收到达（prompt 在途时叫停、随后才被拒）→ 压完也不重投", async () => {
    let reject!: (e: Error) => void;
    const h = rig(async (_c, n) => (n === 1 ? new Promise((_r, rj) => (reject = rj)) : { disposition: "started" }));
    await h.open();
    h.emit({ type: "compaction_start", reason: "manual" });
    const p = h.prompt("hi");
    await accepted(h, "hi");
    await h.cancel();
    reject(COMPACTING);
    await until(() => h.logs.some((l) => l.includes("等压完")), "进入等待");
    h.emit({ type: "compaction_end", reason: "manual", aborted: true });
    expect(await p).toEqual({ stopReason: "cancelled" });
    expect(h.sent.filter((c) => c.type === "prompt")).toHaveLength(1);
  });

  test("steer 被拒 → 压完重投一次；别的拒绝原因照旧直接报错", async () => {
    const h = rig(async (c, n) => (n === 1 ? Promise.reject(COMPACTING) : c.message === "bad" ? Promise.reject(new Error("pi prompt 失败：nope")) : { disposition: "started" }));
    await h.open();
    h.emit({ type: "compaction_start", reason: "manual" });
    const s = h.steer("hi");
    await until(() => h.logs.some((l) => l.includes("等压完")), "进入等待");
    h.emit({ type: "compaction_end", reason: "manual", result: {}, aborted: false });
    expect(await s).toEqual({ outcome: "startedNewTurn" });
    await expect(h.steer("bad")).rejects.toThrow("nope");
    expect(h.logs.filter((l) => l.includes("等压完"))).toHaveLength(1);
  });
});
