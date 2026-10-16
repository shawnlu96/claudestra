/** JRT-1：目标 agent「当前在做什么」短摘要——拼法（lib/turn-brief.ts）和 bridge 侧取数（bridge/turn-brief.ts）。 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setAsksForTest } from "../src/bridge/asks.js";
import { emitEvent, forgetAgent } from "../src/bridge/event-bus.js";
import type { Envelope } from "../src/bridge/router.js";
import { turnBrief } from "../src/bridge/turn-brief.js";
import { turnCuts } from "../src/bridge/turn-cuts.js";
import { closeAsk, openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { BRIEF_MAX, clip, nextOpener, recentTools, turnBriefText } from "../src/lib/turn-brief.js";
import type { CutEvent, TurnTrigger } from "../src/lib/turn-cuts.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const trig = (fromKind: string, fromName: string, excerpt: string): TurnTrigger => ({ messageId: `m-${excerpt}`, fromKind, fromName, excerpt, replyTo: "", at: 1 });
const ev = (type: string, data: Record<string, unknown>): CutEvent => ({ type, ts: new Date().toISOString(), data });
const start = (toolId: string, name: string, summary = "") => ev("tool_start", { toolId, name, summary });
const done = (toolId: string) => ev("tool_done", { toolId });

describe("recentTools", () => {
  test("只看最后一次 done 之后；取最后 3 个；没 done 的算进行中；mcp 前缀去掉", () => {
    const events = [
      start("old", "Read", "a.ts"), done("old"), ev("agent_status", { status: "done" }),
      start("t1", "Bash", "git status"), done("t1"),
      start("t2", "Read", "src/x.ts"), done("t2"),
      start("t3", "mcp__claudestra__reply"), done("t3"),
      start("t4", "Bash", "bun test"),
    ];
    expect(recentTools(events)).toEqual([
      { title: "Read src/x.ts", running: false },
      { title: "reply", running: false },
      { title: "Bash bun test", running: true },
    ]);
  });

  test("codex-tool-state：Codex 只有跑完才有 tool_start、没有 tool_done，completedOnly 全按已完成", () => {
    const events = [start("c1", "Bash", "ls"), start("c2", "Bash", "bun test")];
    expect(recentTools(events, 3, true).map((t) => t.running)).toEqual([false, false]);
    expect(recentTools(events).map((t) => t.running)).toEqual([true, true]);
  });

  test("没有工具 / 只有上一回合的 → 空", () => {
    expect(recentTools([])).toEqual([]);
    expect(recentTools([start("a", "Read"), ev("agent_status", { status: "done" })])).toEqual([]);
  });
});

describe("turnBriefText", () => {
  test("三段都有：起因、工具、在等的问题（至多 2 个，空白的跳过）", () => {
    const s = turnBriefText({
      opener: trig("user", "he", "帮我\n看下 CI"),
      tools: [{ title: "Bash gh pr checks", running: true }],
      questions: ["要 push 吗？", "  ", "第二个", "第三个不带"],
    });
    expect(s).toBe("本回合起因：he（user）「帮我 看下 CI」。最近工具：Bash gh pr checks（进行中）。在等回答：「要 push 吗？」、「第二个」");
  });

  test("没数据的段省掉；全空返回空串", () => {
    expect(turnBriefText({ opener: trig("bridge", "bridge", "收尾提醒"), tools: [], questions: [] })).toBe("本回合起因：bridge（bridge）「收尾提醒」");
    expect(turnBriefText({ tools: [], questions: ["合并吗"] })).toBe("在等回答：「合并吗」");
    expect(turnBriefText({ tools: [], questions: [] })).toBe("");
  });

  test("再长也不超过 BRIEF_MAX 字（按码点算）", () => {
    const long = "字".repeat(500);
    const s = turnBriefText({ opener: trig("user", long, long), tools: [1, 2, 3].map(() => ({ title: long, running: true })), questions: [long, long] });
    expect(Array.from(s).length).toBeLessThanOrEqual(BRIEF_MAX);
  });

  test("pending-question-clipped：起因和工具占满预算时，在等的问题照样完整带上，截的是前面", () => {
    const s = turnBriefText({
      opener: trig("local", "agent-claudestra-worker-1", "起".repeat(120)),
      tools: [1, 2, 3].map(() => ({ title: "工".repeat(40), running: true })),
      questions: ["要不要合并 PR #1654？"],
    });
    expect(Array.from(s).length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(s.endsWith("。在等回答：「要不要合并 PR #1654？」")).toBe(true);
    expect(s.startsWith("本回合起因：agent-claudestra-worker-1")).toBe(true);
  });

  test("clip 不切半个 emoji", () => {
    expect(clip("😀😀😀", 2)).toBe("😀…");
    expect(clip("a  b", 10)).toBe("a b");
  });
});

describe("nextOpener", () => {
  test("第一条人 / agent 的为准；bridge 通知只在没有别的时占位，来了真消息就让出", () => {
    const b = trig("bridge", "bridge", "提醒"), u = trig("user", "he", "u1"), a = trig("local", "pm", "a1");
    expect(nextOpener(undefined, b)).toBe(b);
    expect(nextOpener(b, u)).toBe(u);
    expect(nextOpener(u, a)).toBe(u);
    expect(nextOpener(u, b)).toBe(u);
  });
});

describe("turnBrief（bridge 取数）", () => {
  const AGENT = "agent-jrt-brief-test", CH = "jrt-brief-ch", OTHER = "jrt-brief-other";
  let path = "";
  beforeEach(() => {
    path = tempLedgerPath("turn-brief-");
    openLedger(path);
    setAsksForTest({ path });
  });
  afterEach(() => {
    setAsksForTest(undefined);
    closeLedger(path);
    turnCuts.forget(CH);
    forgetAgent(AGENT);
  });

  const deliver = (id: string, content: string, from: Record<string, unknown> = { kind: "user", channelId: "u1", userId: "1", username: "he" }) =>
    turnCuts.noteDelivered({
      from, to: { kind: "local", channelId: CH, agentName: AGENT }, intent: "request", content, meta: { messageId: id, ts: new Date().toISOString() },
    } as unknown as Envelope, CH);

  test("拼出本回合起因 + 工具 + 本频道开着的问题（accept / 已结案 / 别的频道不算）", () => {
    deliver("m1", "把 JRT-1 做了");
    emitEvent({ agent: AGENT, chatId: CH, type: "tool_start", data: { toolId: "x1", name: "Bash", summary: "bun test" } });
    const db = openLedger(path);
    const base = { project: "p", fromAgent: AGENT, source: "reply" as const, body: "", options: [] };
    openAsk(db, { ...base, fromChannelId: CH, kind: "decide", title: "合并吗" });
    openAsk(db, { ...base, fromChannelId: CH, kind: "accept", title: "看下截图" });
    openAsk(db, { ...base, fromChannelId: OTHER, kind: "decide", title: "别的频道" });
    closeAsk(db, openAsk(db, { ...base, fromChannelId: CH, kind: "decide", title: "早答了" }).id, "cancelled", "");
    expect(turnBrief(AGENT, CH, "claude")).toBe("本回合起因：he（user）「把 JRT-1 做了」。最近工具：Bash bun test（进行中）。在等回答：「合并吗」");
    expect(turnBrief(AGENT, CH, "codex")).toContain("最近工具：Bash bun test。");
  });

  test("turn-opener-evicted：一回合送到 9 条（超过最近 8 条的上限），起因仍是第一条", () => {
    for (let i = 0; i <= 8; i++) deliver(`m${i}`, `第 ${i} 条`);
    expect(turnCuts.turnOpener(CH)?.messageId).toBe("m0");
    expect(turnBrief(AGENT, CH, "claude")).toBe("本回合起因：he（user）「第 0 条」");
  });

  test("起因随回合清：Stop 后换下一条；bridge 通知先到也让给后到的人类消息；投递失败的那条撤掉", () => {
    deliver("b1", "收尾提醒", { kind: "bridge", label: "turn-cuts-x" });
    deliver("m1", "人说的");
    expect(turnCuts.turnOpener(CH)?.messageId).toBe("m1");
    turnCuts.dropUndelivered(CH, "m1");
    expect(turnCuts.turnOpener(CH)?.messageId).toBe("b1");
    turnCuts.onStop(CH, "Stop", AGENT);
    expect(turnCuts.turnOpener(CH)).toBeUndefined();
    deliver("m2", "下一回合");
    expect(turnCuts.turnOpener(CH)?.messageId).toBe("m2");
  });

  test("没有任何数据（空闲 / 刚重启）→ 空串", () => {
    expect(turnBrief(AGENT, CH, undefined)).toBe("");
  });
});
