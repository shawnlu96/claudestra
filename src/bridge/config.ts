/**
 * 共享配置常量
 */

export const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN!;

// Web-only: 无 DISCORD_BOT_TOKEN 时以 Web-only 模式运行：不连 Discord、
// 跳过 ready 里的 Discord 专属初始化；会话地址由 local adapter 供给（local-* 合成
// id），出站对 local transport 是 no-op（前端走 /api/v1 + /events SSE）。
export const WEB_ONLY = !process.env.DISCORD_BOT_TOKEN;
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
/** 聊天附件落盘目录。曾在 TMP_DIR 下（重启即清），owner 2026-07-13 要求
 *  图片永久保存 → 迁到持久位置；web BFF 的附件端点同步读这里。 */
export const INBOX_DIR = `${process.env.HOME}/.claude-orchestrator/inbox`;
// 从 tmux-helper 引入避免两处常量漂移
export { TMUX_SOCK } from "../lib/tmux-helper.js";
import { resolveBunPath, bunBinDir } from "../lib/bun-path.js";
export const REPO_ROOT = `${import.meta.dir}/../..`;
export const MANAGER_PATH = `${REPO_ROOT}/src/manager.ts`;
export const MASTER_DIR = `${REPO_ROOT}/master`;
// 不写死 ~/.bun/bin/bun —— brew / mise / asdf 装的 bun 不在那儿，见 lib/bun-path.ts
export const BUN_PATH = resolveBunPath();
export const ENV_WITH_BUN = {
  ...process.env,
  PATH: `${bunBinDir()}:${process.env.PATH}`,
};

// JSONL Watcher 配置
export const WATCHER_CONFIG = {
  showToolUse: true,       // 显示 tool 调用（📖 Read file.ts）
  showClaudeText: true,    // 显示 Claude 说的话（非 reply 的文本）
  debounceMs: 1500,        // tool 合并等待时间（只作用于 Discord 推送；SSE 即时）
  // jsonl 轮询间隔。曾 2000ms——web 端显示比终端慢 1-2s 的主因(SSE emit 在
  // 解析当下就发,但要等下一轮 poll 才解析)。降到 500ms:空转成本只是每
  // agent 一次 fs.stat,便宜;平均延迟 1s → 0.25s(owner 2026-07-16)。
  pollMs: 500,
};
