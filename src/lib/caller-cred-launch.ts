/**
 * 启动命令里交付 T85 启动凭据的那一截（docs/architecture/caller-identity.md）。
 * CC：一次性文件里是一份只含 claudestra 这一项的 MCP 配置，凭据在该项的 env 里——CC 起 MCP 服务时把它并进该服务的环境，
 * CC 自己和它的 Bash 子进程都没有（T85 实测：同名 --mcp-config 覆盖用户级注册，env 与父进程环境合并）。
 * ACP：凭据作为环境变量只给 acp-host 这一条命令，宿主起适配器前自己删掉（src/acp-host.ts）。
 * 两条都经 oneShotArg：命令行 / zsh 历史 / tmux 屏幕上只有文件路径。tests/caller-cred.test.ts。
 */
import { resolveBunPath } from "./bun-path.js";
import { CALLER_CRED_ENV, issueCallerCred, oneShotArg, writeOneShot } from "./caller-cred.js";
import { SRC_DIR } from "./repo-root.js";
import { isSandbox } from "./sandbox.js";
import { channelServerEntry } from "./sandbox-env.js";
import type { LaunchSpec, ManagedRuntimeAdapter } from "./runtimes/types.js";

/** token 省略 = 不带凭据的同一份配置（一次性文件已不在时的退路：会话照样起来，身份是 verified=false） */
export function callerCredMcpConfig(mcpName: string, token?: string): string {
  const entry = channelServerEntry(resolveBunPath(), SRC_DIR, isSandbox(), token ? { [CALLER_CRED_ENV]: token } : undefined);
  return JSON.stringify({ mcpServers: { [mcpName]: entry } });
}

export function ccCallerCredArgs(file: string | undefined, mcpName: string, esc: (s: string) => string): string[] {
  return file ? ["--mcp-config", oneShotArg(file, callerCredMcpConfig(mcpName), esc)] : [];
}

/** ACP 宿主命令的环境变量前缀一项（前导空格已带）；没有文件 = 空串 */
export function acpCallerCredAssignment(file: string | undefined, esc: (s: string) => string): string {
  return file ? ` ${CALLER_CRED_ENV}=${oneShotArg(file, "", esc)}` : "";
}

/**
 * 签发并写好一次性文件，返回路径（交给 LaunchSpec.callerCredFile）。kind 缺省 = 这个运行时不签（Pi / Codex tmux 版）。
 * 签发失败不挡启动：会话照样起来，只是身份 verified=false（派单类工具会拒它，reply 等照常）。
 */
export async function issueLaunchCred(
  rec: { agent: string; family: string; sessionId?: string },
  kind: "mcp-config" | "env" | undefined,
  mcpName = process.env.MCP_NAME || "claudestra",
): Promise<string | undefined> {
  if (!kind) return undefined;
  try {
    const token = await issueCallerCred(rec);
    return writeOneShot(kind === "mcp-config" ? callerCredMcpConfig(mcpName, token) : token);
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

export { discardOneShot } from "./caller-cred.js";
