/** Codex 的 ACP 宿主描述（runtimes/contract.ts AcpHostRuntime）：适配器按 agent 的选择开关挑自研 / 上游，channel-server 在 CODEX_CONFIG 里。 */
import { BOOTSTRAP_PROMPT } from "../codex-launch.js";
import { acpAgentCommand, adapterEnv } from "../acp/adapter-proc.js";
import { selectedCodexAdapter } from "../acp/codex-compat.js";
import type { AcpHostRuntime } from "./contract.js";

export const CODEX_ACP_HOST: AcpHostRuntime = {
  id: "codex", label: "Codex", logLabel: "codex-acp", clearBootstrap: BOOTSTRAP_PROMPT,
  // 压缩完成认 ACP 的 compaction_update（codex-acp 不发 _meta.claudestra.compacted）
  compactFrom: "compaction-update",
  // 选择开关按 agent 读（宿主环境里的 CLAUDESTRA_AGENT）：全局一处 + 单个 agent 覆盖（codex-compat-switch.ts）
  agentCommand: (env, bunBin, clean) => acpAgentCommand(env, bunBin, undefined, clean, selectedCodexAdapter(env.CLAUDESTRA_AGENT?.trim() || undefined)),
  adapterEnv,
  // channel-server 已在 CODEX_CONFIG 里；codex-acp 会丢掉和 config 同名的 mcpServers 项，传了也白传
  mcpServers: () => [],
};
