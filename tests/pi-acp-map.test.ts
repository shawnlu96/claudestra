import { describe, expect, test } from "bun:test";
import {
  configOptions, createPiEventMapper, dialogCancel, mcpServersForPi, splitModelValue, stopReasonOf, threadStatus, usageUpdate,
} from "../src/lib/acp/pi-adapter/map.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";
import { piLineToClaudeShape } from "../src/lib/pi-session.ts";

const assistantStart = { type: "message_start", message: { role: "assistant", content: [] } };
const delta = (text: string) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
const assistantEnd = (extra: Record<string, unknown> = {}) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "whole" }], stopReason: "stop", ...extra } });

describe("Pi 适配器 · 事件映射", () => {
  test("text_delta → agent_message_chunk，每条助手消息一个 messageId；思考、用户消息不出", () => {
    const m = createPiEventMapper();
    const out = [
      assistantStart, delta("你"), delta("好"), { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "想" } }, assistantEnd(),
      { type: "message_start", message: { role: "user", content: "q" } }, assistantStart, delta("再见"),
    ].flatMap((e) => m.push(e));
    expect(out.map((u) => [u.sessionUpdate, u.messageId, u.content.text])).toEqual([
      ["agent_message_chunk", "msg-1", "你"], ["agent_message_chunk", "msg-1", "好"], ["agent_message_chunk", "msg-2", "再见"],
    ]);
  });

  test("provider 不流式：message_end 补整段正文；结局按最后一条助手消息记，取走即清", () => {
    const m = createPiEventMapper();
    expect(m.push(assistantStart)).toEqual([]);
    expect(m.push(assistantEnd({ stopReason: "error", errorMessage: "529 overloaded" }))).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text: "whole" } },
    ]);
    expect(m.takeOutcome()).toEqual({ stopReason: "error", errorMessage: "529 overloaded" });
    expect(m.takeOutcome()).toEqual({});
  });

  test("工具：内置工具按 kind 给标题 / 路径，MCP 拆成 server/tool/arguments；宿主翻出 Bash / Read / mcp__claudestra__reply / LS", () => {
    const m = createPiEventMapper();
    const start = (id: string, toolName: string, args: object) => m.push({ type: "tool_execution_start", toolCallId: id, toolName, args });
    const end = (id: string, text: string, isError = false) => m.push({ type: "tool_execution_end", toolCallId: id, result: { content: [{ type: "text", text }] }, isError });
    const ups = [
      ...start("a", "bash", { command: "ls -la", timeout: 5 }), ...end("a", "total 0"),
      ...start("b", "read", { path: "/w/x.ts" }), ...end("b", "boom", true),
      ...start("c", "mcp__claudestra__reply", { chat_id: "api:t", text: "hi" }), ...end("c", "sent"),
      ...start("d", "ls", { path: "/w" }),
    ];
    expect(ups[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "execute", title: "ls -la", status: "in_progress" });
    expect(ups[2]).toMatchObject({ kind: "read", title: "/w/x.ts", locations: [{ path: "/w/x.ts" }] });
    expect(ups[3]).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    expect(ups[4]).toMatchObject({ rawInput: { server: "claudestra", tool: "reply", arguments: { chat_id: "api:t", text: "hi" } }, _meta: { is_mcp_tool_call: true } });
    expect(ups[6]).toMatchObject({ kind: "other", title: "ls", rawInput: { path: "/w" } });
    const t = createAcpTranslator(() => "T");
    const blocks = ups.flatMap((u) => t.push(u)).map((e) => e.message.content[0]);
    expect(blocks.filter((b) => b.type === "tool_use").map((b) => [b.name, b.input])).toEqual([
      ["Bash", { command: "ls -la" }], ["Read", { file_path: "/w/x.ts" }], ["mcp__claudestra__reply", { chat_id: "api:t", text: "hi" }], ["LS", { path: "/w" }],
    ]);
    expect(blocks.filter((b) => b.type === "tool_result").map((b) => [b.content, b.is_error ?? false])).toEqual([["total 0", false], ["boom", true], ["sent", false]]);
  });

  test("工具卡入参与 tmux 版（会话文件 → piLineToClaudeShape）逐字一致：Edit 带 diff、Write 带内容、find 是 Glob", () => {
    const calls: [string, Record<string, unknown>][] = [
      ["edit", { path: "/w/a.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }],
      ["write", { path: "/w/b.md", content: "# 标题\n正文" }],
      ["find", { pattern: "**/*.ts", path: "/w" }],
      ["grep", { pattern: "TODO", path: "/w", glob: "*.ts", ignoreCase: true }],
      ["read", { path: "/w/c.ts", offset: 10, limit: 20 }],
      ["bash", { command: "ls", timeout: 5 }],
    ];
    const m = createPiEventMapper();
    const t = createAcpTranslator(() => "T");
    for (const [i, [toolName, args]] of calls.entries()) {
      const [live] = m.push({ type: "tool_execution_start", toolCallId: `t${i}`, toolName, args }).flatMap((u) => t.push(u));
      const line = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `t${i}`, name: toolName, arguments: args }] } });
      expect(live.message.content[0], toolName).toEqual(piLineToClaudeShape(line)!.message.content[0]);
    }
  });

  test("嵌套调用不带 toolUse：宿主照旧按标题显示，「↳ 」留得住", () => {
    const m = createPiEventMapper();
    const t = createAcpTranslator(() => "T");
    const [e] = m.push({ type: "tool_execution_start", toolCallId: "c1/1", toolName: "bash", args: { command: "ls" }, parentToolCallId: "c1" }).flatMap((u) => t.push(u));
    expect(e.message.content[0]).toMatchObject({ name: "Bash", input: { command: "↳ ls" } });
  });

  test("思考：thinking_end 的整块 → 带 display 记号的 agent_thought_chunk，宿主翻成 thinking 块（同 tmux 版 piBlocksToClaude）", () => {
    const m = createPiEventMapper();
    const t = createAcpTranslator(() => "T");
    const ups = [
      assistantStart, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "先看看目录" } },
      delta("好的"), assistantEnd({ content: [{ type: "thinking", thinking: "先看看目录" }, { type: "text", text: "好的" }] }),
    ].flatMap((e) => m.push(e));
    expect(ups[0]).toEqual({ sessionUpdate: "agent_thought_chunk", messageId: "msg-1", content: { type: "text", text: "先看看目录" }, _meta: { claudestra: { display: true } } });
    expect([...ups.flatMap((u) => t.push(u)), ...t.flush()].map((e) => e.message.content[0])).toEqual([{ type: "thinking", thinking: "先看看目录" }, { type: "text", text: "好的" }]);
  });

  test("provider 不流式：message_end 里的思考先于正文补出", () => {
    const m = createPiEventMapper();
    m.push(assistantStart);
    const ups = m.push(assistantEnd({ content: [{ type: "thinking", thinking: "想一下" }, { type: "thinking", thinking: " " }, { type: "text", text: "答" }] }));
    expect(ups.map((u) => [u.sessionUpdate, u.content.text])).toEqual([["agent_thought_chunk", "想一下"], ["agent_message_chunk", "答"]]);
  });

  test("自动压缩：开始给一行提示，完成 → compact_boundary（带前后 tokens、trigger=auto）；手动的归 server 说、被打断的不说、失败给原因", () => {
    const m = createPiEventMapper();
    const t = createAcpTranslator(() => "T");
    const entries = (ev: Record<string, unknown>) => m.push(ev).flatMap((u) => t.push(u));
    const result = { summary: "s", firstKeptEntryId: "e1", tokensBefore: 150_000, estimatedTokensAfter: 32_000 };
    expect(entries({ type: "compaction_start", reason: "threshold" })).toEqual([
      { type: "assistant", timestamp: "T", message: { content: [{ type: "thinking", thinking: "正在自动压缩上下文…" }] } },
    ]);
    expect(entries({ type: "compaction_end", reason: "threshold", result, aborted: false, willRetry: false })).toEqual([
      { type: "system", subtype: "compact_boundary", timestamp: "T", compactMetadata: { preTokens: 150_000, postTokens: 32_000, trigger: "auto" } },
    ]);
    expect(entries({ type: "compaction_end", reason: "overflow", result, aborted: false, willRetry: true })[0]).toMatchObject({ subtype: "compact_boundary" });
    expect(entries({ type: "compaction_start", reason: "manual" })).toEqual([]);
    expect(entries({ type: "compaction_end", reason: "manual", result, aborted: false, willRetry: false })).toEqual([]);
    expect(entries({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false })).toEqual([]);
    expect(entries({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "Auto-compaction failed: boom" })[0].message.content[0].thinking)
      .toBe("上下文自动压缩没成：Auto-compaction failed: boom");
  });

  test("自动重试：auto_retry_start → 一行提示（原因、等几秒、第几次）；auto_retry_end 不说（成了接着出正文，败了按回合失败报）", () => {
    const m = createPiEventMapper();
    const [u] = m.push({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
    expect(u).toEqual({ sessionUpdate: "session_info_update", _meta: { claudestra: { notice: "请求出错：529 overloaded，2 秒后自动重试（1/3）" } } });
    expect(m.push({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([]);
    expect(m.push({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529" })).toEqual([]);
  });

  test("tool_execution_update 与 agent/turn 事件不产出 update", () => {
    const m = createPiEventMapper();
    for (const type of ["tool_execution_update", "agent_start", "turn_start", "turn_end", "agent_end", "agent_settled", "queue_update"]) expect(m.push({ type })).toEqual([]);
  });

  test("忙闲用中性键，不冒充 _meta.codex（宿主要在 PR1b 认它）", () => {
    expect(threadStatus("idle")).toEqual({ sessionUpdate: "session_info_update", _meta: { claudestra: { threadStatus: { type: "idle" } } } });
  });
});

describe("Pi 适配器 · 配置、用量、弹框、结局", () => {
  const model = (provider: string, id: string, name = id) => ({ provider, id, name });

  test("configOptions：id 沿用宿主认的 model / reasoning_effort，currentValue 取 pi 回报的实际值", () => {
    const opts = configOptions({ model: model("ds", "v4", "V4"), thinkingLevel: "high" }, [model("ds", "flash"), model("ds", "v4", "V4")], ["off", "high", "max"]);
    expect(opts).toEqual([
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "ds/v4", options: [{ value: "ds/flash", name: "flash" }, { value: "ds/v4", name: "V4" }] },
      { id: "reasoning_effort", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: ["off", "high", "max"].map((v) => ({ value: v, name: v })) },
    ]);
  });

  test("当前模型 / 思考档不在列表里也补进去（不然宿主本地校验会拒掉当前值）", () => {
    const [m, t] = configOptions({ model: model("x", "y"), thinkingLevel: "medium" }, [], ["off"]);
    expect(m.options).toEqual([{ value: "x/y", name: "y" }]);
    expect(t.options.map((o: { value: string }) => o.value)).toEqual(["medium", "off"]);
  });

  test("splitModelValue 按第一个斜杠切，模型 id 可以带斜杠；缺一半返回 null", () => {
    expect(splitModelValue("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
    for (const bad of ["noslash", "/m", "p/"]) expect(splitModelValue(bad)).toBeNull();
  });

  test("usage_update 取 contextUsage；压缩后 tokens 为 null 就不报", () => {
    expect(usageUpdate({ contextUsage: { tokens: 1881, contextWindow: 1_000_000, percent: 0.2 } })).toEqual({ sessionUpdate: "usage_update", used: 1881, size: 1_000_000 });
    expect(usageUpdate({ contextUsage: { tokens: null, contextWindow: 1_000_000 } })).toBeNull();
    expect(usageUpdate({})).toBeNull();
  });

  test("MCP env 的值转义成字面量：pi 会把 $X 换成环境变量、开头的 ! 当命令跑（pi 0.99.2 实测 x$HOME!y 变成 x/Users/…!y）", () => {
    const env = (value: string) => (mcpServersForPi([{ name: "s", command: "c", env: [{ name: "V", value }] }]) as { servers: Record<string, any> }).servers.s.env.V;
    expect(env("x$HOME!y")).toBe("x$$HOME!y");
    expect(env("!id")).toBe("$!id");
    expect(env("http://127.0.0.1:1/?t=a$${B}")).toBe("http://127.0.0.1:1/?t=a$$$${B}");
    expect(env("plain")).toBe("plain");
  });

  test("ACP stdio mcpServers → 挂载扩展的形状；非 stdio 拒", () => {
    expect(mcpServersForPi([{ name: "claudestra", command: "/bin/bun", args: ["cs.ts"], env: [{ name: "A", value: "1" }] }])).toEqual({
      servers: { claudestra: { command: "/bin/bun", args: ["cs.ts"], env: { A: "1" } } },
    });
    expect(mcpServersForPi(undefined)).toEqual({ servers: {} });
    expect(mcpServersForPi([{ type: "http", name: "h", url: "https://x" }])).toMatchObject({ error: expect.stringContaining("stdio") });
  });

  test("扩展弹框一律回取消；通知类不回", () => {
    for (const method of ["select", "confirm", "input", "editor"]) expect(dialogCancel({ id: "u1", method })).toEqual({ type: "extension_ui_response", id: "u1", cancelled: true });
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) expect(dialogCancel({ id: "u1", method })).toBeNull();
  });

  test("stopReason：被打断 / aborted → cancelled，length → max_tokens，error → null（回 JSON-RPC 错误）", () => {
    expect(stopReasonOf({ stopReason: "stop" }, true)).toBe("cancelled");
    expect(stopReasonOf({ stopReason: "aborted" }, false)).toBe("cancelled");
    expect(stopReasonOf({ stopReason: "length" }, false)).toBe("max_tokens");
    expect(stopReasonOf({ stopReason: "error" }, false)).toBeNull();
    expect(stopReasonOf({}, false)).toBe("end_turn");
  });
});

describe("Pi 适配器 · 嵌套工具调用", () => {
  test("带 parentToolCallId 的嵌套调用标成「↳ 」并在 _meta 留下父 id（网页才看得出脚本跑了什么）", () => {
    const m = createPiEventMapper();
    const [nested] = m.push({
      type: "tool_execution_start", toolCallId: "c1/1", toolName: "bash", args: { command: "ls" }, parentToolCallId: "c1",
    });
    expect(nested.sessionUpdate).toBe("tool_call");
    expect(String(nested.title).startsWith("↳ ")).toBe(true);
    expect((nested._meta as Record<string, unknown>).parentToolCallId).toBe("c1");
  });

  test("顶层调用不加标记（不污染平时的工具流）", () => {
    const m = createPiEventMapper();
    const [top] = m.push({ type: "tool_execution_start", toolCallId: "c2", toolName: "bash", args: { command: "ls" } });
    expect(String(top.title).startsWith("↳ ")).toBe(false);
    expect((top._meta as Record<string, unknown> | undefined)?.parentToolCallId).toBeUndefined();
  });
});
