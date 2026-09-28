/**
 * Autopilot 判「这一轮有没有实质进展」用的工具分类（tests/autopilot-tools.test.ts）。
 * 只读的不算进展：等 CI / 等 peer / 等人时 agent 每轮 Read 一下台账、跑一句 git status，都不该让它每 45 秒被推一次。
 * 名字按 Claude Code 的形状（Codex 记录先翻成这个形状）；Pi 的自定义工具是裸名，一并认。
 */

/** 不改东西的工具 */
const READ_ONLY_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "ToolSearch", "TodoWrite", "TaskList", "TaskGet", "TaskOutput", "NotebookRead",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "read", "grep", "find", "ls",
]);
/** Claudestra 的通信 / 查询工具：MCP 名（mcp__<server>__x）或 Pi 裸名。不算「调了工具」，也不算写操作 */
const COMMS = "reply|react|edit_message|fetch_messages|download_attachment|check_inbox|project_info|list_shared_channels|send_to_agent|forward_to_agent";
const COMMS_TOOLS = new RegExp(`^(?:mcp__[^_]+__)?(?:${COMMS})$`);

/** 通信工具不算「调了工具」：没事可做时 agent 也会 reply 一句「没有要推进的」 */
export function countsAsTool(name: string): boolean {
  return !COMMS_TOOLS.test(name);
}

/**
 * 只读的 shell 命令：每一段（按 && || ; | 切）都以白名单命令开头，且没有写文件的重定向。
 * 分不清的一律算写——宁可多推一轮，也不能把真在干活的一轮当成没事做。
 */
const READ_ONLY_CMDS = [
  /^git\s+(status|log|diff|show|branch|fetch|remote|rev-parse|ls-files|blame|describe)\b/,
  /^gh\s+(pr|run|issue|release)\s+(checks|view|list|status|diff|watch)\b/, /^gh\s+api\s+(?!(?:.*\s)?(-X|--method|-f|-F|--field|--raw-field|--input)\b)/,
  /^(ls|cat|head|tail|wc|grep|rg|pwd|date|echo|printf|which|stat|du|df|ps|jq|sort|uniq|cut|tr|file|basename|dirname|uptime|whoami|true|test|\[)(?=\s|$)/,
  /^find\b(?!(?:.*\s)?-(delete|exec|execdir|ok)\b)/, /^sleep\s+\d/, /^curl\s+(?!(?:.*\s)?-(X|d|F|T|-data|-upload-file)\b)/,
  /^(bun\s+test|npm\s+test|bun\s+run\s+(check|typecheck|test|guard))\b/, /^tmux\s+(capture-pane|list-\w+|display)\b/,
];
const WRITE_REDIRECT = />(?!\s*\/dev\/null|&)/;

export function isReadOnlyBash(command: string): boolean {
  const cmd = command.replace(/\d?>\s*\/dev\/null|2>&1/g, "").trim();
  if (!cmd || WRITE_REDIRECT.test(cmd) || /\$\(|`/.test(cmd)) return false;
  return cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim().replace(/^(cd\s+\S+|[A-Z_]+=\S*)\s*/, "").trim()).every((seg) => !seg || READ_ONLY_CMDS.some((re) => re.test(seg)));
}

/** tool_start 事件里 Bash 的 detail 是「描述\n───\n命令」（jsonl-watcher formatToolDetail），取命令那段 */
export function bashCommandOf(detail: unknown): string {
  const s = typeof detail === "string" ? detail : "";
  const i = s.lastIndexOf("\n───\n");
  return i >= 0 ? s.slice(i + 5) : s;
}

/** 可能改了东西的工具调用：只读工具、通信工具、只读 shell 以外都算 */
export function isMutatingTool(name: string, detail?: unknown): boolean {
  if (!countsAsTool(name) || READ_ONLY_TOOLS.has(name)) return false;
  if (name === "Bash" || name === "bash") return !isReadOnlyBash(bashCommandOf(detail));
  return true;
}
