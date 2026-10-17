/**
 * OpenCode 的 ACP 宿主描述（runtimes/contract.ts AcpHostRuntime）：直连 `opencode acp`，没有适配器进程；
 * 它和宿主契约的三处差距在 translator 里补（docs/runtimes/opencode-acp.md）。
 */
import { hostEnvBase, type AgentCommand } from "../acp/adapter-proc.js";
import { OPENCODE_BIN_ENV, opencodeBin, opencodeDirsEnv, OPENCODE_INSTALL_HINT } from "../acp/opencode-bin.js";
import { enforceOpencodeModel } from "../acp/opencode-model-check.js";
import { stdioMcpServers } from "./acp-mcp.js";
import type { AcpHostRuntime } from "./contract.js";

/** 宿主的工作目录就是会话 cwd（manager 在 agent 窗口里起它）；路径用启动命令带来的 OPENCODE_BIN（窗口不继承 manager 的 PATH） */
function opencodeAgentCommand(env: Record<string, string | undefined>, _bunBin: string, clean: boolean): AgentCommand {
  if (clean) return { error: "出借 worker 只支持 Codex，不起 OpenCode" };
  const bin = opencodeBin(env);
  return bin ? { cmd: [bin, "acp", "--cwd", process.cwd()], stub: false } : { error: OPENCODE_INSTALL_HINT };
}

/**
 * OpenCode 不收 -m：缺省模型经 OPENCODE_CONFIG_CONTENT 给（不写盘），不给就是它自己的免费缺省 big-pickle——所以模型必填（manager 早拒），
 * 接上后宿主再按 CLAUDESTRA_ACP_MODEL set_config_option 校一次。权限对齐 Codex 的 agent-full-access：全放行（含 cwd 外的
 * external_directory、doom_loop），question 拒（无人值守，问了也没人答）。后写的规则覆盖 OpenCode 的内置缺省（debug agent build 实测）
 */
export function opencodeConfigContent(model: string | undefined): string {
  const permission = { "*": "allow", external_directory: "allow", doom_loop: "allow", question: "deny" };
  return JSON.stringify({ ...(model ? { model } : {}), permission, autoupdate: false });
}

export const OPENCODE_ACP_HOST: AcpHostRuntime = {
  id: "opencode", label: "OpenCode", logLabel: "opencode", compactFrom: "command-end", agentCommand: opencodeAgentCommand,
  enforceLaunch: (s, model, timeoutMs) => enforceOpencodeModel(s, model, { timeoutMs }),
  adapterEnv: (s) => {
    const env = hostEnvBase(s);
    delete env[OPENCODE_BIN_ENV];
    return { ...env, ...opencodeDirsEnv(s.base), OPENCODE_CONFIG_CONTENT: opencodeConfigContent(s.base.CLAUDESTRA_ACP_MODEL?.trim() || undefined) };
  },
  mcpServers: stdioMcpServers("opencode"),
  translator: (mcpName) => ({ deferPendingTools: true, mcpUnderscoreServers: [mcpName] }),
};
