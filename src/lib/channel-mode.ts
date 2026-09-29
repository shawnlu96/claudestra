/**
 * channel-server 以什么身份运行（可测——channel-server.ts 顶层有副作用不能 import；Codex 子线程探针可注入，默认跑一次 ps）。
 *
 * setup 用 `claude mcp add -s user` 按用户级注册 channel-server，所以用户**自己**在
 * iTerm 里开的每个 Claude Code 也会拉起它。那些会话没有 DISCORD_CHANNEL_ID（只有
 * Claudestra 启动的 agent 才注入）。以前这种情况直接 exit(1)，用户的 /mcp 里就常驻
 * 一条「claudestra ✘ failed」。
 *
 * 现在改成 inert：照常完成 MCP 握手，不声明 channel 能力、工具列表为空、不连 bridge，
 * 空闲到 stdio 关闭——用户看到的是 connected、0 个工具。
 * 与 link-policy 的不变量一致：stdio 还连着就绝不自己退出，唯一的退出理由是 onclose。
 *
 * Codex 子 agent 线程的那份 MCP 也 inert（lib/codex-thread.ts hasOlderChannelServerSibling）：频道归主线程，
 * 子 agent 没有 reply 等工具，答复由主线程转。
 */

import { hasOlderChannelServerSibling } from "./codex-thread.js";

export type ChannelServerMode = "channel" | "inert";

export function channelServerMode(env: Record<string, string | undefined>, codexSubthread: () => boolean = hasOlderChannelServerSibling): ChannelServerMode {
  if (!env.DISCORD_CHANNEL_ID) return "inert";
  return env.CLAUDESTRA_RUNTIME === "codex" && codexSubthread() ? "inert" : "channel";
}

/** inert 时打到 stderr 的一句：说清是哪种 inert */
export function inertNotice(env: Record<string, string | undefined>): string {
  return env.DISCORD_CHANNEL_ID
    ? "ℹ 同一个 Codex 进程里已有更早的 channel-server（本进程是子 agent 线程那份）：0 工具空闲，不抢主线程的频道"
    : "ℹ 没有 DISCORD_CHANNEL_ID：不是 Claudestra 启动的会话，以 0 工具空闲模式运行（不连 bridge）";
}

/** 只有真正的频道会话才声明 claude/channel——inert 会话不该让 CC 以为能收推送 */
export function mcpCapabilities(mode: ChannelServerMode): { tools: Record<string, never>; experimental?: Record<string, object> } {
  return mode === "channel"
    ? { tools: {}, experimental: { "claude/channel": {} } }
    : { tools: {} };
}

/** inert 模式下既不握手后连 bridge、也不走 30s 兜底注册 */
export function shouldConnectBridge(mode: ChannelServerMode): boolean {
  return mode === "channel";
}
