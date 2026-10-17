/**
 * channel-server 这一侧的调用方身份（T85）：register 帧带什么、只读探针工具 whoami 怎么调。
 * 身份由 bridge 按连接判（bridge/caller-identity.ts），这里只交出凭据、不自报 agent / 会话。tests/whoami-tool.test.ts。
 */
import { isReadOnlyMode, PERMISSION_MODE_ENV, READ_ONLY_MODE, registryPermissionMode } from "./codex-readonly.js";

type BridgeRequest = (msg: any, timeoutMs?: number) => Promise<any>;

/**
 * Codex ACP 的适配器环境里才有、Codex 按 env_vars 白名单起 MCP 子进程时不会带过去的变量（lib/acp/adapter-proc.ts 设的）。
 * channel-server 的环境里有它们 = 自己是 Codex 的 shell 命令起的，不是 Codex 起的 MCP 服务——回环代理据此把这条连接降级。
 */
const ADAPTER_ONLY_ENV = ["APP_SERVER_LOGS", "INITIAL_AGENT_MODE", "CODEX_CONFIG"] as const;

export function callerRegisterFields(cred: string | undefined, env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (cred) out.callerCred = cred;
  if (env.CLAUDESTRA_RUNTIME === "codex" && ADAPTER_ONLY_ENV.some((k) => env[k] !== undefined)) out.outsideMcpLauncher = true;
  return out;
}

export const WHOAMI_TOOL = {
  name: "whoami",
  description:
    "Read-only probe: returns the caller identity the bridge derived for this MCP connection — {agent, sessionId, family, verified} — " +
    "plus this agent's permission mode (permissionMode; readOnly=true means the sandbox blocks file writes and write commands). " +
    "verified=true only when this session was launched by Claudestra with a fresh launch credential; tools that assign or collect work refuse unverified callers.",
  inputSchema: { type: "object" as const, properties: {} },
};

/**
 * 当前档位：registry 记的（按 bridge 认出的 agent 名，没有就用环境里的自称）与启动时带进来的 CLAUDESTRA_PERMISSION_MODE
 * 取并集，任一边是只读就报只读——这里只是告知，真正拦写入的是 Codex 沙箱。
 */
export function permissionView(agent: string | undefined, env: Record<string, string | undefined>, lookup = registryPermissionMode): { permissionMode: string; readOnly: boolean } {
  const reg = agent ? lookup(agent) : undefined;
  const readOnly = isReadOnlyMode(reg) || isReadOnlyMode(env[PERMISSION_MODE_ENV]);
  return { permissionMode: readOnly ? READ_ONLY_MODE : reg || "bypassPermissions", readOnly };
}

export async function whoamiTool(bridgeRequest: BridgeRequest, env: Record<string, string | undefined> = process.env, lookup = registryPermissionMode) {
  const r = await bridgeRequest({ type: "whoami" }, 15_000);
  const agent = typeof r?.agent === "string" && r.agent ? r.agent : env.CLAUDESTRA_AGENT;
  const out = { ...(r ?? {}), ...permissionView(agent, env, lookup) };
  return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
}
export { takeCallerCred } from "./caller-cred.js";
