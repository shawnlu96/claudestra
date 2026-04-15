/**
 * Claude Code 启动命令构造
 *
 * 统一 manager/launcher/cron 三处的 Claude Code 启动参数：
 * - MCP server 名（由 env MCP_NAME 控制，默认 claudestra）
 * - 危险操作黑名单（rm -rf、git push --force 等）
 * - dev channel 加载 + skip-permissions
 */

const MCP_NAME = process.env.MCP_NAME || "claudestra";

// 危险操作黑名单 — 无论是 master 还是 worker 都禁止
const DISALLOWED_TOOLS = [
  "Bash(rm -rf:*)",
  "Bash(rm -r:*)",
  "Bash(rmdir:*)",
  "Bash(git push --force:*)",
  "Bash(git reset --hard:*)",
  "Bash(git clean -f:*)",
  "Bash(chmod 777:*)",
  "Bash(:(){ :|:&};:)", // fork bomb
].join(" ");

const BASE_FLAGS = [
  "--dangerously-load-development-channels",
  `server:${MCP_NAME}`,
  "--dangerously-skip-permissions",
  "--disallowedTools",
  `"${DISALLOWED_TOOLS}"`,
].join(" ");

export interface LaunchOptions {
  channelId: string;
  bridgeUrl?: string;
  /** 可选 session id（--session-id <uuid>） */
  sessionId?: string;
  /** resume 模式：传入要 resume 的 session id */
  resumeId?: string;
  /** resume 时的显示名 */
  displayName?: string;
}

/** POSIX 单引号 shell 转义 */
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_.\/:@-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 构造 Claude Code 启动命令行字符串（给 tmux send-keys 使用）。
 * 返回完整的 shell 命令，包含前导环境变量导出。
 */
export function buildClaudeCommand(opts: LaunchOptions): string {
  const bridgeUrl = opts.bridgeUrl || process.env.BRIDGE_URL || "ws://localhost:3847";
  const prefix = `DISCORD_CHANNEL_ID=${shellEscape(opts.channelId)} BRIDGE_URL=${shellEscape(bridgeUrl)} MCP_NAME=${shellEscape(MCP_NAME)}`;

  const parts: string[] = ["claude"];
  if (opts.resumeId) {
    parts.push("--resume", shellEscape(opts.resumeId));
    if (opts.displayName) parts.push("--name", shellEscape(opts.displayName));
  } else if (opts.sessionId) {
    parts.push("--session-id", shellEscape(opts.sessionId));
  }
  parts.push(BASE_FLAGS);

  return `${prefix} ${parts.join(" ")}`;
}

export { MCP_NAME, DISALLOWED_TOOLS };
