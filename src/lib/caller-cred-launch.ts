/**
 * 启动命令里交付 T85 启动凭据的那一截（docs/architecture/caller-identity.md）。凭据只在一次性文件里，命令只带路径：
 * CC：--mcp-config 里只有 claudestra 这一项，路径在该项的 env 里——CC 起 MCP 服务时把它并进该服务的环境，
 * CC 自己和它的 Bash 子进程都没有（T85 实测：同名 --mcp-config 覆盖用户级注册，env 与父进程环境合并）。
 * ACP：路径作为环境变量只给 acp-host 这一条命令，宿主读走、删文件后才起适配器（src/acp-host.ts）。tests/caller-cred.test.ts。
 */
import { resolveBunPath } from "./bun-path.js";
import { CALLER_CRED_FILE_ENV, issueCallerCred, writeOneShot } from "./caller-cred.js";
import { SRC_DIR } from "./repo-root.js";
import { isSandbox } from "./sandbox.js";
import { channelServerEntry } from "./sandbox-env.js";
import type { LaunchSpec, ManagedRuntimeAdapter } from "./runtimes/types.js";

/** CC 的 --mcp-config：channel-server 那一项的 env 只多一个凭据文件路径（凭据本身不在 argv 里） */
function callerCredMcpConfig(mcpName: string, file: string): string {
  const entry = channelServerEntry(resolveBunPath(), SRC_DIR, isSandbox(), { [CALLER_CRED_FILE_ENV]: file });
  return JSON.stringify({ mcpServers: { [mcpName]: entry } });
}

export function ccCallerCredArgs(file: string | undefined, mcpName: string): string[] {
  return file ? ["--mcp-config", callerCredMcpConfig(mcpName, file)] : [];
}

/** ACP 宿主命令的环境变量前缀一项（前导空格已带）；没有文件 = 空串 */
export function acpCallerCredAssignment(file: string | undefined, esc: (s: string) => string): string {
  return file ? ` ${CALLER_CRED_FILE_ENV}=${esc(file)}` : "";
}

/**
 * 签发并写好一次性文件，返回路径（交给 LaunchSpec.callerCredFile）。kind 缺省 = 这个运行时不签（Pi / Codex tmux 版）。
 * 签发失败不挡启动：会话照样起来，只是身份 verified=false（派单类工具会拒它，reply 等照常）。
 */
export async function issueLaunchCred(
  rec: { agent: string; family: string; sessionId?: string },
  kind: "mcp-config" | "env" | undefined,
): Promise<string | undefined> {
  if (!kind) return undefined;
  try {
    return writeOneShot(await issueCallerCred(rec));
  } catch (e) {
    console.error(`⚠ ${rec.agent} 的启动凭据没签成（本次以 verified=false 启动）：${(e as Error).message}`);
    return undefined;
  }
}

/** manager 的 launchInWindow 用：家族取适配器落 registry 的 runtime（CC 不落 = claude-code）；fork 的新会话 id 启动后才知道，不记 */
export function issueCallerCredFor(agent: string, adapter: Pick<ManagedRuntimeAdapter, "callerCred" | "registryFields">, spec: LaunchSpec): Promise<string | undefined> {
  const family = (adapter.registryFields(spec) as { runtime?: string }).runtime ?? "claude-code";
  return issueLaunchCred({ agent, family, ...(spec.mode === "fork" ? {} : { sessionId: spec.sessionId }) }, adapter.callerCred);
}

export { discardOneShot, discardOneShotAfterReady } from "./caller-cred.js";
