import { readActiveAgents, type RegistryAgent } from "./registry.js";

export type CcSessionAgent = RegistryAgent & { cwd: string; sessionId: string; channelId: string };

/**
 * 会话文件在 ~/.claude/projects 下的 agent：只有 Claude Code。codex / pi 的路径推不出来，每次都落到 findJsonlBySessionId
 * 全库扫描（Bun 1.3.14 下还漏原生内存，BML-1），所以按会话文件轮询的 watcher 只看这些。见 tests/bg-activity-watchable.test.ts
 */
export function isCcSessionAgent(a: RegistryAgent): a is CcSessionAgent {
  // 不用 agentRuntime()：它把未知 runtime 也归成 claude-code，新运行时会被当成 CC 扫描、重走泄漏路径
  return Boolean(a.channelId && a.sessionId && a.cwd) && (!a.runtime || a.runtime === "claude-code");
}

export async function readCcSessionAgents(registryPath?: string): Promise<CcSessionAgent[]> {
  return (await readActiveAgents(registryPath)).filter(isCcSessionAgent);
}
