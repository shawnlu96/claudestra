/**
 * token 账（src/lib/usage-classify.ts）：哪些会话记录开新一轮、来源摘要的渲染与脱敏、调用的去重键和工具块。
 */
import { describe, test, expect } from "bun:test";
import { callOf, inboundOf, redactSecrets, triggerSummary } from "../src/lib/usage-classify.js";

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", uuid: "u1", timestamp: "2026-09-30T01:00:00Z", message: { role: "user", content }, ...extra });
const channel = (body: string, id = "m1") =>
  `<channel source="claudestra" chat_id="api:x" message_id="${id}" api="true">\n[🌐 来自 Web 端用户「owner」]\n\n${body}\n</channel>`;

describe("inboundOf：开新一轮的记录", () => {
  test("channel 消息（isMeta + origin channel）算，带 message_id", () => {
    const i = inboundOf(user(channel("帮我看下 T83"), { isMeta: true, origin: { kind: "channel" } }));
    expect(i?.kind).toBe("channel");
    expect(i?.messageId).toBe("m1");
  });
  test("人敲的字：有 origin human、老格式没有 origin 都算", () => {
    expect(inboundOf(user("hi", { origin: { kind: "human" } }))?.kind).toBe("human");
    expect(inboundOf(user([{ type: "text", text: "老格式" }]))?.kind).toBe("human");
  });
  test("斜杠命令算 command，它的输出不算", () => {
    expect(inboundOf(user("<command-name>/compact</command-name>\n<command-args>保留 T83</command-args>"))?.kind).toBe("command");
    expect(inboundOf(user("<local-command-stdout>done</local-command-stdout>"))).toBeNull();
  });
  test("工具结果、打断标记、isMeta 附加、compact 摘要、自动续跑都不算", () => {
    expect(inboundOf(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]))).toBeNull();
    expect(inboundOf(user([{ type: "text", text: "[Request interrupted by user for tool use]" }]))).toBeNull();
    expect(inboundOf(user("[Image: original 800x600]", { isMeta: true }))).toBeNull();
    expect(inboundOf(user("This session is being continued…", { isCompactSummary: true }))).toBeNull();
    expect(inboundOf(user("You can continue", { isMeta: true, origin: { kind: "auto-continuation" } }))).toBeNull();
  });
  test("定时任务（isMeta + scheduledTaskId）、空闲时的后台通知、peer 算", () => {
    expect(inboundOf(user("[PM 提醒] 看一眼", { isMeta: true, scheduledTaskId: "db95" }))?.kind).toBe("scheduled");
    expect(inboundOf(user("<task-notification><summary>done</summary></task-notification>", { origin: { kind: "task-notification" } }))?.kind).toBe("notification");
    expect(inboundOf(user("hello", { isMeta: true, origin: { kind: "peer" } }))?.kind).toBe("peer");
  });
  test("忙时被队列吸收的 channel 消息算；忙时插进来的后台通知不算", () => {
    const q = (mode: string, prompt: string) => ({ type: "attachment", uuid: "a1", timestamp: "2026-09-30T01:00:00Z", attachment: { type: "queued_command", commandMode: mode, prompt } });
    expect(inboundOf(q("prompt", channel("插一句", "m2")))).toMatchObject({ kind: "channel", messageId: "m2" });
    expect(inboundOf(q("task-notification", "<task-notification>x</task-notification>"))).toBeNull();
  });
});

describe("triggerSummary：渲染后的正文、脱敏、80 字", () => {
  test("channel 剥掉注入头", () => {
    expect(triggerSummary({ kind: "channel", raw: channel("帮我看下 T83") })).toBe("帮我看下 T83");
  });
  test("命令还原成 /x 参数，通知取 summary", () => {
    expect(triggerSummary({ kind: "command", raw: "<command-name>/model</command-name><command-args>haiku</command-args>" })).toBe("/model haiku");
    expect(triggerSummary({ kind: "notification", raw: "<task-notification><summary>构建完成</summary></task-notification>" })).toBe("构建完成");
  });
  test("密钥 / token 不落库", () => {
    const secrets = [
      "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx", "ghp_abcdefghijklmnopqrstuvwxyz0123", "xoxb-1234567890-abcdefghij",
      "a".repeat(8) + "0123456789abcdef0123456789abcdef", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    ];
    for (const s of secrets) expect(triggerSummary({ kind: "human", raw: `用这个 ${s} 试试` })).not.toContain(s.slice(4, 16));
    expect(redactSecrets("BRIDGE_CONTROL_TOKEN=abc123xyz789 下一步")).toBe("BRIDGE_CONTROL_TOKEN=[redacted] 下一步");
    expect(redactSecrets('{"password": "hunter22"}')).toBe('{"password": "[redacted]"}');
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop123")).toContain("Bearer [redacted]");
  });
  test("先脱敏再截断：密钥跨在第 80 字上也不留半截", () => {
    const s = `${"字".repeat(70)} sk-ant-api03-${"Z".repeat(40)}`;
    const out = triggerSummary({ kind: "human", raw: s });
    expect(out).not.toContain("ZZZZ");
    expect(Array.from(out).length).toBeLessThanOrEqual(81);
  });
  test("长文压成一行截到 80 字", () => {
    const out = triggerSummary({ kind: "human", raw: "第一行\n\n" + "长".repeat(200) });
    expect(out.startsWith("第一行 长")).toBe(true);
    expect(Array.from(out)).toHaveLength(81);
  });
});

describe("callOf", () => {
  const rec = (content: unknown[], extra: Record<string, unknown> = {}) => ({
    type: "assistant", uuid: "x1", timestamp: "2026-09-30T01:00:00Z", requestId: "req_1",
    message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 11 }, content },
    ...extra,
  });
  test("去重键 = message.id + requestId，四项和工具块都取到", () => {
    const c = callOf(rec([{ type: "tool_use", id: "toolu_1", name: "Bash" }]));
    expect(c).toMatchObject({ key: "msg_1:req_1", input: 3, cacheCreation: 5, cacheRead: 7, output: 11, tools: [{ id: "toolu_1", name: "Bash" }] });
  });
  test("没有 message.id 的老记录退回条目 uuid", () => {
    const r = rec([]);
    delete (r.message as any).id;
    expect(callOf(r)?.key).toBe("uuid:x1");
  });
  test("没有 usage / 时间戳坏了不算调用", () => {
    expect(callOf({ ...rec([]), message: { id: "m", content: [] } })).toBeNull();
    expect(callOf(rec([], { timestamp: "坏" }))).toBeNull();
  });
});
