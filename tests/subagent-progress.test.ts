import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EMPTY_PROGRESS, nextProgress, readSubagentMeta, subagentEndStatus, type SubagentProgress } from "../src/lib/subagent-progress";

const USAGE = { input_tokens: 2, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 1_000 };
// CC 按内容块逐条落盘：同一条消息的每个块一条记录、共用 message.id，只有末块带 stop_reason
const asst = (ts: string, stop: string | null, content: unknown[], id = `msg_${ts}`) => ({
  type: "assistant",
  timestamp: ts,
  message: { id, stop_reason: stop, usage: USAGE, content },
});
const user = (ts: string, content: unknown) => ({ type: "user", timestamp: ts, message: { role: "user", content } });
const result = (ts: string, id: string, isError = false) => user(ts, [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }]);
const feed = (recs: unknown[]) => recs.reduce<SubagentProgress>(nextProgress, EMPTY_PROGRESS);
const REPORT = "## 调研结论\n\n" + "发现一：xxx。".repeat(40);

const MIN = 60_000;
const LIMIT = 30 * MIN;
const status = (p: SubagentProgress, silentMs: number, meta = {}) => subagentEndStatus(p, meta, silentMs, LIMIT);

describe("nextProgress", () => {
  test("耗时从第一条记录算，上下文取最近一条 assistant（input + cache 读写）", () => {
    const p = feed([
      user("2026-09-24T01:41:00.000Z", "任务说明"),
      asst("2026-09-24T01:42:00.000Z", "tool_use", [{ type: "tool_use", id: "t1", name: "Bash" }, { type: "tool_use", id: "t2", name: "Read" }]),
      result("2026-09-24T02:10:00.000Z", "t1"),
    ]);
    expect(p.firstTs).toBe(Date.parse("2026-09-24T01:41:00.000Z"));
    expect(p.lastTs).toBe(Date.parse("2026-09-24T02:10:00.000Z"));
    expect(p.ctxTokens).toBe(401_002);
    expect(p.toolCount).toBe(2);
    expect(p.ended).toBe(false);
    expect(p.turn).toBe("tool");
  });

  test("同一 message.id 的块归并：先文本后工具 = tool；新消息重新开始", () => {
    const p = feed([
      asst("2026-09-24T01:00:00Z", null, [{ type: "text", text: "Let me write the file." }], "m1"),
      asst("2026-09-24T01:03:00Z", "tool_use", [{ type: "tool_use", id: "t1", name: "Write" }], "m1"),
    ]);
    expect(p.turn).toBe("tool");
    const next = nextProgress(nextProgress(p, result("2026-09-24T01:03:01Z", "t1")), asst("2026-09-24T01:04:00Z", null, [{ type: "text", text: REPORT }], "m2"));
    expect(next.turn).toBe("text");
    expect(next.textChars).toBe(REPORT.trim().length);
  });

  test("end_turn → ended；之后又被续上（再来 assistant）→ 取消", () => {
    const done = feed([asst("2026-09-24T01:00:00Z", "end_turn", [{ type: "text", text: "完成" }])]);
    expect(done.ended).toBe(true);
    expect(nextProgress(done, asst("2026-09-24T01:05:00Z", "tool_use", [{ type: "tool_use", id: "t", name: "Bash" }])).ended).toBe(false);
  });

  test("attachment 记录不动状态和 token；坏记录原样返回", () => {
    const done = feed([asst("2026-09-24T01:00:00Z", "end_turn", [])]);
    const after = nextProgress(done, { type: "attachment", timestamp: "2026-09-24T01:00:01Z" });
    expect(after.ended).toBe(true);
    expect(after.ctxTokens).toBe(done.ctxTokens);
    expect(nextProgress(done, null)).toBe(done);
  });
});

describe("subagentEndStatus", () => {
  test("end_turn / stop_sequence → 立即 done", () => {
    expect(status(feed([asst("2026-09-24T01:00:00Z", "end_turn", [{ type: "text", text: REPORT }])]), 0)).toBe("done");
    expect(status(feed([asst("2026-09-24T01:00:00Z", "stop_sequence", [{ type: "text", text: "You've hit your session limit" }])]), 0)).toBe("done");
  });

  test("最终答复 stop_reason 为 null（实测约 1/5）→ 静默 90s 后 done，不再挂满 30 分钟", () => {
    const p = feed([
      asst("2026-09-24T01:00:00Z", "tool_use", [{ type: "tool_use", id: "t1", name: "Read" }], "m1"),
      result("2026-09-24T01:00:01Z", "t1"),
      asst("2026-09-24T01:00:05Z", null, [{ type: "thinking", thinking: "" }], "m2"),
      asst("2026-09-24T01:00:30Z", null, [{ type: "text", text: REPORT }], "m2"),
    ]);
    expect(status(p, 30_000)).toBeNull();
    expect(status(p, 90_000)).toBe("done");
  });

  test("短文本（多半是工具前开场白，工具入参还在流式生成）要等 5 分钟", () => {
    const p = feed([asst("2026-09-24T01:00:00Z", null, [{ type: "text", text: "Let me write the findings file." }])]);
    expect(status(p, 4 * MIN)).toBeNull();
    expect(status(p, 5 * MIN)).toBe("done");
  });

  test("被中断（最后一条是 [Request interrupted by user…]，meta 没写 stoppedByUser）→ stopped", () => {
    const forTool = feed([
      asst("2026-09-24T01:00:00Z", "tool_use", [{ type: "tool_use", id: "t1", name: "WebFetch" }]),
      result("2026-09-24T01:00:01Z", "t1", true),
      user("2026-09-24T01:00:01Z", [{ type: "text", text: "[Request interrupted by user for tool use]" }]),
    ]);
    expect(status(forTool, 0)).toBe("stopped");
    const plain = feed([asst("2026-09-24T01:00:00Z", "tool_use", [{ type: "tool_use", id: "t1", name: "Bash" }]), user("2026-09-24T01:00:20Z", "[Request interrupted by user]")]);
    expect(status(plain, 0)).toBe("stopped");
    expect(status(feed([asst("2026-09-24T01:00:00Z", "end_turn", [])]), 0, { stoppedByUser: true })).toBe("stopped");
  });

  test("工具调用未返回（等 CI）→ 20 分钟仍在跑，超 30 分钟兜底才 idle", () => {
    const p = feed([
      asst("2026-09-24T01:00:00Z", null, [{ type: "text", text: REPORT }], "m1"),
      asst("2026-09-24T01:00:02Z", "tool_use", [{ type: "tool_use", id: "t1", name: "Bash" }], "m1"),
    ]);
    expect(status(p, 20 * MIN)).toBeNull();
    expect(status(p, LIMIT + 1)).toBe("idle");
    // 结果回来了模型还要接着想：同样不按「像答复」收尾
    expect(status(nextProgress(p, result("2026-09-24T01:20:00Z", "t1")), 20 * MIN)).toBeNull();
  });

  test("StructuredOutput 交答卷 → 静默 90s 后 done；答卷被驳回（is_error）→ 继续跑", () => {
    const p = feed([
      asst("2026-09-24T01:00:00Z", null, [{ type: "thinking", thinking: "" }], "m1"),
      asst("2026-09-24T01:00:40Z", "tool_use", [{ type: "tool_use", id: "so", name: "StructuredOutput" }], "m1"),
      { ...result("2026-09-24T01:00:40Z", "so"), toolEndsTurn: true },
    ]);
    expect(p.turn).toBe("structured");
    expect(status(p, 10_000)).toBeNull();
    expect(status(p, 90_000)).toBe("done");
    const rejected = nextProgress(feed([asst("2026-09-24T01:00:00Z", "tool_use", [{ type: "tool_use", id: "so", name: "StructuredOutput" }])]), result("2026-09-24T01:00:01Z", "so", true));
    expect(status(rejected, 90_000)).toBeNull();
  });

  test("只有 thinking（模型还在想）→ 不收尾", () => {
    expect(status(feed([asst("2026-09-24T01:00:00Z", null, [{ type: "thinking", thinking: "" }])]), 20 * MIN)).toBeNull();
  });
});

test("readSubagentMeta 读同名 .meta.json；没有就返回空对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-meta-"));
  const f = join(dir, "agent-a1.jsonl");
  writeFileSync(f.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Line A: #204 then #206", model: "opus", stoppedByUser: true }));
  expect(readSubagentMeta(f)).toEqual({ description: "Line A: #204 then #206", agentType: "general-purpose", model: "opus", stoppedByUser: true });
  expect(readSubagentMeta(join(dir, "agent-none.jsonl"))).toEqual({});
});
