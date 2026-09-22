/**
 * claude-settings（会话级切模型/effort）只接 Claude Code agent：它往 TUI 注入 CC 的
 * `/model`、`/effort`，并用 CC 的空闲判据判忙。Codex 窗口过不了那个判据 ⇒ 恒 409
 * 「回合进行中」误导人；万一判成空闲，CC 命令就敲进了 Codex TUI。Pi 走 pi-settings。
 * 见 tests/claude-settings-runtime.test.ts。
 */
import { DEFAULT_RUNTIME, sourceFor } from "./runtimes/index.js";
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
