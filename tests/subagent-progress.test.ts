import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EMPTY_PROGRESS, nextProgress, readSubagentMeta, subagentEndStatus } from "../src/lib/subagent-progress";

const asst = (ts: string, stop: string | null, content: unknown[], usage = { input_tokens: 2, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 1_000 }) => ({
  type: "assistant",
  timestamp: ts,
  message: { stop_reason: stop, usage, content },
});
const feed = (recs: unknown[]) => recs.reduce(nextProgress, EMPTY_PROGRESS);

describe("nextProgress", () => {
  test("耗时从第一条记录算，上下文取最近一条 assistant（input + cache 读写）", () => {
    const p = feed([
      { type: "user", timestamp: "2026-09-24T01:41:00.000Z" },
      asst("2026-09-24T01:42:00.000Z", "tool_use", [{ type: "tool_use", name: "Bash" }, { type: "tool_use", name: "Read" }]),
      { type: "user", timestamp: "2026-09-24T02:10:00.000Z" },
    ]);
    expect(p.firstTs).toBe(Date.parse("2026-09-24T01:41:00.000Z"));
    expect(p.lastTs).toBe(Date.parse("2026-09-24T02:10:00.000Z"));
    expect(p.ctxTokens).toBe(401_002);
    expect(p.toolCount).toBe(2);
    expect(p.ended).toBe(false);
  });

  test("最后一条 assistant 是 end_turn → ended；之后又被续上（再来 assistant）→ 取消", () => {
    const done = feed([asst("2026-09-24T01:00:00Z", "end_turn", [{ type: "text", text: "完成" }])]);
    expect(done.ended).toBe(true);
    expect(nextProgress(done, asst("2026-09-24T01:05:00Z", "tool_use", [{ type: "tool_use" }])).ended).toBe(false);
  });

  test("user / attachment 记录不动 ended 和 token；坏记录原样返回", () => {
    const done = feed([asst("2026-09-24T01:00:00Z", "end_turn", [])]);
    const after = nextProgress(done, { type: "attachment", timestamp: "2026-09-24T01:00:01Z" });
    expect(after.ended).toBe(true);
    expect(after.ctxTokens).toBe(done.ctxTokens);
    expect(nextProgress(done, null)).toBe(done);
  });
});

describe("subagentEndStatus", () => {
  const LIMIT = 30 * 60_000;
  test("静默很久但没超上限 → 还在跑（旧规则 3 分钟就判完成）", () => {
    expect(subagentEndStatus({ toolCount: 3, ended: false }, {}, 20 * 60_000, LIMIT)).toBeNull();
  });
  test("end_turn → done；被用户停止 → stopped（优先）；超上限 → idle", () => {
    expect(subagentEndStatus({ toolCount: 0, ended: true }, {}, 0, LIMIT)).toBe("done");
    expect(subagentEndStatus({ toolCount: 0, ended: true }, { stoppedByUser: true }, 0, LIMIT)).toBe("stopped");
    expect(subagentEndStatus({ toolCount: 0, ended: false }, {}, LIMIT + 1, LIMIT)).toBe("idle");
  });
});

test("readSubagentMeta 读同名 .meta.json；没有就返回空对象", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-meta-"));
  const f = join(dir, "agent-a1.jsonl");
  writeFileSync(f.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "general-purpose", description: "Line A: #204 then #206", model: "opus", stoppedByUser: true }));
  expect(readSubagentMeta(f)).toEqual({ description: "Line A: #204 then #206", agentType: "general-purpose", model: "opus", stoppedByUser: true });
  expect(readSubagentMeta(join(dir, "agent-none.jsonl"))).toEqual({});
});
