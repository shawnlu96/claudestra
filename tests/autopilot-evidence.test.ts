/** bridge/autopilot-evidence.ts：只给进行中的 run 记账、只认本轮发出的按钮、人类消息时刻（让位）、重启后证据不全 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  lastHumanMessageAt, onAutopilotEvent, resetAutopilotEvidence, takeEvidence, trackRun, untrackRun,
} from "../src/bridge/autopilot-evidence.js";
import { classifyRun } from "../src/lib/autopilot-run.js";
import type { BridgeEvent, BridgeEventType } from "../src/bridge/event-bus.js";

let seq = 0;
const evt = (agent: string, type: BridgeEventType, data: Record<string, unknown>): BridgeEvent => ({ seq: ++seq, ts: "", agent, chatId: "c1", type, data });

beforeEach(() => resetAutopilotEvidence());

describe("记账", () => {
  test("没在跑 run 的 agent 不记；run 开始后的工具、按钮、提问都进证据", () => {
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Edit" }));
    trackRun("w", "r1");
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Read" }));
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "Edit" }));
    onAutopilotEvent(evt("agent-w", "tool_start", { name: "mcp__claudestra__reply" }));
    const ev = takeEvidence("agent-w", "r1");
    expect(ev).toMatchObject({ tools: 2, mutating: 1, buttonsSent: 0, questionOpen: false });
    expect(classifyRun(ev).outcome).toBe("action_taken");
  });
  test("只认本轮 agent 自己发的按钮：run 之前的、bridge notify 的都不算", () => {
    const btn = [{ type: "buttons", buttons: [{ id: "a", label: "A" }] }];
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", components: btn })); // owner 早先那组没答的
    trackRun("w", "r1");
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "⚙️ cron", components: btn }));
    expect(takeEvidence("w", "r1").buttonsSent).toBe(0);
    trackRun("w", "r2");
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", components: btn }));
    onAutopilotEvent(evt("w", "chat_message", { direction: "out", from: "agent-w", text: "没按钮" }));
    const ev = takeEvidence("w", "r2");
    expect(ev.buttonsSent).toBe(1);
    expect(classifyRun(ev).outcome).toBe("blocked_approval");
  });
  test("提问：出现记 open，被答掉清回；撞额度和 API 报错记原文", () => {
    trackRun("w", "r1");
    onAutopilotEvent(evt("w", "question", { questions: [] }));
    onAutopilotEvent(evt("w", "question_cleared", { reason: "submit" }));
    onAutopilotEvent(evt("w", "assistant_text", { text: "You've hit your limit · resets 2am (Asia/Shanghai)", rateLimited: true }));
    const ev = takeEvidence("w", "r1");
    expect(ev.questionOpen).toBe(false);
    expect(classifyRun(ev).outcome).toBe("rate_limited");
    trackRun("w", "r2");
    onAutopilotEvent(evt("w", "api_error_turn", { error: "overloaded_error" }));
    expect(classifyRun(takeEvidence("w", "r2"))).toMatchObject({ outcome: "failed" });
  });
});

describe("人类消息（让位依据）", () => {
  test("Discord 用户 / 网页入站记时刻，agent 转发不算；run 中途来的标 humanInterleaved", () => {
    onAutopilotEvent(evt("agent-w", "chat_message", { direction: "in", srcKind: "local" }), 1000);
    expect(lastHumanMessageAt("w")).toBeUndefined();
    onAutopilotEvent(evt("agent-w", "chat_message", { direction: "in", srcKind: "api" }), 2000);
    expect(lastHumanMessageAt("w")).toBe(2000);
    trackRun("w", "r1");
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "user" }), 3000);
    expect(lastHumanMessageAt("agent-w")).toBe(3000);
    expect(takeEvidence("w", "r1").humanInterleaved).toBe(true);
  });
});

describe("取证据", () => {
  test("不是这个 run 在记（bridge 重启过 / 已取走 / 放弃了）→ 空证据 + evidenceLost", () => {
    expect(takeEvidence("w", "r1")).toMatchObject({ tools: 0, evidenceLost: true });
    trackRun("w", "r1");
    untrackRun("w", "r0");
    untrackRun("w", "r1");
    expect(takeEvidence("w", "r1").evidenceLost).toBe(true);
  });
});
