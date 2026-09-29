/**
 * peer 共享的 external 闸门（纯函数，tests/peer-scope-gate.test.ts）。
 * owner 2026-09-27：external 从「未标就提示 --force」的防呆改成正式闸门——peer scope 只收
 * 已开启 external 的 agent，`*` 不再接受（它会把日后新建的、没开闸的 agent 一并放出去），
 * master 照旧硬禁。CLI 与 web Peer 面板都走这里，两边不会再出现「一边拦一边放」。
 */
export interface GateAgent {
  external?: boolean | null;
}

/** 返回第一条不通过的原因；全部通过返回 null。reg 的键是 registry 名（带 agent- 前缀）。 */
export function scopeGateError(agents: string[], reg: Record<string, GateAgent | undefined>): string | null {
  for (const a of agents) {
    if (a === "*") return `peer scope 不再接受 "*"：请逐个选择已开启 external 的 agent（"*" 会把日后新建的 agent 一并开放）。`;
    if (a === "master" || a === "agent-master") return `大总管不可开放给 peer——这是硬规则。`;
    const info = reg[a] || reg[`agent-${a}`];
    if (!info) return `agent "${a}" 不存在`;
    if (info.external !== true) return `agent "${a}" 未开启 external 闸门——在会话详情里开启后才能共享给 peer（它的上下文会对对方可见）。`;
  }
  return null;
}

export interface ScopedPrincipal {
  peer?: string | null;
  disabled?: boolean;
  agents: string[];
}

/** 当前把该 agent 放在有效 scope 里的 peer 名（"*" 也算；名带不带 agent- 前缀都认）。 */
export function peersSharingAgent(principals: ScopedPrincipal[], name: string): string[] {
  const bare = name.replace(/^agent-/, "");
  const out: string[] = [];
  for (const p of principals) {
    if (!p.peer || p.disabled) continue;
    if (p.agents.some((a) => a === "*" || a === bare || a === `agent-${bare}`)) out.push(p.peer);
  }
  return Array.from(new Set(out));
}

/** 关闭 external 时把它从所有 peer scope 里摘掉（"*" 不动——那是显式的全量授权，由 scope 编辑处理）。返回改动过的 peer 名。 */
export function dropAgentFromPeerScopes(principals: ScopedPrincipal[], name: string): string[] {
  const bare = name.replace(/^agent-/, "");
  const changed: string[] = [];
  for (const p of principals) {
    if (!p.peer || p.disabled) continue;
    const next = p.agents.filter((a) => a !== bare && a !== `agent-${bare}`);
    if (next.length !== p.agents.length) {
      p.agents = next;
      changed.push(p.peer);
    }
  }
  return changed;
}

/**
 * 「只能投递消息」的 token 放行哪些请求（tests/peer-messages-only.test.ts）。对方 bridge 互发只用这三个：
 * 投递（http-peer.ts）、轮询这次调用的回复（/threads/:id，属主另有校验）、探在线与 scope（GET /agents，peer-presence.ts）；
 * 外加委托卡的台账接口（local-api/peer-ledger.ts，只碰委托给它的卡）。
 * 其余（历史、事件流、打断、斜杠命令、附件……）一律拒；路径多一个斜杠也拒，宁可错杀。
 */
export function messagesOnlyAllows(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const card = /^\/api\/v1\/peer-ledger\/tasks\/[^/]+$/.test(pathname);
  if (m === "GET") return pathname === "/api/v1/agents" || pathname === "/api/v1/peer-ledger" || card || /^\/api\/v1\/threads\/[^/]+$/.test(pathname);
  return m === "POST" && (card || /^\/api\/v1\/agents\/[^/]+\/messages$/.test(pathname));
}

/** 把签给该 peer 的有效 token 设成 / 取消「只能投递消息」；返回改了几条（0 = 没有有效 token 或已是目标状态） */
export function setMessagesOnly(principals: (ScopedPrincipal & { messagesOnly?: boolean })[], peer: string, on: boolean): number {
  let n = 0;
  for (const p of principals) {
    if (p.peer !== peer || p.disabled || !!p.messagesOnly === on) continue;
    if (on) p.messagesOnly = true;
    else delete p.messagesOnly;
    n++;
  }
  return n;
}
