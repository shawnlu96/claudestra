/**
 * reply 在 pi 最终的工具表里活不活得下来。pi 0.99.2 的两条规则：
 * - 工具名（extensions/mcp/tools.js createMcpToolName）：`mcp__<server>__<tool>`，非 [A-Za-z0-9_] 换成 `_`；超过 64 字符就截断加
 *   哈希后缀。server 名只收 [A-Za-z0-9_-]（core/mcp-servers.js）。截断加哈希的名字我们不去算，直接拒这种 MCP_NAME；
 * - 筛选（core/agent-session.js _refreshToolRegistry）：有白名单就只留白名单里的，黑名单里的一律去掉，MCP 的 direct 工具也不豁免。
 * 能力档（manager 拼参数时）和适配器（起 pi 前对着实际参数）各查一次。tests/pi-acp-reply-tool.test.ts 对着上游原样移植的函数核对。
 */
import type { PiEnvProfile } from "../../pi-env.js";

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME = 64;
/** tmux 版 Pi 的 reply 工具名（扩展直接注册的）；ACP 下没有这个工具，能力档里写它指的就是 MCP 版 reply */
const LEGACY_REPLY = "reply";

/** server 的 reply 在 pi 里的名字；pi 不收的 server 名、要截断加哈希的长度都抛 */
export function piReplyToolName(server: string): string {
  if (!SERVER_NAME.test(server)) throw new Error(`MCP_NAME「${server}」pi 不收（只能是字母、数字、_、-）`);
  const name = `mcp__${server}__reply`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length > MAX_TOOL_NAME) {
    throw new Error(`MCP_NAME「${server}」太长：pi 会把 reply 的工具名截断加哈希，白名单里没法保证写对（最多 ${MAX_TOOL_NAME - 12} 个字符）`);
  }
  return name;
}

/** 对着 pi 实际拿到的白名单 / 黑名单：reply 会被筛掉就返回原因，活得下来返回 null */
export function replyToolProblem(server: string, tools?: readonly string[], excludeTools?: readonly string[]): string | null {
  let name: string;
  try {
    name = piReplyToolName(server);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (tools && !tools.includes(name)) return `pi 的工具白名单里没有 ${name}，reply 会被筛掉（模型就没法回复）`;
  if (excludeTools?.includes(name)) return `pi 的禁用工具里有 ${name}，reply 会被筛掉（模型就没法回复）`;
  return null;
}

/**
 * 能力档 → 保证有 reply 的能力档：写了白名单就补上 reply 的 pi 工具名（旧写法 reply 换成它）；禁用表里有 reply（任一写法）、
 * MCP_NAME 不合规就抛——在改 registry、停旧实例之前拒，而不是起一个静默没有 reply 的 agent。
 */
export function keepReplyTool(profile: PiEnvProfile | undefined, server: string): PiEnvProfile | undefined {
  const name = piReplyToolName(server);
  const banned = profile?.excludeTools?.find((t) => t === name || t === LEGACY_REPLY);
  if (banned) throw new Error(`Pi 能力档禁用了 ${banned}：ACP 下 reply 是 ${name}，禁掉模型就没法回复，先从 excludeTools 里去掉`);
  if (!profile?.tools) return profile;
  const tools = [...new Set([...profile.tools.map((t) => (t === LEGACY_REPLY ? name : t)), name])];
  return { ...profile, tools };
}
