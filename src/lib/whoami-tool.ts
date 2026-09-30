/**
 * channel-server 这一侧的调用方身份（T85）：register 帧带什么、只读探针工具 whoami 怎么调。
 * 身份由 bridge 按连接判（bridge/caller-identity.ts），这里只交出凭据、不自报 agent / 会话。tests/whoami-tool.test.ts。
 */
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
    "Read-only probe: returns the caller identity the bridge derived for this MCP connection — {agent, sessionId, family, verified}. " +
    "verified=true only when this session was launched by Claudestra with a fresh launch credential; tools that assign or collect work refuse unverified callers.",
  inputSchema: { type: "object" as const, properties: {} },
};

export async function whoamiTool(bridgeRequest: BridgeRequest) {
  const r = await bridgeRequest({ type: "whoami" }, 15_000);
  return { content: [{ type: "text" as const, text: JSON.stringify(r ?? {}, null, 2) }] };
}
export { takeCallerCred } from "./caller-cred.js";
