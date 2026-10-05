import { describe, expect, test } from "bun:test";
import { classifyAirFailure } from "../src/lib/acp/failures.ts";
import { stampTranscript, transcriptOfEntry, transcriptOfFailure, transcriptOfInbound, transcriptOfStop } from "../src/lib/acp/transcript.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";

// ACP 宿主窗口里的可读会话：session/update 先过真的翻译器（宿主推给 bridge 的同一批条目），再渲染成窗口文本
const chunk = (messageId: string, text: string) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } });
const SECRET = "sk-abcdefghijklmnopqrstuvwx1234";

function render(updates: unknown[]): string[] {
  const t = createAcpTranslator(() => "T");
  return [...updates.flatMap((u) => t.push(u)), ...t.flush()].flatMap(transcriptOfEntry);
}

describe("ACP 窗口会话", () => {
  test("正文增量攒成整段、工具起止各一行、MCP reply 显示正文；回合结束一行", () => {
    const out = [...render([
      chunk("m1", "我先看一下"),
      chunk("m1", "目录"),
      chunk("m1", "结构。"),
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "ls -la src && wc -l src/*.ts", status: "in_progress", rawInput: { command: "/bin/zsh -lc 'ls'" } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { data: "a.ts\nb.ts\n" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
      chunk("m2", "看完了，"),
      chunk("m2", "一切正常。"),
      { sessionUpdate: "tool_call", toolCallId: "c2", status: "in_progress", _meta: { is_mcp_tool_call: true },
        rawInput: { server: "claudestra", tool: "reply", arguments: { chat_id: "api:owner", text: "做完了：两个文件" } } },
      { sessionUpdate: "tool_call_update", toolCallId: "c2", status: "completed", rawOutput: { result: { content: [{ type: "text", text: "sent" }] } } },
      { sessionUpdate: "plan", entries: [{ content: "读代码", status: "completed" }, { content: "改代码", status: "in_progress" }] },
      chunk("m3", "收尾"),
    ]), transcriptOfStop({ event: "Stop", stopHookActive: false })];
    expect(out).toEqual([
      "🤖 我先看一下目录结构。",
      "💻 ls -la src && wc -l src/*.ts",
      "  ↳ a.ts\n    b.ts",
      "🤖 看完了，一切正常。",
      "💬 回复：做完了：两个文件",
      "  ↳ sent",
      "📋 计划\n  ✓ 读代码\n  ▸ 改代码",
      "🤖 收尾",
      "── 回合结束 ──",
    ]);
  });

  test("回合失败（cyber_policy）：原因原文 + 失败收尾；打断单独一行", () => {
    const f = classifyAirFailure({ id: "f1", revision: 1, category: "policy", severity: "error", actions: [],
      title: "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing" });
    expect(transcriptOfFailure(f)).toBe("❌ 回合失败：This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing");
    expect(transcriptOfStop({ event: "StopFailure", stopHookActive: false })).toBe("── 回合失败 ──");
    expect(transcriptOfStop({ event: "StopFailure", stopHookActive: false, interrupt: true })).toBe("── 已打断 ──");
    expect(transcriptOfFailure({ kind: "quota", key: "q", message: "You've hit your usage limit." })).toBe("⛔ 额度用完：You've hit your usage limit.");
    expect(transcriptOfFailure({ kind: "auth", key: "a", message: "Authentication required" })).toBe("🔑 需要登录：Authentication required");
  });

  test("失败条目、用量、模型状态不重复显示（失败由宿主按 AcpFailure 另打）", () => {
    expect(transcriptOfEntry({ type: "assistant", error: "x", message: { content: [{ type: "text", text: "API Error: x" }] } })).toEqual([]);
    expect(transcriptOfEntry({ type: "system", subtype: "context_usage", tokens: 1 })).toEqual([]);
    expect(transcriptOfEntry({ type: "system", subtype: "model_state", model: "m" })).toEqual([]);
    expect(transcriptOfEntry({ type: "system", subtype: "compact_boundary" })).toEqual(["📦 上下文已压缩"]);
  });

  test("不显示 secret；超长工具结果只留开头几行并注明总行数", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} token=${SECRET}`).join("\n");
    const out = render([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: `curl -H 'Authorization: Bearer ${SECRET}' x`, status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", _meta: { terminal_output_delta: { data: long } } },
    ]);
    expect(out.join("\n")).not.toContain(SECRET);
    expect(out[1]!.split("\n")).toHaveLength(4);
    expect(out[1]).toStartWith("  ✗ line 0 token=[redacted]");
    expect(out[1]).toEndWith("…（共 50 行）");
    expect(transcriptOfInbound(`key: api_key=${SECRET}`, { user: "owner" })).toBe("👤 owner：key: api_key=[redacted]");
    expect(transcriptOfFailure({ kind: "error", key: "e", message: `bad ${SECRET}` })).not.toContain(SECRET);
  });

  test("入站消息剥掉 bridge 的来源头，用户自己打的方括号照留", () => {
    const head = "[🌐 来自 Web 端用户「dev」（HTTP API 接入，非 Discord）。\n用 reply() 回答到本 chat_id。]\n\n你好";
    expect(transcriptOfInbound(head, { user: "dev" })).toBe("👤 dev：你好");
    expect(transcriptOfInbound("[🤖 hi]\n\n正文", { user: "owner" })).toBe("👤 owner：[🤖 hi]\n\n正文");
  });

  test("一段多行：首行带时间，续行对齐", () => {
    expect(stampTranscript("📋 计划\n  ✓ a", new Date(2026, 9, 6, 9, 5, 7))).toBe("[09:05:07] 📋 计划\n             ✓ a");
  });
});
