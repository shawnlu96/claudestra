/** BGW-1 纯逻辑：认 CC 的「上一轮后台任务没跑完」通知、执行者口径、去重 + 冷却 */
import { describe, expect, test } from "bun:test";
import { bgKilledNoticeText, isExecutorAgent, KilledNoticeGate, parseKilledNotice } from "../src/lib/bg-killed.ts";

const NOTE = (ids: string[], extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "user",
  origin: { kind: "task-notification" },
  timestamp: "2026-10-08T02:40:03.694Z",
  message: { role: "user", content: `<task-notification>\n${[...ids, "__orphan_summary__:shell"].map((i) => `<task-id>${i}</task-id>`).join("\n")}\n<status>stopped</status>\n<summary>${ids.length} background shell command tasks didn't finish before the previous session ended. Task ids: ${ids.join(", ")}.</summary>\n</task-notification>` },
  ...extra,
});

describe("parseKilledNotice", () => {
  test("CC 的 task-notification user 记录：取真实 taskId，去掉 __orphan_summary 标记，带时间戳", () => {
    expect(parseKilledNotice(NOTE(["bamzw177e", "bqkfq1e4n"]))).toEqual({ ids: ["bamzw177e", "bqkfq1e4n"], ts: Date.parse("2026-10-08T02:40:03.694Z") });
  });

  test("同内容的 queue-operation 不算（一次重启只认一遍）", () => {
    const q = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: JSON.parse(NOTE(["a1"])).message.content });
    expect(parseKilledNotice(q)).toBeNull();
  });

  test("普通消息里引用这句话不算（origin 不是 task-notification）", () => {
    expect(parseKilledNotice(NOTE(["a1"], { origin: { kind: "channel" } }))).toBeNull();
  });

  test("内容是 text 块数组也认；坏行 / 半行 / 没有 taskId 返回 null", () => {
    const rec = JSON.parse(NOTE(["x9"]));
    rec.message.content = [{ type: "text", text: rec.message.content }];
    expect(parseKilledNotice(JSON.stringify(rec))?.ids).toEqual(["x9"]);
    expect(parseKilledNotice(NOTE(["a1"]).slice(40))).toBeNull();
    expect(parseKilledNotice(NOTE([]))).toBeNull();
  });
});

test("isExecutorAgent：只认 agent-task-*；master / 人类会话 / 审查员 / PM 都不算", () => {
  expect(isExecutorAgent("agent-task-rvh-1")).toBe(true);
  for (const n of ["agent-master", "master", "agent-claudestra-debug", "agent-rv-bgw-1", "agent-cv-x", "agent-future_data"]) expect(isExecutorAgent(n)).toBe(false);
});

test("提醒文案写明 taskId 与「信号不会再来，重跑或交付」", () => {
  const t = bgKilledNoticeText(["a1", "b2"]);
  for (const s of ["a1", "b2", "信号不会再来", "重跑", "交付"]) expect(t).toContain(s);
});

describe("KilledNoticeGate", () => {
  test("同一 agent 同一批 taskId 只提醒一次", () => {
    const g = new KilledNoticeGate(1000);
    g.offer("agent-task-a", ["t1", "t2"]);
    expect(g.due(0)).toEqual([{ agent: "agent-task-a", ids: ["t1", "t2"] }]);
    g.done("agent-task-a", ["t1", "t2"], 0);
    g.offer("agent-task-a", ["t1", "t2"]);
    expect(g.due(10_000)).toEqual([]);
  });

  test("冷却内新认出的 taskId 攒着，冷却过了合成一条；没 done（投递失败）下轮再给", () => {
    const g = new KilledNoticeGate(1000);
    g.offer("agent-task-a", ["t1"]);
    g.done("agent-task-a", ["t1"], 0);
    g.offer("agent-task-a", ["t2"]);
    g.offer("agent-task-a", ["t3", "t1"]);
    expect(g.due(500)).toEqual([]);
    expect(g.due(1000)).toEqual([{ agent: "agent-task-a", ids: ["t2", "t3"] }]);
    expect(g.due(1001)).toEqual([{ agent: "agent-task-a", ids: ["t2", "t3"] }]); // 没 done：还在
  });

  test("不同 agent 各算各的冷却", () => {
    const g = new KilledNoticeGate(1000);
    g.offer("agent-task-a", ["t1"]);
    g.done("agent-task-a", ["t1"], 0);
    g.offer("agent-task-b", ["t1"]);
    expect(g.due(1)).toEqual([{ agent: "agent-task-b", ids: ["t1"] }]);
  });
});
