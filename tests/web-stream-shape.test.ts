import { describe, expect, test } from "bun:test";
import { agentNameVariants, bgReplayEvents, frameData, pendingEvents, translate, type BridgeEvent } from "@/lib/chat/stream-shape";

const ev = (type: string, data: Record<string, unknown>, seq = 1): BridgeEvent => ({ seq, ts: "t", agent: "agent-w", chatId: "api:owner:self", type, data });
const self = new Set(["api:owner:self"]);

describe("translate（bridge 事件 → 协议 v1）", () => {
  test("回合状态：thinking → running；compacting；done 带 interrupted / bgPending", () => {
    expect(translate(ev("agent_status", { status: "thinking" }), "zh", self)).toEqual({ t: "status", status: "running" });
    expect(translate(ev("agent_status", { status: "compacting" }), "zh", self)).toEqual({ t: "status", status: "compacting" });
    expect(translate(ev("agent_status", { status: "done", trigger: "interrupt", bgPending: true }), "zh", self)).toEqual({ t: "done", interrupted: true, bgPending: true });
  });
  test("工具：tool_start 带 id / detail / 记录坐标；tool_done → tool-state；没 toolId 不发", () => {
    const tool = translate(ev("tool_start", { name: "Read", summary: "a.ts", toolId: "tu1", detail: "d", seq: 40, sid: "s" }), "zh", self);
    expect(tool).toEqual({ t: "tool", name: "Read", summary: "a.ts", state: "running", id: "tu1", detail: "d", seq: 40, sid: "s" });
    expect(translate(ev("tool_done", { toolId: "tu1", error: true }), "zh", self)).toEqual({ t: "tool-state", id: "tu1", state: "error" });
    expect(translate(ev("tool_done", {}), "zh", self)).toBeNull();
  });
  test("chat_message：用户来源的 in → user-in（本人不标 from、剥附件块）；agent 注入不算；out → reply 带组件与附件", () => {
    const mine = translate(ev("chat_message", { direction: "in", srcKind: "api", text: "hi [attachment: /x/inbox/1_a.png]", from: "iPhone", fromId: "api:owner:self" }), "zh", self);
    expect(mine).toMatchObject({ t: "user-in", text: "hi" });
    expect((mine as { from?: string }).from).toBeUndefined();
    expect((mine as { attachments?: unknown[] }).attachments).toHaveLength(1);
    const peer = translate(ev("chat_message", { direction: "in", srcKind: "api", text: "yo", from: "peer-x", fromId: "api:peer" }), "zh", self);
    expect(peer).toMatchObject({ t: "user-in", from: "peer-x" });
    expect(translate(ev("chat_message", { direction: "in", srcKind: "agent", text: "x" }), "zh", self)).toBeNull();
    const out = translate(ev("chat_message", { direction: "out", text: "ok", components: [{ type: "buttons", buttons: [] }], files: [{ name: "r.png", attachment: "17_r.png" }] }), "zh", self);
    expect(out).toMatchObject({ t: "reply", text: "ok", attachments: [{ name: "r.png", kind: "image", url: "/api/v1/attachments/17_r.png" }] });
  });
  test("AUQ / 异常文案按语言 / 后台任务 / compact / 遥测 / 不消费的返回 null", () => {
    expect(translate(ev("question", { questions: [{ question: "q", header: "h", options: [{ label: "a" }] }] }, 9), "zh", self)).toMatchObject({ t: "ask", id: "auq-9" });
    expect(translate(ev("session_anomaly", { kind: "link_down", minutes: 3 }), "en", self)).toMatchObject({ t: "text", text: expect.stringContaining("Link down for 3 min") });
    expect(translate(ev("session_anomaly", { kind: "unknown" }), "zh", self)).toBeNull();
    expect(translate(ev("bg_task_update", { id: "b", items: [] }), "zh", self)).toBeNull();
    expect(translate(ev("bg_task_completed", { id: "b", durationMs: 5, status: "done" }), "zh", self)).toEqual({ t: "bg-done", id: "b", durationMs: 5, status: "done" });
    expect(translate(ev("compact_done", { preTokens: 10, postTokens: 2 }), "zh", self)).toEqual({ t: "compact", pre: 10, post: 2 });
    expect(translate(ev("thinking_telemetry", { elapsedRaw: "4s", tokens: 12 }), "zh", self)).toEqual({ t: "telemetry", elapsed: "4s", tokens: 12 });
    expect(translate(ev("something_else", {}), "zh", self)).toBeNull();
  });
});

describe("连流补发 / 帧解析", () => {
  test("pendingEvents：compacting 优先于 thinking；未答的 AUQ 带 pending id", () => {
    expect(pendingEvents({ thinking: true, compacting: true, question: { questions: [], ts: 5 } }).map((e) => e.t)).toEqual(["status", "ask"]);
    expect(pendingEvents({ thinking: true })).toEqual([{ t: "status", status: "running" }]);
    expect(pendingEvents({})).toEqual([]);
  });
  test("bgReplayEvents：每个任务 bg-start（+ 尾部行），末尾 bg-sync 全集（空也发）", () => {
    const evs = bgReplayEvents([{ id: "a", kind: "shell", title: "t", lines: ["l1"] }, { id: "b", kind: "subagent", title: "u" }]);
    expect(evs.map((e) => e.t)).toEqual(["bg-start", "bg-update", "bg-start", "bg-sync"]);
    expect(bgReplayEvents([])).toEqual([{ t: "bg-sync", ids: [] }]);
  });
  test("frameData 只取 data 行；心跳 / 注释帧 null；agentNameVariants 认 registry 名与短名", () => {
    expect(frameData("data: {\"a\":1}")).toBe('{"a":1}');
    expect(frameData(": connected")).toBeNull();
    expect(frameData("event: x\ndata: 1\ndata: 2")).toBe("1\n2");
    expect([...agentNameVariants("w")]).toEqual(["w", "agent-w"]);
  });
});
