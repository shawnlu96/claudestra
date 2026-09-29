/** 兑换 / 加入邀请时给对方定记录名（manager/peers.ts 的 cmdPeerInviteRedeem / cmdPeerJoinAuto 用）。 */
import { readPeers, type HttpPeer } from "../lib/peers.js";
import { peerAnchorOf } from "../lib/peer-trust.js";

/** 自报名净化 + 撞名后缀。对方的名字是自报的——撞上已有 peer 时必须换名,
 *  否则一张新邀请就能顶掉既有 peer 的 baseUrl/outToken(peer 劫持)。
 *  sameAs 命中的记录不论叫什么都直接沿用它的名字(一个对方一条记录,lib/peers.ts 的 isSame*);anchor = 那条记录现在的期望指纹。
 *  refuse 成立 = 不该有这条记录(返回 null)。 */
export async function uniquePeerName(
  rawName: string,
  sameAs: (existing: HttpPeer, anchor: string | null) => boolean,
  refuse?: (all: HttpPeer[], anchorOf: (p: HttpPeer) => string | null) => boolean,
): Promise<string | null> {
  const anchorOf = await peerAnchorOf();
  const base = rawName.trim().replace(/[^\w-]/g, "").slice(0, 24) || "peer";
  const data = await readPeers();
  const all = data.httpPeers || [];
  if (refuse?.(all, anchorOf)) return null;
  const same = all.find((p) => sameAs(p, anchorOf(p)));
  if (same) return same.name;
  let name = base;
  for (let n = 2; n < 100; n++) {
    if (!all.some((p) => p.name === name)) return name;
    name = `${base}-${n}`;
  }
  return `${base}-${Date.now() % 10000}`;
}
