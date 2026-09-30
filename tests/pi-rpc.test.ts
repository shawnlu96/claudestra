import { describe, expect, test } from "bun:test";
import { actionForLine, autoAnswer, renderEvent, splitJsonl } from "../src/lib/pi-rpc.ts";

describe("actionForLine：窗口一行 → rpc 命令", () => {
  test("TUI 内置命令翻成 rpc 命令（rpc 里 /new 会被当普通文字发给模型）", () => {
    expect(actionForLine("/clear", false)).toEqual({ kind: "rpc", cmd: { type: "new_session" } });
    expect(actionForLine("/new\r", true)).toEqual({ kind: "rpc", cmd: { type: "new_session" } });
    expect(actionForLine("/quit", false)).toEqual({ kind: "quit" });
    expect(actionForLine("/compact 只留结论", false)).toEqual({ kind: "rpc", cmd: { type: "compact", customInstructions: "只留结论" } });
    expect(actionForLine("/compact", false)).toEqual({ kind: "rpc", cmd: { type: "compact" } });
  });
  test("其余一律 prompt；回合中带 steer，否则 rpc 报错", () => {
    expect(actionForLine("/claudestra-model a/b", false)).toEqual({ kind: "rpc", cmd: { type: "prompt", message: "/claudestra-model a/b" } });
    expect(actionForLine("hi", true)).toEqual({ kind: "rpc", cmd: { type: "prompt", message: "hi", streamingBehavior: "steer" } });
    expect(actionForLine("   ", false)).toEqual({ kind: "none" });
  });
});

describe("renderEvent / autoAnswer / splitJsonl", () => {
  test("整条消息结束才打，流式增量不打", () => {
    expect(renderEvent({ type: "message_update" })).toBeNull();
    expect(renderEvent({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "好" }] } })).toBe("● 好");
    expect(renderEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } })).toBe('⏺ bash({"command":"ls"})');
  });
  test("对话框回取消，fire-and-forget 不回", () => {
    expect(autoAnswer({ type: "extension_ui_request", id: "x", method: "confirm" })).toEqual({ type: "extension_ui_response", id: "x", cancelled: true });
    expect(autoAnswer({ type: "extension_ui_request", id: "y", method: "notify" })).toBeNull();
  });
  test("只按 LF 切，U+2028 留在记录里", () => {
    const { lines, rest } = splitJsonl('{"a":"x y"}\r\n{"b":1}\n{"c"');
    expect(lines).toEqual(['{"a":"x y"}', '{"b":1}']);
    expect(rest).toBe('{"c"');
  });
});
