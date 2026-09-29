import { describe, expect, test } from "bun:test";
import { CANCELLED, permissionCard, permissionResponse } from "../src/lib/acp/permissions.ts";

// 我们的 Codex 跑 agent-full-access（approval=never），适配器不会发 session/request_permission；
// 这些用例钉住收紧审批策略以后才会走到的映射（codex-acp 2.0.0 permissions/option-ids.ts、permissions/mcp.ts 的形状）。

const commandRequest = {
  sessionId: "s",
  toolCall: { toolCallId: "call-1", title: "rm -rf build", kind: "execute", status: "pending", rawInput: { command: "/bin/zsh -lc 'rm -rf build'", cwd: "/w" } },
  options: [
    { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow_for_session", name: "Allow for session", kind: "allow_always" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
    { optionId: "cancel", name: "Cancel", kind: "reject_always" },
  ],
};

const mcpRequest = {
  sessionId: "s",
  toolCall: { toolCallId: "mcp-9", kind: "execute", status: "pending", rawInput: { server: "godot-ai", tool: "scene_save", arguments: { path: "res://a.tscn" } } },
  options: [
    { optionId: "allow_once", name: "Allow", kind: "allow_once" },
    { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
    { optionId: "decline", name: "Decline", kind: "reject_once" },
  ],
  _meta: { is_mcp_tool_approval: true },
};

describe("permissionCard", () => {
  test("命令授权：选项原样列出，allow 绿、reject 红，正文是命令", () => {
    const c = permissionCard(commandRequest)!;
    expect(c.title).toBe("Codex 请求授权：rm -rf build");
    expect(c.detail).toBe("/bin/zsh -lc 'rm -rf build'");
    expect(c.mcp).toBe(false);
    expect(c.options).toEqual([
      { id: "allow_once", label: "Allow once", style: "success" },
      { id: "allow_for_session", label: "Allow for session", style: "success" },
      { id: "decline", label: "Decline", style: "danger" },
      { id: "cancel", label: "Cancel", style: "danger" },
    ]);
  });

  test("MCP 工具授权只带 toolCallId：标题从 rawInput 的 server/tool 拼，正文是参数", () => {
    const c = permissionCard(mcpRequest)!;
    expect(c.title).toBe("Codex 请求授权：MCP 工具 godot-ai/scene_save");
    expect(c.detail).toBe('{"path":"res://a.tscn"}');
    expect(c.mcp).toBe(true);
    expect(c.toolCallId).toBe("mcp-9");
  });

  test("没有选项的请求 → null（宿主直接回 cancelled）；超长正文截断", () => {
    expect(permissionCard({ toolCall: {}, options: [] })).toBeNull();
    const long = permissionCard({ ...commandRequest, toolCall: { ...commandRequest.toolCall, rawInput: { command: "x".repeat(2000) } } })!;
    expect(long.detail.length).toBe(601);
  });
});

describe("permissionResponse（fail closed）", () => {
  const card = permissionCard(commandRequest)!;
  test("点了卡上的选项 → selected + 原 optionId", () => {
    expect(permissionResponse(card, "decline")).toEqual({ outcome: { outcome: "selected", optionId: "decline" } });
  });
  test("取消 / 超时（null）/ 不认识的 id → cancelled", () => {
    expect(permissionResponse(card, null)).toEqual(CANCELLED);
    expect(permissionResponse(card, "allow_everything")).toEqual({ outcome: { outcome: "cancelled" } });
  });
});
