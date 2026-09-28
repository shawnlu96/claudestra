/**
 * doctor 的「peer 验签」两项。一：入站 peer 里还有几个没有期望指纹（peers.json 没记 fp、不是 relay:// 地址、也没钉住过签名钥匙）。
 * 它们在截止日（PEER_LEGACY_DEADLINE，lib/peer-trust.ts）之前照常放行，之后会被拒；提前点名，owner 好让对方升级或重新邀请。
 * 二：有期望指纹、但最近一次验签没通过的——这些现在就会被拒。都没有时不出行。
 * 判定是纯函数 legacyPeerChecks / failingPeerChecks（tests/peer-trust.test.ts）。
 */
import { join } from "node:path";
import type { Check } from "./doctor.js";
import { STATE_DIR } from "./paths.js";
import { readPeers } from "./peers.js";
import { currentPin, legacyPeerDeadline, recordPeerFp } from "./peer-trust.js";
import { readPrincipals } from "./principals.js";
import { readJsonLenient } from "./state-file.js";

export function legacyPeerChecks(legacy: string[], now = Date.now(), deadline = legacyPeerDeadline()): Check[] {
  if (legacy.length === 0) return [];
  const day = deadline.slice(0, 10);
  const passed = now >= Date.parse(deadline);
  return [{
    group: "Peer", name: "peer 验签", status: passed ? "fail" : "warn",
    detail: `${legacy.length} 个老 peer 没有签名记录（${legacy.join("、")}）——${passed ? `${day} 起已被拒绝` : `${day} 之后会被拒绝`}`,
    fix: "让对方升级 Claudestra（新版本自动签名，下一次调用就会钉住）；已经升级还是这样就重新邀请一次",
  }];
}

/** 有期望指纹、但最近一次验签不是 ok 的 peer（时钟差、反代改了路径、对方换了钥匙……）：它们的请求现在就会被拒 */
export function failingPeerChecks(failing: { name: string; result: string }[]): Check[] {
  if (failing.length === 0) return [];
  return [{
    group: "Peer", name: "peer 验签失败", status: "warn",
    detail: `${failing.length} 个 peer 最近一次验签没通过（${failing.map((f) => `${f.name}: ${f.result}`).join("、")}），它们的请求会被拒`,
    fix: "stale = 两台机器时钟差超过 5 分钟，先对时；key_changed = 对方换了实例钥匙，删掉这个 peer 后让对方重新邀请；bad = 签名路径对不上（反代改了路径前缀）",
  }];
}

type PinView = { publicKey?: string; pinnedAt?: string; lastCheck?: { result?: string } };

/** 入站 peer（有效的、已兑换的 peer token）里：没有任何期望指纹的老 peer，和有期望指纹但最近验签没通过的 */
export async function checkLegacyPeers(): Promise<Check[]> {
  const [peers, file, keys] = await Promise.all([
    readPeers(),
    readPrincipals(),
    readJsonLenient<{ peers?: Record<string, PinView> }>(join(STATE_DIR, "peer-keys.json"), {}, { who: "peer-keys" }),
  ]);
  const recs = new Map((peers.httpPeers ?? []).map((p) => [p.name, p]));
  const inbound = [...new Set(file.principals.filter((p) => p.peer && !p.disabled && !p.peer.startsWith("invite:")).map((p) => p.peer!))].sort();
  const legacy: string[] = [], failing: { name: string; result: string }[] = [];
  for (const name of inbound) {
    const pin = currentPin(keys.peers?.[name], recs.get(name));
    if (!recordPeerFp(recs.get(name)) && !pin?.publicKey) legacy.push(name);
    else if (pin?.lastCheck?.result && pin.lastCheck.result !== "ok") failing.push({ name, result: pin.lastCheck.result });
  }
  return [...legacyPeerChecks(legacy), ...failingPeerChecks(failing)];
}
