/**
 * 「本人」是谁（server 侧，BFF 用）：本前端自己的 token（api:<tokenId>）+ 本人的 Discord 账号
 * （bridge GET /whoami 的 ownerIds）。owner 2026-09-24：本人的所有来源靠右（自己的 web、自己的 Discord），
 * 其余一律靠左（agent、peer、别人的 web / Discord）。判定在 BFF 做：历史和直播都在这里剥掉本人的 from，
 * 前端「没有 from = 本人」的约定不用变。tests/web-me.test.ts
 */
import { bridgeGet } from "./bridge-api";

const TTL_MS = 5 * 60_000;
let cached: { at: number; ids: ReadonlySet<string> } | null = null;

/** 本人的所有发送者 id。bridge 不可达 / 老版本没有 ownerIds 时返回已知部分（至少不报错），下次再取 */
export async function getSelfIds(): Promise<ReadonlySet<string>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.ids;
  try {
    const j = await bridgeGet<{ tokenId?: string; ownerIds?: unknown }>("/whoami", { timeoutMs: 3000 });
    const ids = new Set<string>();
    if (j.tokenId) ids.add(`api:${j.tokenId}`);
    if (Array.isArray(j.ownerIds)) for (const x of j.ownerIds) if (typeof x === "string" && x) ids.add(x);
    cached = { at: Date.now(), ids };
    return ids;
  } catch (e) {
    console.warn("[me] whoami 取不到（本轮按 token 名 web-ui 认本人）:", (e as Error).message);
    return cached?.ids ?? new Set();
  }
}

/**
 * 这条入站消息是不是本人发的（任何来源）。有 fromId 按 id 认；没有（老 bridge 的历史 / 事件）
 * 退回按本前端的 token 名认。from 为空 = 本端乐观消息，本来就是本人。
 */
export function isSelfSource(from: string | undefined, fromId: string | undefined, selfIds: ReadonlySet<string>): boolean {
  if (!from) return true;
  if (fromId && selfIds.size) return selfIds.has(fromId);
  return from === "web-ui";
}
