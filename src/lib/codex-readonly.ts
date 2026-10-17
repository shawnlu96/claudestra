/**
 * Codex agent 的系统强制只读档（permissionMode = "readOnly"）：档位判定、create / resume 的校验、列表标记。
 *
 * 只读靠 Codex 自己的沙箱落实，不靠指令：
 * - tmux：`--sandbox read-only --ask-for-approval never`（exec 引导没有 -a，审批走 `-c approval_policy="never"`），
 *   绝不和 `--dangerously-bypass-approvals-and-sandbox` 同时出现（codex-launch.ts codexPermissionFlags）。
 * - ACP：只用自研适配器的 ACP_READONLY_PRESET（readOnly 沙箱 + approval never，每次 turn/start 都带）；上游 codex-acp
 *   遇到不认识的预设会静默退回可写的 agent 档，所以只读 agent 不许落到上游（acp/adapter-proc.ts acpAgentCommand）。
 * 落实不了就拒起，不降级、没有恢复键。只读沙箱只拦写入和网络，不拦读取：docs/runtimes/codex-readonly.md。
 * tests/codex-readonly.test.ts。
 */
import { REGISTRY_PATH } from "./registry.js";
import { readJsonStateSync } from "./state-file.js";

export const READ_ONLY_MODE = "readOnly";
/** 自研适配器里的只读预设名（acp/codex-adapter/session-config.ts MODES） */
export const ACP_READONLY_PRESET = "read-only-never";
/** 宿主命令 / 适配器 / channel-server 之间传档位的环境变量（codex-acp.ts 写，adapter-proc.ts 与 whoami 读） */
export const PERMISSION_MODE_ENV = "CLAUDESTRA_PERMISSION_MODE";
/** `manager list` 行上的标记文字 */
export const READ_ONLY_LABEL = "只读";

export const TUI_READONLY_FLAGS = ["--sandbox", "read-only", "--ask-for-approval", "never"] as const;
export const EXEC_READONLY_FLAGS = ["--sandbox", "read-only", "-c", 'approval_policy="never"'] as const;

/**
 * 只读档下 Codex 把没标 readOnlyHint 的 MCP 工具都当成要审批，approval never 等于直接拒——reply 就发不出去。
 * 只给 claudestra 自己这一个 server（启动时注册 channel-server 用的 MCP_NAME）的这几个工具逐个放行审批，不动沙箱；
 * 其余工具（ask_codex、派单 / 台账 / 审查、记忆写入、forward_to_agent…）不放行，never 下即拒。PM 定的清单，改它 = 放宽只读档。
 * 这些工具有对外副作用（发消息，reply 的附件能带出 agent 读得到的文件）：docs/runtimes/codex-readonly.md。
 */
export const READ_ONLY_MCP_TOOLS = ["reply", "send_to_agent", "check_inbox", "fetch_messages", "whoami"] as const;

/** 放行这几个工具审批的 config 片段：{ tools: { <工具>: { approval_mode: "approve" } } }，ACP 深合并进 mcp_servers.<名> */
export function readOnlyMcpToolsConfig(): { tools: Record<string, { approval_mode: "approve" }> } {
  return { tools: Object.fromEntries(READ_ONLY_MCP_TOOLS.map((t) => [t, { approval_mode: "approve" as const }])) };
}

export function isReadOnlyMode(mode: string | null | undefined): boolean {
  return (mode ?? "").trim() === READ_ONLY_MODE;
}

/** create / resume 前：readOnly 只给 Codex。返回 null = 放行；字符串 = 报错原因（调用方在建频道 / 写 registry 之前退出） */
export function readOnlyRuntimeError(mode: string | null | undefined, runtimeId: string): string | null {
  if (!isReadOnlyMode(mode) || runtimeId === "codex") return null;
  return `权限档位 readOnly 只支持 Codex agent（--runtime codex），${runtimeId} 不能用：它的只读靠 Codex 沙箱落实，其它运行时没有对应的强制手段`;
}

/** cmdCreate / cmdResume 的档位白名单：Claude Code 的五档之外，Codex 多认一个 readOnly */
export function isAllowedMode(mode: string, runtimeId: string, known: (m: string) => boolean): boolean {
  return known(mode) || (isReadOnlyMode(mode) && runtimeId === "codex");
}

/** 只读 agent 被显式换档时的报错 */
export const READ_ONLY_SWITCH_ERROR = "只读 agent 不能换档，要换就删了重建";

/**
 * resume 的档位。同名旧条目是只读：没给 --mode 就沿用只读（定时唤醒、网页收编、额度恢复都不带 --mode；不沿用的话 resume
 * 会把 registry 覆盖成 bypassPermissions，下次 restart 就是 full access）；显式给了别的档位就拒。旧条目不是只读：原样返回 flag。
 */
export function resumePermissionMode(flag: string | undefined, prior: { permissionMode?: string } | undefined): { mode: string | undefined } | { error: string } {
  if (!isReadOnlyMode(prior?.permissionMode)) return { mode: flag };
  if (!flag || !flag.trim() || isReadOnlyMode(flag)) return { mode: READ_ONLY_MODE };
  return { error: `${READ_ONLY_SWITCH_ERROR}（registry 里是 readOnly，--mode 给的是 ${flag.trim()}）` };
}

/** `manager mode <agent> <档位>`：旧条目是只读、新档位不是只读就拒（同 resume 的换档规则）；返回 null = 放行 */
export function modeSwitchError(prior: { permissionMode?: string } | undefined, next: string): string | null {
  return isReadOnlyMode(prior?.permissionMode) && !isReadOnlyMode(next) ? `${READ_ONLY_SWITCH_ERROR}（registry 里是 readOnly，要改成 ${next.trim()}）` : null;
}

type RegistryLookup = (agent: string) => string | undefined;
type RawAgents = Record<string, { permissionMode?: unknown; runtime?: unknown } | null>;

/**
 * registry 的原始条目。permissionMode 不在 registry.ts 的规范化白名单里，所以这里直接读 JSON；
 * 缺文件 / 坏文件 = 空（调用方只按 spec 判，spec 本来就是 registry 当场读出来的）。
 */
function rawAgents(path: string): RawAgents {
  const r = readJsonStateSync(path);
  if (r.status !== "ok") return {};
  const agents = (r.data as { agents?: unknown } | null)?.agents;
  return agents && typeof agents === "object" ? (agents as RawAgents) : {};
}

/** registry 里所有只读 Codex agent 的键（GET agents 一次读完，不按行反复读文件） */
export function readOnlyCodexAgents(path = REGISTRY_PATH): Set<string> {
  const out = new Set<string>();
  for (const [name, a] of Object.entries(rawAgents(path))) {
    if (a?.runtime === "codex" && typeof a.permissionMode === "string" && isReadOnlyMode(a.permissionMode)) out.add(name);
  }
  return out;
}

/** registry 里某个 agent 记的 permissionMode（键带不带 agent- 前缀都认）；读不到 = undefined */
export function registryPermissionMode(agent: string, path = REGISTRY_PATH): string | undefined {
  const agents = rawAgents(path);
  const bare = agent.replace(/^agent-/, "");
  for (const k of [`agent-${bare}`, bare]) {
    const v = agents[k]?.permissionMode;
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Codex 启动时真正用的档位：spec 与 registry 取并集，任一边是 readOnly 就只读。
 * 起进程的路径有好几条（restart / resume / ACP 迁移 / 生命周期重建 / fork 自愈），哪条拼 LaunchSpec 时漏了 permissionMode，
 * 这里按 agent 名再查一次 registry 兜住；只会收紧，不会放宽。
 */
export function effectiveCodexMode(
  spec: { permissionMode?: string; agentName?: string; settingsName?: string; displayName?: string },
  lookup: RegistryLookup = registryPermissionMode,
): string | undefined {
  if (isReadOnlyMode(spec.permissionMode)) return READ_ONLY_MODE;
  const names = [spec.agentName, spec.settingsName, spec.displayName].filter((n): n is string => !!n && !!n.trim());
  for (const n of names) if (isReadOnlyMode(lookup(n))) return READ_ONLY_MODE;
  return spec.permissionMode;
}

/** `manager list` 的行：registry 里是只读 Codex 就标上（readOnly + 文字标记） */
export function markReadOnlyRows(rows: Record<string, unknown>[], agents: Record<string, { permissionMode?: string; runtime?: string }>): void {
  for (const row of rows) {
    const info = agents[String(row.name)];
    if (info && info.runtime === "codex" && isReadOnlyMode(info.permissionMode)) Object.assign(row, { readOnly: true, mode: READ_ONLY_LABEL });
  }
}
