/**
 * bridge 认 MCP 调用方（T85）：一条已注册的连接 → CallerIdentity。纯函数，IO 在 bridge/caller-identity.ts。
 * verified 的唯一来源是注册时出示的凭据（lib/caller-cred.ts）：它得还在存储里（没被同 agent 的新凭据顶掉），
 * 而且签给的 agent 正是这个频道的主人——拿 A 的凭据注册 B 的频道不算数。自报的 agentName / sessionId 一概不信。
 * 会话与家族取 registry 当前值（CC 的 /clear、ACP 的线程轮转都会换会话 id，启动时记的那个会过时）；大总管取 MASTER_DIR 最新会话。
 * tests/caller-identity.test.ts。
 */
import type { CredRecord } from "./caller-cred.js";

export interface CallerIdentity {
  agent: string | null;
  sessionId: string | null;
  /** registry 的 runtime：claude-code / codex / pi */
  family: string | null;
  verified: boolean;
}

/** M2 / M3 的派单回收工具对未验证调用方统一回这个错误码 */
export const IDENTITY_UNVERIFIED = "identity_unverified";

interface IdentityAgent {
  name: string;
  channelId?: string;
  sessionId?: string;
  runtime?: string;
}

export interface IdentityInput {
  /** 注册时出示的凭据的哈希；没出示 = undefined */
  credHash?: string;
  /** 这条连接注册的频道 */
  channelId?: string;
  /** 回环代理标过「这帧来自 shell 起的 channel-server」（只会降级，不会升级） */
  downgraded?: boolean;
}

export interface IdentityDeps {
  creds: Record<string, CredRecord>;
  agents: readonly IdentityAgent[];
  controlChannelId?: string;
  /** 大总管不在 registry：它现在的会话 id 由 bridge 按 MASTER_DIR 取（只在 master 已验证时才调） */
  masterSessionId?: () => string | undefined;
}

const MASTER = "master";

export function resolveCallerIdentity(i: IdentityInput, d: IdentityDeps): CallerIdentity {
  const rec = i.credHash ? d.creds[i.credHash] : undefined;
  const isControl = !!i.channelId && i.channelId === d.controlChannelId;
  const owner = i.channelId && !isControl ? d.agents.find((a) => a.channelId === i.channelId) : undefined;
  const ownerName = isControl ? MASTER : owner?.name ?? null;
  const verified = !!rec && !i.downgraded && !!ownerName && rec.agent === ownerName;
  return {
    agent: ownerName,
    sessionId: owner?.sessionId ?? (verified ? (isControl ? d.masterSessionId?.() : undefined) ?? rec!.sessionId ?? null : null),
    family: owner ? owner.runtime ?? "claude-code" : verified ? rec!.family : isControl ? "claude-code" : null,
    verified,
  };
}

/** 新注册要不要拒：频道现在由一个仍然有效的已验证连接持有，而新来的没带有效凭据 = 误投（Bash 里意外起的 channel-server） */
export function rejectsTakeover(holder: CallerIdentity | null, newcomer: CallerIdentity): boolean {
  return !!holder?.verified && !newcomer.verified;
}

export type VerifiedCheck = { ok: true; identity: CallerIdentity } | { ok: false; error: typeof IDENTITY_UNVERIFIED; identity: CallerIdentity };

/** 给 M2 / M3 工具用：未验证一律拒 */
export function requireVerified(identity: CallerIdentity): VerifiedCheck {
  return identity.verified ? { ok: true, identity } : { ok: false, error: IDENTITY_UNVERIFIED, identity };
}
