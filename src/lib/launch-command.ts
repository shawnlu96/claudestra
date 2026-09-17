/**
 * 启动命令分发：registry 里的 runtime → 对应的启动器。
 *
 * 存在的唯一理由：manager / launcher 有多处「拼一条命令塞进 tmux」的地方，每处都
 * 自己 if/else 就会漏（漏一处 = 某个入口把 Pi agent 当 Claude Code 起，症状是
 * 起不来或起成另一个 runtime，排查成本远高于这个文件的体积）。
 *
 * 新增运行时 = 加一个 builder + 在 agentRuntime() 里认一个新值，调用方零改动。
 */

import { buildClaudeCommand, type LaunchOptions } from "./claude-launch.js";
import { buildPiCommand, type PiLaunchOptions } from "./pi-launch.js";
import { agentRuntime, type AgentRuntime } from "./registry.js";

/**
 * 两个 builder 选项的并集：各自只读自己认得的字段（Claude Code 读 permissionMode /
 * disallowedRaw，Pi 读 thinking 档位），所以调用方可以无脑把 context 都传进来。
 */
export interface AgentLaunchOptions extends LaunchOptions, PiLaunchOptions {
  runtime?: AgentRuntime | string;
}

/** 按运行时选启动器。未知 runtime 一律走 Claude Code（fail-safe：老行为） */
export function buildAgentCommand(opts: AgentLaunchOptions): string {
  const { runtime, ...rest } = opts;
  return agentRuntime({ runtime }) === "pi" ? buildPiCommand(rest) : buildClaudeCommand(rest);
}
