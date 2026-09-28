/**
 * claude-settings（会话级切模型/effort）只接 Claude Code agent：它往 TUI 注入 CC 的
 * `/model`、`/effort`，并用 CC 的空闲判据判忙。Codex 窗口过不了那个判据 ⇒ 恒 409
 * 「回合进行中」误导人；万一判成空闲，CC 命令就敲进了 Codex TUI。Pi 走 pi-settings。
 * 见 tests/claude-settings-runtime.test.ts。
 */
import { DEFAULT_RUNTIME, sourceFor } from "./runtimes/index.js";
import { isKnownRuntimeEffort, KNOWN_EFFORT_LEVELS, RUNTIME_ONLY_EFFORT_LEVELS } from "./claude-launch.js";
import type { RegistryAgent } from "./registry.js";

/**
 * 非 Claude Code agent → 给人看的拒绝原因；CC（含缺失/未知 runtime）或不在 registry
 * （master 恒为 CC）→ null。名字带不带 `agent-` 前缀都认，与 findApiAgent 同款匹配。
 */
export function nonClaudeRuntimeError(agentParam: string, regs: readonly RegistryAgent[]): string | null {
  const reg = regs.find((a) => a.name === agentParam || a.name === `agent-${agentParam}` || `agent-${a.name}` === agentParam);
  const rt = sourceFor(reg?.runtime).id;
  if (!reg || rt === DEFAULT_RUNTIME) return null;
  const hint = rt === "pi" ? "（用 /pi-settings）" : "";
  return `agent "${reg.name}" 不是 Claude Code agent（runtime=${rt}），不能切 Claude Code 的模型/effort${hint}`;
}

/**
 * 模型名会拼进注入 TUI 的那一行（CC 的 `/model <x>`、Pi 的 `/claudestra-model <x>`）和启动命令：只许 id 字符，
 * 首字符是字母或数字（挡 `-x` 被当 flag、`/x` 像命令），最长 128。控制字符（\r \n \t…）单独再拒一次——
 * 将来有人放宽字符集，换行也漏不进去，漏进去就是替 owner 多敲一行。
 */
export function isSafeModelArg(m: string): boolean {
  return !/\p{Cc}/u.test(m) && /^[A-Za-z0-9][A-Za-z0-9._\/@:-]{0,127}$/.test(m);
}

/** claude-settings 入参 → 给人看的 400 原因，合法 → null。effort 接受 runtime-only 档（ultracode 就是「this session only」语义） */
export function claudeSwitchInputError(model?: string, effort?: string): string | null {
  if (model && !isSafeModelArg(model)) return "model 含非法字符";
  if (effort && !isKnownRuntimeEffort(effort)) return `未知 effort: "${effort}"。可用: ${[...KNOWN_EFFORT_LEVELS, ...RUNTIME_ONLY_EFFORT_LEVELS].join(", ")}`;
  return null;
}
