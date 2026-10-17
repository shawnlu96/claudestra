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

/**
 * 只有 ACP 版 Codex 有：不是 Codex 自己的命令，是 Claudestra 编排的两步（bridge/codex-save.ts：先跑一轮把交接存盘，再压缩 / 换会话）。
 * slash 直通在 api-slash.ts 先截下来交给编排，不会原样发给 Codex。tmux 版没有可等的回合结局，不列。
 */
const CODEX_ACP_SAVE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "save-compact", description: "先跑一轮模型把交接存盘，存好再压缩上下文（Claudestra）" },
  { name: "save-clear", description: "先跑一轮模型把交接存盘，再换新会话并带上交接（Claudestra，仅 owner）" },
];

/**
 * OpenCode（只走 ACP）认的斜杠命令：它 available_commands_update 报的 init / review，加上它认但不报的 /compact
 * （docs/runtimes/opencode-acp.md §6）。不在表里的 "/xxx" 发给它会被整条吞掉（不进会话、不回话，OCR-4 第 1 轮 P1-3），
 * 所以 api-slash.ts 把表外的当普通消息投递；/clear 由宿主换会话，不进表。
 */
const OPENCODE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "compact", description: "summarize conversation to prevent hitting the context limit" },
  { name: "init", description: "create or update AGENTS.md for this project" },
  { name: "review", description: "review changes" },
];

/**
 * ACP 版 Pi 只列适配器真能执行的：pi 的 rpc prompt 照常跑扩展 / 包的命令，内置命令只有 /compact 被适配器换成 rpc compact
 * （lib/acp/pi-adapter/map.ts compactCommand），其余内置命令是 TUI 面板，会被当普通文字发给模型。
 * 快照是 tmux 版扩展写的（迁过来的 agent 还留着旧的），`claudestra-*` 是那个扩展自己的命令，acp 下没加载。
 */
function piAcpCommandsFor(agent: string): PiCommandInfo[] {
  return piCommandsFor(agent).filter((c) => c.scope === "pi" ? !c.name.startsWith("claudestra-") : c.name === "compact");
}

/** 这个运行时自己的命令表；Claude Code（或没写 runtime）返回 null = 走 CC 的注册表。acp = 这个 agent 走 ACP 宿主 */
export function runtimeCommandsFor(runtime: string | undefined, agent: string, acp = false): PiCommandInfo[] | null {
  if (runtime === "pi") return acp ? piAcpCommandsFor(agent) : piCommandsFor(agent);
  // scope 沿用 CC 的约定：「builtin」= 纯 TUI 命令、没有回合（api-routes 据此不亮思考中）
  if (runtime === "codex") {
    const own = CODEX_BUILTIN_PASSTHROUGH.map((b) => ({ name: b.name, invokeName: b.name, description: b.description, scope: b.turn ? "codex-turn" : "builtin" }));
    return acp ? [...own, ...CODEX_ACP_SAVE_COMMANDS.map((c) => ({ ...c, invokeName: c.name, scope: "codex-turn" }))] : own;
  }
  if (runtime === "opencode") return OPENCODE_COMMANDS.map((c) => ({ ...c, invokeName: c.name, scope: "opencode" }));
  return null;
}
