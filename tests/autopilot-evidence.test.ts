/** bridge/autopilot-evidence.ts：只给进行中的 run 记账、只认本轮发出的按钮（含行内按钮）、撞额度两种形状、人类信号（让位）、重启后证据不全 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  isTracking, lastHumanMessageAt, onAutopilotEvent, peekTracked, resetAutopilotEvidence, runStarted, takeEvidence, takeOrphan, takeTurnActivity,
  trackedTurn, trackRun, untrackRun,
} from "../src/bridge/autopilot-evidence.js";
import { classifyRun } from "../src/lib/autopilot-run.js";
import type { ActiveRun } from "../src/lib/autopilot-wake.js";
import type { BridgeEvent, BridgeEventType } from "../src/bridge/event-bus.js";

let seq = 0;
const evt = (agent: string, type: BridgeEventType, data: Record<string, unknown>, chatId = "c1"): BridgeEvent => ({ seq: ++seq, ts: "", agent, chatId, type, data });
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

describe("第 3 轮复验补的", () => {
  test("watcher 缺位时事件挂在「?」名下：按 trackRun 记下的频道认回来", () => {
    trackRun("w", run("r1"), "m1", "chw");
    onAutopilotEvent(evt("?", "agent_status", { status: "thinking" }, "chw"));
    onAutopilotEvent(evt("chw", "tool_start", { name: "Edit" }, "chw"));
    expect(trackedTurn("agent-w")).toEqual({ runId: "r1", started: true });
    expect(takeEvidence("w", "r1").mutating).toBe(1);
  });
  test("run 的回合结束后：晚到的最后几行照记；下一个回合一开始（thinking / 入站消息）就冻结", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "tool_start", { name: "Read" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "done" }));
    onAutopilotEvent(evt("w", "api_error_turn", { error: "overloaded_error" })); // 这一轮晚到的
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "local", text: "peer 的消息" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "tool_start", { name: "Edit" })); // 下一个回合的
    const ev = takeEvidence("w", "r1");
    expect(ev.failure).toContain("overloaded");
    expect(ev.mutating).toBe(0);
  });
  test("迟到的 Stop（没见过 thinking）不算这个 run 的结束，也不冻结", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "agent_status", { status: "done" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "tool_start", { name: "Edit" }));
    expect(takeEvidence("w", "r1").mutating).toBe(1);
  });
  test("peer 经 /api/v1 发来的请求不是人类信号", () => {
    resetAutopilotEvidence(["api:tok_peer"]);
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "api", fromId: "api:tok_peer" }), 1000);
    expect(lastHumanMessageAt("w")).toBeUndefined();
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "api", fromId: "api:tok_web" }), 2000);
    expect(lastHumanMessageAt("w")).toBe(2000);
  });
  test("本轮早先无关的、带 limit 字样的话不拿来当额度原文", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "assistant_text", { text: "rate limit 相关的代码我改好了" }));
    onAutopilotEvent(evt("w", "api_error_turn", { error: "rate_limit" }));
    expect(takeEvidence("w", "r1").rateLimitText).toBe("rate_limit（没有原文）");
  });
  test("peekTracked 不取走", () => {
    track("w", "r1");
    expect(peekTracked("w", "r1")?.missionId).toBe("m1");
    expect(peekTracked("w", "r2")).toBeNull();
    expect(isTracking("w", "r1")).toBe(true);
  });
});

describe("P2-9：回合活动只认 thinking", () => {
  test("每个 done 只消费一次；按 agent 名或频道都能取到；工具 / 文字 / 人类入站都不算新回合", () => {
    onAutopilotEvent(evt("agent-w", "agent_status", { status: "thinking" }, "chw"));
    expect(takeTurnActivity("w", "chw")).toBe(true);
    expect(takeTurnActivity("w", "chw")).toBe(false);
    onAutopilotEvent(evt("chw", "agent_status", { status: "thinking" }, "chw")); // agent 字段是频道 id
    expect(takeTurnActivity("w", "chw")).toBe(true);
    onAutopilotEvent(evt("w", "tool_start", { name: "mcp__claudestra__reply" }, "chw")); // Stop 之后才读到的本回合最后几行
    onAutopilotEvent(evt("w", "assistant_text", { text: "查完了" }, "chw"));
    onAutopilotEvent(evt("w", "chat_message", { direction: "in", srcKind: "user" }, "chw"));
    expect(takeTurnActivity("w", "chw")).toBe(false);
  });
  test("12 小时前点亮、一直没被取走的（改名 / 换频道留下的旧键）不算", () => {
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }, "chw"), 1000);
    expect(takeTurnActivity("w", "chw", 1000 + 12 * 3_600_000)).toBe(false);
  });
});

describe("第 1 轮常规审查补的（T14f）", () => {
  test("冻结后仍收本回合迟到的撞额度：run 结束 → 下一回合 thinking 先到 → 迟到的 rate_limit 报错和原文", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "done" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" })); // 押后消息开了下一个回合
    onAutopilotEvent(evt("w", "api_error_turn", { error: "rate_limit" }));
    onAutopilotEvent(evt("w", "assistant_text", { text: "You've hit your limit · resets 3am (Asia/Tokyo)" }));
    onAutopilotEvent(evt("w", "tool_start", { name: "Edit" })); // 下一个回合的工具照样不算
    const ev = takeEvidence("w", "r1");
    expect(classifyRun(ev).outcome).toBe("rate_limited");
    expect(ev.rateLimitText).toContain("resets 3am");
    expect(ev.mutating).toBe(0);
  });
  test("冻结后的其它 API 报错：记录时间早于 run 结束的算本回合，晚于的是下一个回合", () => {
    track("w", "r1");
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }), 1000);
    onAutopilotEvent(evt("w", "agent_status", { status: "done" }), Date.parse("2026-09-28T12:00:00Z"));
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "api_error_turn", { error: "overloaded", ts: "2026-09-28T12:00:05Z" }));
    expect(takeEvidence("w", "r1").failure).toBeUndefined();
    track("w", "r2");
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "agent_status", { status: "done" }), Date.parse("2026-09-28T12:00:00Z"));
    onAutopilotEvent(evt("w", "agent_status", { status: "thinking" }));
    onAutopilotEvent(evt("w", "api_error_turn", { error: "overloaded", ts: "2026-09-28T11:59:59Z" }));
    expect(takeEvidence("w", "r2").failure).toContain("overloaded");
  });
  test("peer 经 API 打断（事件带 peer）不算人类信号；人点打断算", () => {
    onAutopilotEvent(evt("w", "agent_status", { status: "done", trigger: "interrupt", peer: "sekai" }), 1000);
    expect(lastHumanMessageAt("w")).toBeUndefined();
    onAutopilotEvent(evt("w", "agent_status", { status: "done", trigger: "interrupt" }), 2000);
    expect(lastHumanMessageAt("w")).toBe(2000);
  });
  test("人类消息按频道也记一份：watcher 缺位时挂在「?」名下也查得到", () => {
    onAutopilotEvent(evt("?", "chat_message", { direction: "in", srcKind: "user" }, "chw"), 3000);
    expect(lastHumanMessageAt("w")).toBeUndefined();
    expect(lastHumanMessageAt("w", "chw")).toBe(3000);
  });
});
