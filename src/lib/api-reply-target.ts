/**
 * reply 发到 `api:<tokenId>` 时，这个地址后面还有没有人收得到（bridge.ts deliverToApi 调；tests/api-reply-target.test.ts）。
 * 收不到就给出原因，deliverToApi 回 dropped，reply 工具报错。不拦的话 deliverToApi 一律回 sent，agent 看到 `Sent message(s): []`
 * 以为发出去了：token 删了 / 停用了，对方拿它轮询 /threads 是 401；peer 只轮询自己那条请求的 threadId（bridge/http-peer.ts），
 * 没有挂着的请求时回复落在一个新造的 threadId 上，没人会去问。owner:self 永不拦；非 peer 的有效 token 靠 SSE + 历史收，不看队列。
 */
import { OWNER_PRINCIPAL_ID } from "./devices.js";
import { findByTokenId, readPrincipalsStrict, tokenIdOf, type PrincipalsFile } from "./principals.js";

export type ApiTarget = { ok: true; peer?: string } | { ok: false; reason: string };

const contactHint = (peer: string) => `要主动联系对方，用 send_to_agent(target="<对方 agent>@${peer}")。`;

/** 停用的 token：peer 的旧 token 附上同一 peer 当前启用的那一个（只是 token id，不是密钥）；启用的不止一个就不猜，不列 */
function disabledReason(file: PrincipalsFile, tokenId: string, peer?: string): string {
  if (!peer) return `api:${tokenId} 的 token 已停用，这条回复没人收得到。`;
  const live = file.principals.filter((x) => x.peer === peer && !x.disabled && x.id.startsWith("token:"));
  const now = live.length === 1 ? `对方现在发来的消息 chat_id 是 api:${tokenIdOf(live[0]!)}；` : "";
  return `api:${tokenId} 是 peer「${peer}」已停用的旧 token（对方重新配对过，或已被移除），这条回复对方收不到。${now}${contactHint(peer)}`;
}

export function apiTargetVerdict(file: PrincipalsFile, tokenId: string): ApiTarget {
  if (tokenId === OWNER_PRINCIPAL_ID) return { ok: true };
  const p = findByTokenId(file, tokenId);
  if (!p) return { ok: false, reason: `api:${tokenId} 的 token 不存在（已删除或撤销），这条回复没人收得到。` };
  if (p.disabled) return { ok: false, reason: disabledReason(file, tokenId, p.peer) };
  return p.peer ? { ok: true, peer: p.peer } : { ok: true };
}

/** 地址有效、但 peer 那边没有挂着的请求（已答过 / 超过 2 小时被清 / 对方没发过）：回复写不进对方在轮询的 thread */
export function orphanReplyReason(target: ApiTarget, hasWaiter: boolean, tokenId: string): string | null {
  if (!target.ok || !target.peer || hasWaiter) return null;
  return `peer「${target.peer}」没有在等这条回复的请求（api:${tokenId} 上的请求已经答过、超过 2 小时，或对方没发过），对方收不到。${contactHint(target.peer)}`;
}

/** principals.json 读坏了（strict 读抛错）按旧行为放行并记日志：一次读盘失败不该把 owner 的正常回复也挡掉；文件不存在 = 空表，照常判 */
export async function checkApiTarget(tokenId: string, read: () => Promise<PrincipalsFile> = readPrincipalsStrict): Promise<ApiTarget> {
  if (tokenId === OWNER_PRINCIPAL_ID) return { ok: true };
  try {
    return apiTargetVerdict(await read(), tokenId);
  } catch (e) {
    console.error(`⚠️ 读 principals 失败，发往 api:${tokenId} 的回复按旧行为放行: ${(e as Error).message}`);
    return { ok: true };
  }
}
