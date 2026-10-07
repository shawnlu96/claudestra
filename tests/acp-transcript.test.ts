import { describe, expect, test } from "bun:test";
import { classifyAirFailure } from "../src/lib/acp/failures.ts";
import { createTranscriptStamper, transcriptOfEntry, transcriptOfFailure, transcriptOfInbound, transcriptOfStop } from "../src/lib/acp/transcript.ts";
import { createAcpTranslator, OUTPUT_TAIL } from "../src/lib/acp/updates.ts";

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
      "💻 ls -la src ＋1 条",
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

  test("不显示 secret；失败的超长输出只留末尾几行并注明总行数", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} token=${SECRET}`).join("\n");
    const out = render([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: `curl -H 'Authorization: Bearer ${SECRET}' x`, status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", _meta: { terminal_output_delta: { data: long } } },
    ]);
    expect(out.join("\n")).not.toContain(SECRET);
    expect(out[1]!.split("\n")).toHaveLength(5);
    expect(out[1]).toStartWith("  ✗ （共 50 行，末尾 4 行）\n    line 46 token=[redacted]");
    expect(out[1]).toEndWith("line 49 token=[redacted]");
    expect(transcriptOfInbound(`key: api_key=${SECRET}`, { user: "owner" })).toBe("👤 owner：key: api_key=[redacted]");
    expect(transcriptOfFailure({ kind: "error", key: "e", message: `bad ${SECRET}` })).not.toContain(SECRET);
  });

  test("正文、reply 也有上限：超长只留开头并注明总行数", () => {
    const long = Array.from({ length: 300 }, (_, i) => `第 ${i} 行`).join("\n");
    const [text] = transcriptOfEntry({ type: "assistant", message: { content: [{ type: "text", text: long }] } });
    expect(text!.split("\n")).toHaveLength(200);
    expect(text).toEndWith("…（共 300 行）");
    const [reply] = transcriptOfEntry({ type: "assistant", message: { content: [{ type: "tool_use", id: "r", name: "mcp__claudestra__reply", input: { text: "x".repeat(20_000) } }] } });
    expect(reply!.length).toBeLessThan(6_100);
    expect(reply).toEndWith("…（共 1 行）");
  });

  test("凭据类字段不进窗口：认证头、URL 账号密码、curl -u、cookie、credential（命令、结果、正文、reply、失败原因各一处）", () => {
    const out = render([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "curl -u admin:hunter2 https://bob:s3cretpw@x.example/api", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed",
        _meta: { terminal_output_delta: { data: "> Authorization: Basic dXNlcjpodW50ZXIy\n< Set-Cookie: sid=abcdef123; Path=/\n" } } },
      chunk("m1", '配置里是 {"credential": "c0ffee-1234"}'),
      { sessionUpdate: "tool_call", toolCallId: "c2", status: "completed", _meta: { is_mcp_tool_call: true },
        rawInput: { server: "claudestra", tool: "reply", arguments: { text: "用 https://bob:s3cretpw@x.example 拉" } } },
    ]).join("\n") + transcriptOfFailure({ kind: "error", key: "e", message: "401 for Authorization: Bearer abc.def.ghi" });
    for (const s of ["hunter2", "s3cretpw", "dXNlcjpodW50ZXIy", "abcdef123", "c0ffee-1234", "abc.def.ghi"]) expect(out).not.toContain(s);
    expect(out).toContain("Authorization: Basic [redacted]");
  });

  test("打码在格式化截断之前：密钥跨在 formatTool 的截断处也不留前缀（TaskCreate 80 字、send_to_agent 200 字）", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const tool = (name: string, input: Record<string, unknown>) =>
      transcriptOfEntry({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input }] } }).join("\n");
    expect(tool("TaskCreate", { subject: `${"x".repeat(73)} ${secret}` })).not.toContain("sk-abc");
    expect(tool("mcp__claudestra__send_to_agent", { target: "a", text: `${"y".repeat(193)} ${secret}` })).not.toContain("sk-abc");
    expect(tool("Read", { file_path: `/tmp/${secret}` })).not.toContain("sk-abc");
  });

  test("命令输出只留了末尾（updates.ts OUTPUT_TAIL）：开头被截成半行的那行不显示，里面可能是半个密钥", () => {
    const secretTail = "a1".repeat(30);
    const filler = "ok line\n".repeat(Math.ceil(OUTPUT_TAIL / 8));
    const out = render([
      { sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", title: "cat big.log", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { data: `sk-${secretTail}\n${filler}` } } },
      { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" },
    ]);
    expect(out[1]).toMatch(/^  ↳ \d+\+ 行输出$/);
    expect(out[1]).not.toContain("a1a1");
  });

  test("来源标签（meta.user / chat_id）也打码；窗口出口再兜一遍", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(transcriptOfInbound("hello", { user: secret })).toBe("👤 [redacted]：hello");
    expect(transcriptOfInbound("hello", { chat_id: `api:${secret}` })).not.toContain("sk-abc");
    expect(createTranscriptStamper()(`未打码的 ${secret}`, new Date(2026, 9, 6, 9, 5, 7))).toBe("[09:05:07] 未打码的 [redacted]");
  });

  test("入站消息剥掉 bridge 的来源头，用户自己打的方括号照留", () => {
    const head = "[🌐 来自 Web 端用户「dev」（HTTP API 接入，非 Discord）。\n用 reply() 回答到本 chat_id。]\n\n你好";
    expect(transcriptOfInbound(head, { user: "dev" })).toBe("👤 dev：你好");
    expect(transcriptOfInbound("[🤖 hi]\n\n正文", { user: "owner" })).toBe("👤 owner：[🤖 hi]\n\n正文");
  });

  test("一段多行：首行带时间，续行对齐", () => {
    expect(createTranscriptStamper()("📋 计划\n  ✓ a", new Date(2026, 9, 6, 9, 5, 7))).toBe("[09:05:07] 📋 计划\n             ✓ a");
  });
});
