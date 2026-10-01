import { describe, expect, test } from "bun:test";
import {
  configOptions, createPiEventMapper, dialogCancel, mcpServersForPi, splitModelValue, stopReasonOf, threadStatus, usageUpdate,
} from "../src/lib/acp/pi-adapter/map.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";

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

  test("工具：内置工具按 kind 给标题 / 路径，MCP 拆成 server/tool/arguments；宿主翻出 Bash / Read / mcp__claudestra__reply", () => {
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
      ["Bash", { command: "ls -la" }], ["Read", { file_path: "/w/x.ts" }], ["mcp__claudestra__reply", { chat_id: "api:t", text: "hi" }], ["ls", { path: "/w" }],
    ]);
    expect(blocks.filter((b) => b.type === "tool_result").map((b) => [b.content, b.is_error ?? false])).toEqual([["total 0", false], ["boom", true], ["sent", false]]);
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
