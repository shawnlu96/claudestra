/**
 * 非 Claude Code 运行时自己的斜杠命令（网页命令面板的数据源，也是 slash 直通能注入什么的白名单——两边同源）。
 * Claude Code 走 bridge/slash-registry.ts 的注册表；Pi 走它的运行时快照；Codex 用下面这份内置命令表。
 * 以前 Codex agent 没有特判，面板里列的是 Claude Code 的技能（/save-compact 之类），注进 Codex 的 TUI 毫无意义。
 */
import { piCommandsFor, type PiCommandInfo } from "./pi-env.js";

/**
 * Codex TUI 的内置命令（对照 codex-cli 0.153 自带的命令说明）。会换会话 / 退出的（/new /resume /fork /quit /exit /logout
 * /archive /delete）不放：它们会让 bridge 跟丢这个 agent 的会话，该走网页上的重启 / 清空。
 * turn = 注入后会跑一轮模型（bridge 要亮「思考中」、等回合结束）；其余只是 TUI 面板，没有回合，亮了会永久卡住。
 */
export const CODEX_BUILTIN_PASSTHROUGH: ReadonlyArray<{ name: string; description: string; turn?: boolean }> = [
  { name: "model", description: "choose what model and reasoning effort to use" },
  { name: "permissions", description: "choose what Codex is allowed to do" },
  { name: "review", description: "review my current changes and find issues", turn: true },
  { name: "compact", description: "summarize conversation to prevent hitting the context limit", turn: true },
  { name: "status", description: "show current session configuration and token usage" },
  { name: "diff", description: "show git diff (including untracked files)" },
  { name: "mention", description: "mention a file" },
  { name: "init", description: "create an AGENTS.md file with instructions for Codex", turn: true },
  { name: "mcp", description: "list configured MCP tools" },
  { name: "goal", description: "set or view the goal for a long-running task" },
];

/** 这个运行时自己的命令表；Claude Code（或没写 runtime）返回 null = 走 CC 的注册表 */
export function runtimeCommandsFor(runtime: string | undefined, agent: string): PiCommandInfo[] | null {
  if (runtime === "pi") return piCommandsFor(agent);
  // scope 沿用 CC 的约定：「builtin」= 纯 TUI 命令、没有回合（api-routes 据此不亮思考中）
  if (runtime === "codex") return CODEX_BUILTIN_PASSTHROUGH.map((b) => ({ name: b.name, invokeName: b.name, description: b.description, scope: b.turn ? "codex-turn" : "builtin" }));
  return null;
}
