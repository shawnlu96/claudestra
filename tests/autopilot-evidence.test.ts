/** bridge/autopilot-evidence.ts：只给进行中的 run 记账、只认本轮发出的按钮（含行内按钮）、撞额度两种形状、人类信号（让位）、重启后证据不全 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  isTracking, lastHumanMessageAt, onAutopilotEvent, resetAutopilotEvidence, runStarted, takeEvidence, takeOrphan, trackRun, untrackRun,
} from "../src/bridge/autopilot-evidence.js";
import { classifyRun } from "../src/lib/autopilot-run.js";
import type { ActiveRun } from "../src/lib/autopilot-wake.js";
import type { BridgeEvent, BridgeEventType } from "../src/bridge/event-bus.js";

let seq = 0;
const evt = (agent: string, type: BridgeEventType, data: Record<string, unknown>): BridgeEvent => ({ seq: ++seq, ts: "", agent, chatId: "c1", type, data });
const run = (runId: string): ActiveRun => ({ runId, seq: 1, source: "turn_end", merged: 0, firstAt: "", claimedAt: "" });
const track = (agent: string, runId: string) => trackRun(agent, run(runId), "m1");
const btn = [{ type: "buttons", buttons: [{ id: "a", label: "A" }] }];

beforeEach(() => resetAutopilotEvidence());

describe("记账", () => {
  test("没在跑 run 的 agent 不记；run 开始后的工具进证据，只读 shell 不算写", () => {
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Edit" }));
    track("w", "r1");
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Read" }));
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Bash", detail: "看 CI\n───\ngh pr checks 1" }));
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "mcp__claudestra__reply" }));
    let ev = takeEvidence("agent-w", "r1");
    expect(ev).toMatchObject({ tools: 2, mutating: 0 });
    expect(classifyRun(ev).outcome).toBe("normal");
    track("w", "r2");
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Edit" }));
    ev = takeEvidence("w", "r2");
    expect(classifyRun(ev).outcome).toBe("action_taken");
  });
  test("投递之后见过 thinking 才算这个 run 的回合开始了", () => {
    track("w", "r1");
    expect(runStarted("w", "r1")).toBe(false);
    onAutopilotEvent(evt("agent-w", "agent_status", { status: "thinking" }));
    expect(runStarted("agent-w", "r1")).toBe(true);
  });
});

describe("在等人拍板", () => {
  test("只认本轮 agent 自己发的按钮：run 之前的、bridge notify 的都不算", () => {
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", components: btn })); // owner 早先那组没答的
    track("w", "r1");
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "⚙️ cron", components: btn }));
    expect(takeEvidence("w", "r1").buttonsSent).toBe(0);
    track("w", "r2");
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", components: btn }));
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", text: "没按钮" }));
    const ev = takeEvidence("w", "r2");
    expect(ev.buttonsSent).toBe(1);
    expect(classifyRun(ev).outcome).toBe("blocked_approval");
  });
  test("reply 正文里的行内按钮 [[{#id}文字]] 也算", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", text: "要继续吗？[[{#go .success}继续]] [[{#stop}停]]" }));
    expect(classifyRun(takeEvidence("w", "r1")).outcome).toBe("blocked_approval");
  });
  test("提问：出现记 open，被答掉清回", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "question", { questions: [] }));
    onAutopilotEvent(evt("w", "question_cleared", { reason: "submit" }));
    expect(takeEvidence("w", "r1").questionOpen).toBe(false);
  });
});

describe("撞额度 / 报错", () => {
  test("旧文案：assistant_text 带 rateLimited", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "assistant_text", { text: "You've hit your limit · resets 2am (Asia/Shanghai)", rateLimited: true }), 1000);
    const ev = takeEvidence("w", "r1");
    expect(classifyRun(ev).outcome).toBe("rate_limited");
    expect(ev.rateLimitAt).toBe(1000);
  });
  test("新文案：api_error_turn error=rate_limit 先到、文字后到 → rate_limited，原文里的重置时间保留", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "api_error_turn", { error: "rate_limit" }), 1000);
    onAutopilotEvent(evt("w", "assistant_text", { text: "You've hit your session limit · resets 4:30pm (Asia/Tokyo)" }), 1001);
    const ev = takeEvidence("w", "r1");
    expect(classifyRun(ev).outcome).toBe("rate_limited");
    expect(ev.rateLimitText).toContain("resets 4:30pm");
  });
  test("新文案：文字先到、api_error_turn 后到 → 同样 rate_limited", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "assistant_text", { text: "You've hit your weekly limit · resets Oct 3, 2am (Asia/Tokyo)" }));
    onAutopilotEvent(evt("w", "api_error_turn", { error: "rate_limit" }));
    expect(takeEvidence("w", "r1").rateLimitText).toContain("weekly limit");
  });
  test("同是 rate_limit 的临时限流（事件带原文）→ failed，不当撞额度（T24a 常规审查）", () => {
    track("w", "r1");
    const text = "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    onAutopilotEvent(evt("w", "api_error_turn", { error: "rate_limit", text }));
    onAutopilotEvent(evt("w", "assistant_text", { text, apiError: true }));
    expect(classifyRun(takeEvidence("w", "r1"))).toMatchObject({ outcome: "failed" });
  });
  test("其它 API 报错 → failed", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "api_error_turn", { error: "overloaded_error" }));
    expect(classifyRun(takeEvidence("w", "r1"))).toMatchObject({ outcome: "failed" });
  });
});

describe("人类信号（让位依据）", () => {
  test("Discord 用户 / 网页入站记时刻，agent 转发不算；run 中途来的标 humanInterleaved", () => {
    onAutopilotEvent(evt("agent-w", "chat_message", { direction: "in", srcKind: "local" }), 1000);
    expect(lastHumanMessageAt("w")).toBeUndefined();
    onAutopilotEvent(evt("agent-w", "chat_message", { direction: "in", srcKind: "api" }), 2000);
    expect(lastHumanMessageAt("w")).toBe(2000);
    track("w", "r1");
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "user" }), 3000);
    expect(lastHumanMessageAt("agent-w")).toBe(3000);
    expect(takeEvidence("w", "r1").humanInterleaved).toBe(true);
  });
  test("点「打断」（done trigger=interrupt）和人说话一样", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "agent_status", { status: "done", trigger: "interrupt" }), 5000);
    expect(lastHumanMessageAt("w")).toBe(5000);
    expect(takeEvidence("w", "r1").humanInterleaved).toBe(true);
  });
});

describe("取证据", () => {
  test("不是这个 run 在记（bridge 重启过 / 已取走 / 放弃了）→ 空证据 + evidenceLost", () => {
    expect(takeEvidence("w", "r1")).toMatchObject({ tools: 0, evidenceLost: true });
    track("w", "r1");
    untrackRun("w", "r0");
    expect(isTracking("w", "r1")).toBe(true);
    untrackRun("w", "r1");
    expect(takeEvidence("w", "r1").evidenceLost).toBe(true);
  });
  test("换了一代：还在记账的旧 run 能取出来补日志；是当前 run 就不取", () => {
    track("w", "r1");
    expect(takeOrphan("w", "r1")).toBeNull();
    expect(takeOrphan("w", "r2")?.run.runId).toBe("r1");
    expect(isTracking("w", "r1")).toBe(false);
  });
});
