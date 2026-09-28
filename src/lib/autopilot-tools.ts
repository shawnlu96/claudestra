/**
 * Autopilot 判「这一轮有没有实质进展」用的工具分类（tests/autopilot-tools.test.ts）。只影响推进节奏（会不会进待命），不是权限闸。
 * 只读的不算进展：等 CI / 等 peer / 等人时 agent 每轮 Read 一下台账、跑一句 git status，都不该让它每 45 秒被推一次。
 * shell 命令的判定在 lib/shell-readonly.ts。名字按 Claude Code 的形状；Codex（exec_command / shell / apply_patch）、Pi（bash / edit / write）的裸名一并认。
 */
import { isReadOnlyBash } from "./shell-readonly.js";

/** 不改东西的工具 */
const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch", "TodoWrite", "TaskList", "TaskGet", "TaskOutput", "NotebookRead",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "read", "grep", "find", "ls",
]);
/** Claudestra 的通信 / 查询工具：MCP 名（mcp__<server>__x，server 名里可以有下划线）或 Pi 裸名。不算「调了工具」 */
const COMMS = "reply|react|edit_message|fetch_messages|download_attachment|check_inbox|project_info|list_shared_channels|send_to_agent|forward_to_agent";
const COMMS_TOOLS = new RegExp(`^(?:mcp__.+__)?(?:${COMMS})$`);
const READ_ONLY_MCP = /^mcp__.+__(ask_codex|memory_search|memory_list|memory_read)$/;
const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell"]);
/** 只读的子 agent 类型：只有探索 / 规划（PM 09-28 拍板）；其余子 agent（含带 Bash 的 claude-code-guide）当作在干活 */
const READ_ONLY_AGENTS = /"subagent_type"\s*:\s*"(Explore|Plan)"/;
/** jsonl-watcher 截断过长 detail 时加的尾巴：看不全的命令按写算（heredoc / 长命令的后半段可能正是写操作） */
const TRUNCATED = /\n… \(已截断，完整 \d+ 字符\)$/;

/** 通信工具不算「调了工具」：没事可做时 agent 也会 reply 一句「没有要推进的」 */
export function countsAsTool(name: string): boolean {
  return !COMMS_TOOLS.test(name);
}

/**
 * tool_start 事件的 detail 里取命令：Bash 是「描述\n───\n命令」（jsonl-watcher formatToolDetail）；
 * Codex / Pi 的 shell 工具是参数 JSON（cmd / command，数组就用空格拼）。
 */
export function bashCommandOf(detail: unknown): string {
  const s = typeof detail === "string" ? detail : "";
  if (s.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(s) as { cmd?: unknown; command?: unknown };
      const c = j.cmd ?? j.command;
      if (Array.isArray(c)) return c.map(String).join(" ");
      if (typeof c === "string") return c;
    } catch {
      // 不是完整 JSON（detail 被截断）：当普通文本往下走，认不出就按写算
    }
  }
  const i = s.lastIndexOf("\n───\n");
  return i >= 0 ? s.slice(i + 5) : s;
}

/** 可能改了东西的工具调用：只读工具、通信工具、只读 MCP 查询、只读 shell、探索类子 agent 以外都算 */
export function isMutatingTool(name: string, detail?: unknown): boolean {
  if (!countsAsTool(name) || READ_ONLY_TOOLS.has(name) || READ_ONLY_MCP.test(name)) return false;
  if (typeof detail === "string" && TRUNCATED.test(detail)) return true;
  if (SHELL_TOOLS.has(name)) return !isReadOnlyBash(bashCommandOf(detail));
  if (name === "Agent" || name === "Task") return !READ_ONLY_AGENTS.test(typeof detail === "string" ? detail : "");
  return true;
}
