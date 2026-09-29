/**
 * doctor 的 peer 验签三项。一：入站 peer 里还有几个没有期望指纹（peers.json 没记 fp、不是 relay:// 地址、也没钉住过签名钥匙）。
 * 它们在截止日（PEER_LEGACY_DEADLINE，lib/peer-trust.ts）之前照常放行，之后会被拒；提前点名，owner 好让对方升级或重新邀请。
 * 二：有期望指纹、但验签持续没通过的——这些现在就会被拒。三：入站 token 的 peer 名在 peers.json 里找不到的。
 * 都没有时不出行。判定是纯函数 legacyPeerChecks / failingPeerChecks / orphanPeerChecks / persistentlyFailing（tests/peer-trust.test.ts）。
 */
import type { Check } from "./doctor.js";
import type { PinnedPeerKey } from "./peer-keys.js";
import { readPeers } from "./peers.js";
import { currentPin, legacyPeerDeadline, readPeerPins, recordPeerFp } from "./peer-trust.js";
import { readPrincipals } from "./principals.js";

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

/** 有期望指纹、验签一直没通过的 peer（时钟差、反代改了路径、对方换了钥匙……）：它们的请求现在就会被拒 */
export function failingPeerChecks(failing: { name: string; result: string }[]): Check[] {
  if (failing.length === 0) return [];
  return [{
    group: "Peer", name: "peer 验签失败", status: "warn",
    detail: `${failing.length} 个 peer 验签持续没通过（${failing.map((f) => `${f.name}: ${f.result}`).join("、")}），它们的请求会被拒`,
    fix: "stale = 两台机器时钟差超过 5 分钟，先对时；key_changed = 对方换了实例钥匙，删掉这个 peer 后让对方重新邀请；bad = 签名路径对不上（反代改了路径前缀）",
  }];
}

/** 入站 peer token 上的 peer 名在 peers.json 里没有记录：查不到记录里的指纹，经中继的请求现在就被拒（直连的靠钉住的钥匙还能用） */
export function orphanPeerChecks(orphans: string[]): Check[] {
  if (orphans.length === 0) return [];
  return [{
    group: "Peer", name: "peer 名对不上", status: "warn",
    detail: `${orphans.length} 张入站 peer token 的名字在 peer 列表里找不到（${orphans.join("、")}）`,
    fix: "多半是改过名：在 Peer 面板移除这个 peer，再重新邀请一次",
  }];
}

/** 最近一次没通过，且之前 10 分钟里也没通过过（或从没通过）才算：拿着 token 乱签一次不该让 doctor 报警 */
const FAILING_AFTER_MS = 10 * 60_000;
export function persistentlyFailing(pin: PinnedPeerKey | undefined): string | null {
  const last = pin?.lastCheck;
  if (!last?.result || last.result === "ok") return null;
  const okAt = pin?.lastOkAt ? Date.parse(pin.lastOkAt) : NaN;
  return Number.isFinite(okAt) && Date.parse(last.at) - okAt <= FAILING_AFTER_MS ? null : last.result;
}

/** 入站 peer（有效的、已兑换的 peer token）里：没有期望指纹的老 peer、验签持续没通过的、名字在 peers.json 里找不到的 */
export async function checkLegacyPeers(): Promise<Check[]> {
  const [peers, file, pins] = await Promise.all([readPeers(), readPrincipals(), readPeerPins()]);
  const recs = new Map((peers.httpPeers ?? []).map((p) => [p.name, p]));
  const inbound = [...new Set(file.principals.filter((p) => p.peer && !p.disabled && !p.peer.startsWith("invite:")).map((p) => p.peer!))].sort();
  const legacy: string[] = [], failing: { name: string; result: string }[] = [], orphans: string[] = [];
  for (const name of inbound) {
    const pin = currentPin(pins[name], recs.get(name));
    const bad = persistentlyFailing(pin);
    if (!recs.has(name)) orphans.push(name);
    else if (!recordPeerFp(recs.get(name)) && !pin?.publicKey) legacy.push(name);
    else if (bad) failing.push({ name, result: bad });
  }
  const records = await (await import("./doctor-peer-records.js")).checkPeerRecords(); // 记录自相矛盾、升级后会被拒的
  return [...legacyPeerChecks(legacy), ...failingPeerChecks(failing), ...orphanPeerChecks(orphans), ...records];
}
