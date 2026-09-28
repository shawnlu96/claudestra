/**
 * doctor 的「peer 验签」一项：入站 peer 里还有几个没有期望指纹（peers.json 没记 fp、不是 relay:// 地址、也没钉住过签名钥匙）。
 * 它们在 lib/peer-trust.ts 的 LEGACY_PEER_DEADLINE 之前照常放行，之后会被拒；提前点名，owner 好让对方升级或重新邀请。
 * 没有这类 peer 时不出行。判定是纯函数 legacyPeerChecks（tests/peer-trust.test.ts）。
 */
import { join } from "node:path";
import type { Check } from "./doctor.js";
import { STATE_DIR } from "./paths.js";
import { readPeers } from "./peers.js";
import { LEGACY_PEER_DEADLINE, recordPeerFp } from "./peer-trust.js";
import { readPrincipals } from "./principals.js";
import { readJsonLenient } from "./state-file.js";

export function legacyPeerChecks(legacy: string[], now = Date.now(), deadline = LEGACY_PEER_DEADLINE): Check[] {
  if (legacy.length === 0) return [];
  const day = deadline.slice(0, 10);
  const passed = now >= Date.parse(deadline);
  return [{
    group: "Peer", name: "peer 验签", status: passed ? "fail" : "warn",
    detail: `${legacy.length} 个老 peer 没有签名记录（${legacy.join("、")}）——${passed ? `${day} 起已被拒绝` : `${day} 之后会被拒绝`}`,
    fix: "让对方升级 Claudestra（新版本自动签名，下一次调用就会钉住）；已经升级还是这样就重新邀请一次",
  }];
}

/** 入站 peer（有效的、已兑换的 peer token）里没有任何期望指纹的那些 */
export async function checkLegacyPeers(): Promise<Check[]> {
  const [peers, file, keys] = await Promise.all([
    readPeers(),
    readPrincipals(),
    readJsonLenient<{ peers?: Record<string, { publicKey?: string }> }>(join(STATE_DIR, "peer-keys.json"), {}, { who: "peer-keys" }),
  ]);
  const recs = new Map((peers.httpPeers ?? []).map((p) => [p.name, p]));
  const inbound = new Set(file.principals.filter((p) => p.peer && !p.disabled && !p.peer.startsWith("invite:")).map((p) => p.peer!));
  const legacy = [...inbound].filter((name) => !recordPeerFp(recs.get(name)) && !keys.peers?.[name]?.publicKey);
  return legacyPeerChecks(legacy.sort());
}
