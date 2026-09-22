/**
 * Codex 会话记录的定位与翻译（v2.24+）。
 *
 * owner 2026-09-22 拍板要让 Codex 也能被看见。边界很清楚：**能读不能跑**——我们对
 * Codex 只有 `codex exec` 一条通路，没有往它会话里注消息的手段，所以它不进
 * AgentRuntime，只作为只读会话来源。这里锁住格式契约。
 */
import { describe, test, expect } from "bun:test";
import {
  codexLineToClaudeShape,
  codexSessionIdFromFilename,
  codexTextOf,
  isCodexSessionPath,
} from "../src/lib/codex-session.js";

const L = (o: unknown) => JSON.stringify(o);
const TS = "2026-09-04T11:48:26.583Z";

describe("codexSessionIdFromFilename", () => {
  test("从 rollout-<ISO>-<uuid>.jsonl 里取 sessionId", () => {
    expect(codexSessionIdFromFilename("rollout-2026-09-04T20-48-22-01a06c3f-9ab4-73c3-b8b2-4083d09348c6.jsonl"))
      .toBe("01a06c3f-9ab4-73c3-b8b2-4083d09348c6");
  });
  test("别的文件名一律不认（目录名也会被送进来比对）", () => {
    expect(codexSessionIdFromFilename("04")).toBeNull();
    expect(codexSessionIdFromFilename("rollout-2026-09-04.jsonl")).toBeNull();
    expect(codexSessionIdFromFilename("session_index.jsonl")).toBeNull();
  });
});

describe("isCodexSessionPath", () => {
  test("只认 ~/.codex/sessions 下面的", () => {
    expect(isCodexSessionPath("/home/u/.codex/sessions/2026/09/04/x.jsonl", "/home/u")).toBe(true);
    expect(isCodexSessionPath("/home/u/.claude/projects/p/x.jsonl", "/home/u")).toBe(false);
    expect(isCodexSessionPath(null, "/home/u")).toBe(false);
  });
});

describe("codexTextOf", () => {
  test("content 数组拼成文本", () => {
    expect(codexTextOf([{ type: "input_text", text: "a" }, { type: "output_text", text: "b" }])).toBe("a\nb");
  });
  test("字符串直接返回；其它形状给空串", () => {
    expect(codexTextOf("hi")).toBe("hi");
    expect(codexTextOf(undefined)).toBe("");
    expect(codexTextOf([{ type: "image" }])).toBe("");
  });
});

describe("codexLineToClaudeShape", () => {
  test("session_meta → system 行，带 sessionId 与 cwd", () => {
    const e = codexLineToClaudeShape(L({
      timestamp: TS, type: "session_meta", payload: { session_id: "sid", cwd: "/w" },
    }))!;
    expect(e.type).toBe("system");
    expect(e.sessionId).toBe("sid");
    expect(e.cwd).toBe("/w");
  });

  test("user 消息 → Claude Code 的 user 行（content 是字符串）", () => {
    const e = codexLineToClaudeShape(L({
      timestamp: TS, type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看下这个" }] },
    }))!;
    expect(e.type).toBe("user");
    expect(e.message.content).toBe("帮我看下这个");
  });

  test("assistant 消息 → text block", () => {
    const e = codexLineToClaudeShape(L({
      timestamp: TS, type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "结论是…" }] },
    }))!;
    expect(e.type).toBe("assistant");
    expect(e.message.content).toEqual([{ type: "text", text: "结论是…" }]);
  });

  // 这两条是「历史面板会不会被刷屏」的关键
  test("developer 消息丢掉——那是系统提示/skills 块，每条好几 KB", () => {
    expect(codexLineToClaudeShape(L({
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>…" }] },
    }))).toBeNull();
  });

  test("reasoning 丢掉——encrypted_content 读不了、summary 实测恒空", () => {
    expect(codexLineToClaudeShape(L({
      type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "gAAAA…" },
    }))).toBeNull();
  });

  test("custom_tool_call → tool_use；字符串 input 包成 {command}（下游卡片要对象）", () => {
    const e = codexLineToClaudeShape(L({
      timestamp: TS, type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call_1", input: "ls -la" },
    }))!;
    expect(e.message.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "exec", input: { command: "ls -la" } });
  });

  test("custom_tool_call_output → user 里的 tool_result，按 call_id 对上", () => {
    const e = codexLineToClaudeShape(L({
      timestamp: TS, type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "input_text", text: "done" }] },
    }))!;
    expect(e.type).toBe("user");
    expect(e.message.content[0]).toEqual({ type: "tool_result", tool_use_id: "call_1", content: "done" });
  });

  test("function_call / function_call_output 同样认（Codex 的另一种工具形状）", () => {
    expect(codexLineToClaudeShape(L({
      type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c2", arguments: { cmd: "x" } },
    }))!.message.content[0].name).toBe("shell");
    expect(codexLineToClaudeShape(L({
      type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: "ok" },
    }))!.message.content[0].tool_use_id).toBe("c2");
  });

  test("遥测与内部状态一律丢掉", () => {
    for (const t of ["event_msg", "world_state", "turn_context", "token_usage_record"]) {
      expect(codexLineToClaudeShape(L({ type: t, payload: { type: "token_count" } }))).toBeNull();
    }
  });

  test("坏行不抛异常", () => {
    expect(codexLineToClaudeShape("{ 不是 json")).toBeNull();
    expect(codexLineToClaudeShape("")).toBeNull();
    expect(codexLineToClaudeShape("null")).toBeNull();
  });
});
