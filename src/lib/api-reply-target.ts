/**
 * reply 发到 `api:<tokenId>` 时这个 token 还收不收得到（bridge.ts deliverToApi 在认领请求之前调；tests/api-reply-target.test.ts）。
 * token 已删除 / 已停用就返回原因，deliverToApi 报错、请求不出队。不拦的话：删掉的 token 查不到 principal，被当成网页调用方照投；
 * 停用的 peer 旧 token 上撤销前挂着的请求还能被认领，结果记在旧 token 名下，对方换了新 token 轮询不到——两种 agent 都看到 Sent。
 * 撤销立刻生效：对方还有同步等待开着也不投。有效 token 不归这里管（peer 没在等的请求见 lib/pending-reply-scope.ts claimApiReply）。
 */
import { OWNER_PRINCIPAL_ID } from "./devices.js";
import { activePeerTokens } from "./peer-tidy.js";
import { findByTokenId, readPrincipalsStrict, type PrincipalsFile } from "./principals.js";

/** peer 的旧 token：附同一 peer 当前启用的那一个 chat_id（token id 不是密钥）；启用的不止一个或没有就不猜、不列 */
function disabledReason(file: PrincipalsFile, tokenId: string, peer?: string): string {
  if (!peer) return `api:${tokenId} 的 token 已停用，这条回复没有投递。`;
  const live = activePeerTokens(file.principals).filter((t) => t.peer === peer);
  const now = live.length === 1 ? `对方现在发来的消息 chat_id 是 api:${live[0]!.tokenId}；` : "";
  return `api:${tokenId} 是 peer「${peer}」已停用的旧 token（对方重新配对过，或已被移除），这条回复没有投递。`
    + `${now}要主动联系对方，用 send_to_agent(target="<对方 agent>@${peer}")。`;
}

/** null = token 还在用。owner:self 永不拦：owner 没配对过设备时 principals 里没有它，网页照样收得到 */
export function deadApiTargetReason(file: PrincipalsFile, tokenId: string): string | null {
  if (tokenId === OWNER_PRINCIPAL_ID) return null;
  const p = findByTokenId(file, tokenId);
  if (!p) return `api:${tokenId} 的 token 不存在（已删除或撤销），这条回复没有投递。`;
  return p.disabled ? disabledReason(file, tokenId, p.peer) : null;
}

/**
 * 读 principals.json 再判。文件损坏（strict 读抛错）时放行：一次读盘失败不该把 owner 的正常回复也挡掉；
 * 日志只写 token id 和原因——错误原文带路径和解析片段，可能夹着文件内容。文件不存在 = 没有任何 token，照常判。
 */
export async function deadApiTarget(
  tokenId: string, read: () => Promise<PrincipalsFile> = readPrincipalsStrict, log: (msg: string) => void = console.error,
): Promise<string | null> {
  if (tokenId === OWNER_PRINCIPAL_ID) return null;
  let file: PrincipalsFile;
  try {
    file = await read();
  } catch {
    log(`⚠️ 发往 api:${tokenId} 的回复没能核对 token 状态（principals.json 读不出来），按放行处理`);
    return null;
  }
  return deadApiTargetReason(file, tokenId);
}
