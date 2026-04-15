/**
 * 共享配置常量
 */

export const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;
export const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "3847");
export const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .filter(Boolean);
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";

// MCP server 名称。用户用 `claude mcp add <name> -- bun run channel-server.ts`
// 注册时使用的名字，必须和此处一致，否则 jsonl-watcher 无法识别 reply 工具而把
// 对话气泡当成 tool use 推送给 Discord。
export const MCP_NAME = process.env.MCP_NAME || "claudestra";
export const MCP_TOOL_PREFIX = `mcp__${MCP_NAME.replace(/-/g, "_")}__`;

export const TMP_DIR = "/tmp/claude-orchestrator";
// 从 tmux-helper 引入避免两处常量漂移
export { TMUX_SOCK } from "../lib/tmux-helper.js";
export const REPO_ROOT = `${import.meta.dir}/../..`;
export const MANAGER_PATH = `${REPO_ROOT}/src/manager.ts`;
export const MASTER_DIR = `${REPO_ROOT}/master`;
export const BUN_PATH = `${process.env.HOME}/.bun/bin/bun`;
export const ENV_WITH_BUN = {
  ...process.env,
  PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
};

// JSONL Watcher 配置
export const WATCHER_CONFIG = {
  showToolUse: true,       // 显示 tool 调用（📖 Read file.ts）
  showClaudeText: true,    // 显示 Claude 说的话（非 reply 的文本）
  debounceMs: 1500,        // tool 合并等待时间
};
