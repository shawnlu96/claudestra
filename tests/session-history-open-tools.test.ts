/**
 * 历史工具卡的「还没结果」标记：网页每 7s 的差量会把直播卡换成历史卡，历史必须说清哪张还在跑
 * （web/lib/chat/history-shape.ts 据此画 running），并带 tool_use id 让直播的 tool_done 找得到它。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readSessionHistory } from "../src/lib/session-history.js";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const line = (r: unknown) => JSON.stringify(r) + "\n";

function jsonl(records: unknown[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "hist-open-")), `${SID}.jsonl`);
  writeFileSync(p, records.map(line).join(""));
  return p;
}

const use = (id: string | undefined, name = "Bash", ts = "2026-10-01T00:00:00Z") => ({
  type: "assistant",
  timestamp: ts,
  message: { content: [{ type: "tool_use", ...(id ? { id } : {}), name, input: { command: "bun test" } }] },
});
const result = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: "2026-10-01T00:05:00Z",
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...extra }] },
});

const toolsOf = async (p: string, opts: { after?: number } = {}) =>
  (await readSessionHistory(p, opts)).messages.flatMap((m) => m.tools ?? []);

describe("open tool cards", () => {
  test("a tool_use with no tool_result yet is open and carries its id; a settled one is not open", async () => {
    const p = jsonl([use("t1"), result("t1"), use("t2")]);
    expect(await toolsOf(p)).toEqual([
      { name: "Bash", summary: "Bash", id: "t1" },
      { name: "Bash", summary: "Bash", id: "t2", open: true },
    ]);
  });

  test("a failed result settles the card and still marks it red", async () => {
    const p = jsonl([use("t1"), result("t1", { is_error: true })]);
    expect(await toolsOf(p)).toEqual([{ name: "Bash", summary: "Bash", id: "t1", error: true }]);
  });

  test("a tool_use without an id is neither open nor addressable", async () => {
    expect(await toolsOf(jsonl([use(undefined)]))).toEqual([{ name: "Bash", summary: "Bash" }]);
  });

  test("Codex MCP calls put the result in the same assistant record: settled, not open", async () => {
    const rec = {
      type: "assistant",
      timestamp: "2026-10-01T00:00:00Z",
      message: {
        content: [
          { type: "tool_use", id: "c1", name: "mcp__mem0__search", input: {} },
          { type: "tool_result", tool_use_id: "c1", content: "hits" },
        ],
      },
    };
    expect(await toolsOf(jsonl([rec]))).toEqual([{ name: "mcp__mem0__search", summary: "mcp__mem0__search", id: "c1" }]);
  });

  test("the card turns settled once its result lands; a delta that starts after the tool_use does not re-send it", async () => {
    const p = jsonl([{ type: "user", timestamp: "2026-10-01T00:00:00Z", message: { content: "跑测试" } }, use("t1")]);
    expect((await toolsOf(p, { after: 0 }))[0]?.open).toBe(true);
    appendFileSync(p, line(result("t1")));
    expect((await toolsOf(p))[0]?.open).toBeUndefined();
    expect(await toolsOf(p, { after: 1 })).toEqual([]); // 结果记录本身不是消息：收尾靠直播的 tool_done 按 id 找卡
  });
});
