/**
 * CC 插队的版本闸与「至少送达一次」（lib/steer-cc.ts + bridge/steer-cc.ts）：送出后记账、回发送方就销、Stop 时按 CC 那边的状态补投原文
 * （附件 / 没落盘补，CC 自己还排着 / 已正常投过不补），按 message_id 去重；补投那封不再问 Jev。会话记录是替身。
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterInsertSend, configureInboundRoute, routeProbeFor } from "../src/bridge/inbound-route.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { ccInsertAllowed, configureSteerCc, dropInserts, isInsertRedelivery, noteChannelInsert, redeliverInserts, settleInsertReply } from "../src/bridge/steer-cc.js";
import { CC_INSERT_MIN_VERSION, ccInsertState, ccVersionOf, needsRedeliver, REDELIVER_HEAD, versionAtLeast } from "../src/lib/steer-cc.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/inbound-route/cc-midturn-2.1.302.json"), "utf8")) as { cases: { scenario: string; token: string; records: object[] }[] };
/** 夹具的一段实测记录 → 会话记录尾部文本（一行一条）；message_id 就是 token */
const tailOf = (s: string, extra = ""): string => fixture.cases.find((c) => c.scenario === s)!.records.map((r) => JSON.stringify({ ...r, version: "2.1.302" })).join("\n") + extra;
const tokenOf = (s: string) => fixture.cases.find((c) => c.scenario === s)!.token;

describe("版本闸（lib）", () => {
  test("x.y.z 比较；认不出 = 不够", () => {
    expect(versionAtLeast("2.1.302", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.310", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.2.0", CC_INSERT_MIN_VERSION)).toBe(true);
    expect(versionAtLeast("2.1.301", CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("1.9.999", CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast(null, CC_INSERT_MIN_VERSION)).toBe(false);
    expect(versionAtLeast("dev", CC_INSERT_MIN_VERSION)).toBe(false);
  });
  test("运行中的版本取尾部最后一条", () => {
    expect(ccVersionOf('{"version":"2.1.247"}\n{"version":"2.1.302"}\n')).toBe("2.1.302");
    expect(ccVersionOf("{}")).toBeNull();
  });
});

describe("CC 那边的状态（lib ccInsertState，夹具是实测记录）", () => {
  test("工具间隙插进来的（附件）：补", () => {
    expect(ccInsertState(tailOf("tool"), tokenOf("tool"))).toBe("attached");
    expect(needsRedeliver("attached")).toBe(true);
  });
  test("推理窗口到的：Stop 时还排在 CC 队列里 → 不补；之后作为正常一轮投过 → 不补", () => {
    const recs = fixture.cases.find((c) => c.scenario === "reason")!.records;
    const enqOnly = recs.slice(0, 2).map((r) => JSON.stringify(r)).join("\n"); // prompt + enqueue（Stop 那一刻）
    expect(ccInsertState(enqOnly, tokenOf("reason"))).toBe("queued");
    expect(ccInsertState(tailOf("reason"), tokenOf("reason"))).toBe("delivered");
    expect(needsRedeliver("queued") || needsRedeliver("delivered")).toBe(false);
  });
  test("记录里没有它：没落盘（被丢了）→ 补；半行不影响", () => {
    expect(ccInsertState(`ion":"x" message_id=\\"Q1\\"\n${tailOf("tool")}`, "Q1")).toBe("absent");
    expect(needsRedeliver("absent")).toBe(true);
  });
});

// ── bridge：记账 / 销账 / 补投 ─────────────────────────────────────────────
const to = { kind: "local", channelId: "ch-pm", agentName: "agent-pm", ws: { send() {} } } as unknown as LocalEndpoint;
const EXEC = { kind: "local", channelId: "ch-exec", agentName: "agent-exec" };
let tail: string | null = "", sent: Envelope[] = [], clock = 1_000_000;
const send = async (e: Envelope) => void sent.push(e);
const env = (id: string, from: Record<string, unknown> = EXEC): Envelope =>
  ({
    from, to, intent: "request", content: `答复 ${id}`,
    meta: { messageId: id, threadId: `t-${id}`, triggerKind: "agent_tool", ts: "x", inboundRoute: { action: "insert", p: 0.9, via: "channel" } },
  }) as unknown as Envelope;
afterAll(() => {
  configureSteerCc({ tail: async () => null, now: () => Date.now() });
  configureInboundRoute({ readMode: () => "off", now: () => Date.now() });
});
beforeEach(() => {
  tail = ""; sent = []; clock += 3_600_000;
  configureSteerCc({ tail: async () => tail, now: () => clock });
  dropInserts("ch-pm");
});

describe("版本闸（bridge 取数）", () => {
  test("会话记录报 2.1.302 才直投；读不到 / 更低 / 读失败 = 插不进", async () => {
    tail = '{"version":"2.1.302"}';
    expect(await ccInsertAllowed("ch-pm")).toBe(true);
    tail = '{"version":"2.1.300"}';
    expect(await ccInsertAllowed("ch-pm")).toBe(false);
    tail = null;
    expect(await ccInsertAllowed("ch-pm")).toBe(false);
    configureSteerCc({ tail: async () => { throw new Error("EACCES"); } });
    expect(await ccInsertAllowed("ch-pm")).toBe(false);
  });
});

describe("至少送达一次", () => {
  test("插进来但没回复：Stop 时补投原文一次（新抬头、去掉插队结论、同一个 message_id）；再 Stop 不重复", async () => {
    const e = env("M1");
    noteChannelInsert(e, "ch-pm");
    tail = `{"type":"attachment","attachment":{"type":"queued_command","prompt":"<channel message_id=\\"M1\\">x</channel>"}}`;
    expect(await redeliverInserts("ch-pm", send, to)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.content).toBe(`${REDELIVER_HEAD}\n\n答复 M1`);
    expect(sent[0]!.meta.messageId).toBe("M1");
    expect(sent[0]!.meta.inboundRoute).toBeUndefined();
    expect(isInsertRedelivery(sent[0]!)).toBe(true);
    noteChannelInsert(e, "ch-pm"); // 同一条又记了一次（不该有）：按 message_id 去重
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
  });
  test("没落盘（被丢了）也补；会话记录读不到按没落盘补", async () => {
    noteChannelInsert(env("M2"), "ch-pm");
    tail = '{"type":"user","message":{"content":"别的"}}';
    expect(await redeliverInserts("ch-pm", send, to)).toBe(1);
    noteChannelInsert(env("M3"), "ch-pm");
    tail = null;
    expect(await redeliverInserts("ch-pm", send, to)).toBe(1);
  });
  test("CC 自己还排着（推理窗口到的）：不补", async () => {
    noteChannelInsert(env("M4"), "ch-pm");
    tail = `{"type":"queue-operation","operation":"enqueue","content":"<channel message_id=\\"M4\\">x</channel>"}`;
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
  });
  test("回了发送方（reply 到它的频道 / send_to_agent 给它）：销账不补；回别人不算", async () => {
    noteChannelInsert(env("M5"), "ch-pm");
    noteChannelInsert(env("M6"), "ch-pm");
    noteChannelInsert(env("M7", { kind: "local", channelId: "ch-other", agentName: "agent-other" }), "ch-pm");
    settleInsertReply("ch-pm", { chatId: "c-owner" }); // 回 owner：不算
    settleInsertReply("ch-pm", { chatId: "ch-exec" }); // reply 到发送方频道：M5、M6 都是它发的
    settleInsertReply("ch-pm", { target: "other" }); // send_to_agent 给 agent-other（不带前缀也认）
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
  });
  test("owner 叫停 / kill（dropInserts）：作为目标或发送方的账都销；过了 30 分钟不补", async () => {
    noteChannelInsert(env("M8"), "ch-pm");
    dropInserts("ch-exec");
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
    noteChannelInsert(env("M9"), "ch-pm");
    clock += 31 * 60_000;
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
  });
  test("目标连接没了：不补（也不留账）", async () => {
    noteChannelInsert(env("M10"), "ch-pm");
    expect(await redeliverInserts("ch-pm", send, undefined)).toBe(0);
    expect(await redeliverInserts("ch-pm", send, to)).toBe(0);
  });
});

describe("接线", () => {
  test("afterInsertSend：CC 的 channel 插队送到了就记账，steer 的不记", async () => {
    configureInboundRoute({ readMode: () => "on", now: () => clock });
    const busy = { main: "busy" as const, bg: false };
    const q = { holdEnv: () => 0 };
    expect(afterInsertSend(env("N1"), busy, 50, q)).toBe(false);
    const steer = env("N2");
    steer.meta.inboundRoute = { action: "insert", p: 0.9, via: "steer" };
    afterInsertSend(steer, busy, 50, q);
    tail = null;
    expect(await redeliverInserts("ch-pm", send, to)).toBe(1);
    expect(sent.map((e) => e.meta.messageId)).toEqual(["N1"]);
  });
  test("补投那封再到 deliverToLocal：不再问 Jev（目标又忙也不再插一次）", async () => {
    noteChannelInsert(env("N3"), "ch-pm");
    tail = null;
    await redeliverInserts("ch-pm", send, to);
    configureInboundRoute({ readMode: () => "on", probe: async () => ({ main: "busy", bg: false }), now: () => clock + 5_000 });
    expect(await routeProbeFor(sent[0]!, to, "agent-pm")).toBeNull();
  });
});
