import { describe, expect, test } from "bun:test";
import { createAcpTranslator, threadStatusOf } from "../src/lib/acp/updates.ts";

// 形状取自 codex-acp 2.0.0：ContentChunks.ts、tool-calls/reporters/{McpToolReporter,CommandReporter}.ts、CodexEventHandler.ts
const TS = "2026-09-29T00:00:00.000Z";
const tr = () => createAcpTranslator(() => TS);
const say = (text: string, messageId?: string) => ({ sessionUpdate: "agent_message_chunk", ...(messageId ? { messageId } : {}), content: { type: "text", text } });
const assistantText = (text: string) => ({ type: "assistant", timestamp: TS, message: { content: [{ type: "text", text }] } });
const toolResult = (id: string, content: string, err = false) => ({
  type: "user",
  timestamp: TS,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(err ? { is_error: true } : {}) }] },
});

describe("正文增量", () => {
  test("同一条消息的增量攒着，回合结束 flush 才整条吐出", () => {
    const t = tr();
    expect(t.push(say("你好", "m1"))).toEqual([]);
    expect(t.push(say("，世界", "m1"))).toEqual([]);
    expect(t.flush()).toEqual([assistantText("你好，世界")]);
    expect(t.flush()).toEqual([]);
  });

  test("换了 messageId 先吐上一条", () => {
    const t = tr();
    t.push(say("a", "m1"));
    expect(t.push(say("b", "m2"))).toEqual([assistantText("a")]);
    expect(t.flush()).toEqual([assistantText("b")]);
  });

  test("思考、历史回放、命令表不进流式条目（和 tmux 下 rollout 的显示一致）", () => {
    const t = tr();
    expect(t.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "**Planning**" } })).toEqual([]);
    expect(t.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } })).toEqual([]);
    expect(t.push({ sessionUpdate: "available_commands_update", availableCommands: [] })).toEqual([]);
    expect(t.flush()).toEqual([]);
  });
});

describe("工具调用", () => {
  const mcpStart = {
    sessionUpdate: "tool_call",
    toolCallId: "item-1",
    kind: "execute",
    title: "mcp.claudestra.reply",
    status: "in_progress",
    rawInput: { server: "claudestra", tool: "reply", arguments: { chat_id: "local-1", text: "好了" } },
    _meta: { is_mcp_tool_call: true },
  };

  test("MCP：先吐攒着的正文，再吐 mcp__<server>__<tool> 的 tool_use（reply 的识别照旧），完成吐 tool_result", () => {
    const t = tr();
    t.push(say("看一下"));
    expect(t.push(mcpStart)).toEqual([
      assistantText("看一下"),
      { type: "assistant", timestamp: TS, message: { content: [{ type: "tool_use", id: "item-1", name: "mcp__claudestra__reply", input: { chat_id: "local-1", text: "好了" } }] } },
    ]);
    const done = { sessionUpdate: "tool_call_update", toolCallId: "item-1", status: "completed", rawOutput: { result: { content: [{ type: "text", text: "sent" }] }, error: null } };
    expect(t.push(done)).toEqual([toolResult("item-1", "sent")]);
    expect(t.push(done)).toEqual([]); // 迟到的重复更新不再起头
  });

  test("MCP 出错：error.message 当结果、标 is_error", () => {
    const t = tr();
    t.push(mcpStart);
    expect(t.push({ sessionUpdate: "tool_call_update", toolCallId: "item-1", status: "failed", rawOutput: { result: null, error: { message: "bridge down" } } })).toEqual([
      toolResult("item-1", "bridge down", true),
    ]);
  });

  test("命令：标题就是去掉 shell 前缀的命令；终端输出按增量攒，完成时整段当结果", () => {
    const t = tr();
    const start = {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      kind: "execute",
      title: "ls -la",
      status: "in_progress",
      rawInput: { command: "/bin/zsh -lc 'ls -la'", cwd: "/w" },
      content: [{ type: "terminal", terminalId: "c1" }],
      _meta: { terminal_info: { cwd: "/w", terminal_id: "c1" } },
    };
    expect(t.push(start)).toEqual([{ type: "assistant", timestamp: TS, message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls -la" } }] } }]);
    expect(t.push({ sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { data: "a\n", terminal_id: "c1" } } })).toEqual([]);
    t.push({ sessionUpdate: "tool_call_update", toolCallId: "c1", _meta: { terminal_output_delta: { data: "b\n", terminal_id: "c1" } } });
    expect(t.push({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", _meta: { terminal_exit: { exit_code: 0, terminal_id: "c1" } } })).toEqual([
      toolResult("c1", "a\nb\n"),
    ]);
  });

  test("读文件 / 编辑按 locations 给路径；只有 exit_code 时结果写 exit N；认不出的 kind 用标题当工具名", () => {
    const t = tr();
    const read = t.push({ sessionUpdate: "tool_call", toolCallId: "r", kind: "read", title: "Read file 'a.ts'", status: "completed", locations: [{ path: "/w/a.ts" }], rawOutput: { exit_code: 0 } });
    expect(read).toEqual([
      { type: "assistant", timestamp: TS, message: { content: [{ type: "tool_use", id: "r", name: "Read", input: { file_path: "/w/a.ts" } }] } },
      toolResult("r", "exit 0"),
    ]);
    const edit = t.push({ sessionUpdate: "tool_call", toolCallId: "e", kind: "edit", title: "Edit", status: "in_progress", locations: [{ path: "/w/b.ts" }] });
    expect(edit[0].message.content[0]).toMatchObject({ name: "Edit", input: { file_path: "/w/b.ts" } });
    const other = t.push({ sessionUpdate: "tool_call", toolCallId: "o", kind: "other", title: "view_image", status: "in_progress", rawInput: { path: "x.png" } });
    expect(other[0].message.content[0]).toMatchObject({ name: "view_image", input: { path: "x.png" } });
  });

  test("非终端输出：content 里的文本块当结果", () => {
    const t = tr();
    t.push({ sessionUpdate: "tool_call", toolCallId: "s", kind: "search", title: "TODO", status: "in_progress" });
    expect(t.push({ sessionUpdate: "tool_call_update", toolCallId: "s", status: "completed", content: [{ type: "content", content: { type: "text", text: "a.ts:1" } }] })).toEqual([
      toolResult("s", "a.ts:1"),
    ]);
  });
});

describe("计划 / 用量 / 配置 / 线程状态", () => {
  test("plan → update_plan 的 tool_use + 结果（与 rollout 里 Codex 的计划工具同名同参）", () => {
    const t = tr();
    const out = t.push({ sessionUpdate: "plan", entries: [{ content: "读代码", status: "completed", priority: "medium" }, { content: "改", status: "in_progress", priority: "medium" }] });
    expect(out[0].message.content[0]).toEqual({
      type: "tool_use",
      id: "acp-plan-1",
      name: "update_plan",
      input: { plan: [{ step: "读代码", status: "completed" }, { step: "改", status: "in_progress" }] },
    });
    expect(out[1]).toEqual(toolResult("acp-plan-1", "Plan updated"));
  });

  test("usage_update → context_usage（used=0 不报）", () => {
    const t = tr();
    expect(t.push({ sessionUpdate: "usage_update", used: 51234, size: 272000 })).toEqual([{ type: "system", subtype: "context_usage", timestamp: TS, tokens: 51234, window: 272000 }]);
    expect(t.push({ sessionUpdate: "usage_update", used: 0, size: 272000 })).toEqual([]);
  });

  test("config_option_update → model_state", () => {
    const t = tr();
    const u = {
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "model", name: "Model", type: "select", currentValue: "gpt-5.6-luna", options: [{ value: "gpt-5.6-luna", name: "luna" }] },
        { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }] },
      ],
    };
    expect(t.push(u)).toEqual([{ type: "system", subtype: "model_state", timestamp: TS, model: "gpt-5.6-luna", effort: "low" }]);
  });

  test("Codex 不变：session_info_update（线程状态 / 标题）、没标 display 的思考不出条目，只有 Pi 适配器的 _meta.claudestra 记号才出", () => {
    const t = tr();
    t.push(say("正文", "m1"));
    for (const u of [
      { sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } },
      { sessionUpdate: "session_info_update", title: "x", _meta: { codex: { notice: "不是我们的记号" } } },
      { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "**Planning**" }, _meta: { codex: { display: true } } },
    ]) expect(t.push(u)).toEqual([]);
    expect(t.push({ sessionUpdate: "session_info_update", _meta: { claudestra: { notice: "提示" } } })).toEqual([
      assistantText("正文"), { type: "assistant", timestamp: TS, message: { content: [{ type: "thinking", thinking: "提示" }] } },
    ]);
  });

  test("threadStatusOf：session_info_update 里的线程状态（steer 另起的回合靠它等结束）", () => {
    expect(threadStatusOf({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "idle" } } } })).toBe("idle");
    expect(threadStatusOf({ sessionUpdate: "session_info_update", _meta: { codex: { threadStatus: { type: "active", activeFlags: [] } } } })).toBe("active");
    expect(threadStatusOf({ sessionUpdate: "session_info_update", title: "x" })).toBeNull();
    expect(threadStatusOf({ sessionUpdate: "plan" })).toBeNull();
  });
});

// 形状取自 codex-acp 2.1.1：CodexSessionCompactions.ts（声明了 session.compaction 才发）；核对见 docs/runtimes/codex-acp.md「压缩完成信号」
describe("压缩完成（compaction_update / _meta.claudestra.compacted）", () => {
  const codex = (trigger: () => "manual" | "auto" = () => "auto") => createAcpTranslator(() => TS, { from: "compaction-update", trigger });
  const cu = (status: string, compactionId = "cmp_1", extra: Record<string, unknown> = {}) => ({ sessionUpdate: "compaction_update", compactionId, status, ...extra });
  const boundary = (compactMetadata: Record<string, unknown>) => ({ type: "system", subtype: "compact_boundary", timestamp: TS, compactMetadata });
  const thinking = (t: string) => ({ type: "assistant", timestamp: TS, message: { content: [{ type: "thinking", thinking: t }] } });

  test("in_progress 只是进度句；completed 才出边界（先吐攒着的正文），trigger 由宿主给", () => {
    let manual = true;
    const t = codex(() => (manual ? "manual" : "auto"));
    expect(t.push(cu("in_progress"))).toEqual([thinking("📦 正在压缩上下文…")]);
    expect(t.push(cu("in_progress"))).toEqual([]);
    t.push(say("压缩前的话", "m1"));
    expect(t.push(cu("completed"))).toEqual([assistantText("压缩前的话"), boundary({ trigger: "manual" })]);
    manual = false;
    expect(t.push(cu("completed", "cmp_2"))).toEqual([boundary({ trigger: "auto" })]);
  });

  test("同一 compactionId 的 completed 重复到、终态后迟到的更新：不再出第二条", () => {
    const t = codex();
    expect(t.push(cu("completed"))).toHaveLength(1);
    expect(t.push(cu("completed"))).toEqual([]);
    expect(t.push(cu("failed", "cmp_1", { error: "迟到" }))).toEqual([]);
    expect(t.push(cu("failed", "cmp_9", { error: "上下文太大" }))).toEqual([thinking("上下文压缩没成功：上下文太大")]);
    expect(t.push(cu("completed", "cmp_9"))).toEqual([]);
  });

  test("failed / cancelled / 未知状态 / 缺 id 都不出边界", () => {
    const t = codex();
    for (const u of [cu("cancelled"), cu("paused", "cmp_2"), { sessionUpdate: "compaction_update", status: "completed" }]) expect(t.push(u)).toEqual([]);
    expect(t.push(cu("failed", "cmp_3"))).toEqual([thinking("上下文压缩没成功")]);
  });

  test("来源按运行时定：Codex 不认 _meta.claudestra.compacted，Pi 不认 compaction_update", () => {
    const forged = { sessionUpdate: "session_info_update", _meta: { claudestra: { compacted: { trigger: "manual" } } } };
    expect(codex().push(forged)).toEqual([]);
    const pi = tr();
    expect(pi.push(cu("completed"))).toEqual([]);
    expect(pi.push(forged)).toEqual([boundary({ trigger: "manual" })]);
  });
});
