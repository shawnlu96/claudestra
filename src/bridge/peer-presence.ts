/**
 * 在线 peer 列表：每分钟探一遍所有出站 peer（带我们的 outToken GET 对方 /api/v1/agents），
 * 顺带记每个 peer 最近一次来访（authApi 认出 peer token 时调 notePeerInbound）。
 * 结果在内存里给 GET /api/v1/peers 用，同时落盘 STATE_DIR/peer-presence.json——
 * agent / manager 不经 bridge 也能读「谁在线、对方开放了哪些 agent」，发之前心里有数。
 * 只读探测，不动 peers.json；探测失败只记原因不报警（对方关机是常态）。合并规则见 lib/peer-presence.ts。
 */
import { join } from "path";
import { readPeers, type HttpPeer } from "../lib/peers.js";
import { STATE_DIR } from "../lib/paths.js";
import { writeJsonAtomic } from "../lib/state-file.js";
import { signedFor } from "../lib/instance-key.js";
import { mergeProbe, probeErrorOf, probeResultOf, type PeerPresence, type ProbeResult } from "../lib/peer-presence.js";

export const PEER_PRESENCE_PATH = join(STATE_DIR, "peer-presence.json");
const PROBE_EVERY_MS = 60_000;
const PROBE_TIMEOUT_MS = 6_000;

const presence = new Map<string, PeerPresence>();

/** 对方调了我们的 API（authApi 认出 peer token 时）。兑换前的邀请 token 名是 invite:<id>，不记 */
export function notePeerInbound(peer: string): void {
  if (!peer || peer.startsWith("invite:")) return;
  presence.set(peer, { ...(presence.get(peer) ?? { online: null }), lastInboundAt: new Date().toISOString() });
}

export function peerPresence(name: string): PeerPresence {
  return presence.get(name) ?? { online: null };
}

async function probe(p: HttpPeer): Promise<ProbeResult | null> {
  if (!p.baseUrl || !p.outToken) return null; // 单向：只有对方连我，没法主动探
  const t0 = Date.now();
  try {
    const url = `${p.baseUrl.replace(/\/+$/, "")}/api/v1/agents`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${p.outToken}`, ...signedFor("GET", url, "") },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await r.json().catch(() => null); // 非 JSON（对方前面是网页 / 反代错页）按空列表处理，状态码照样判
    return probeResultOf(r.status, body, Date.now() - t0);
  } catch (e) {
    return { ok: false, error: probeErrorOf(e) };
  }
}

async function probeAll(): Promise<void> {
  const peers = (await readPeers()).httpPeers?.filter((p) => !p.disabled) ?? [];
  const results = await Promise.all(peers.map(async (p) => [p.name, await probe(p)] as const));
  const now = new Date().toISOString();
  for (const [name, r] of results) presence.set(name, mergeProbe(presence.get(name), r, now));
  // 删掉的 peer 别一直挂在列表里
  const live = new Set(peers.map((p) => p.name));
  for (const name of presence.keys()) if (!live.has(name)) presence.delete(name);
  await writeJsonAtomic(PEER_PRESENCE_PATH, { updatedAt: now, peers: Object.fromEntries(presence) });
}

/** bridge 启动时调一次（经 initHttpPeer）；探测出错只记日志，下一轮照跑 */
export function startPeerPresence(): void {
  const tick = () => void probeAll().catch((e) => console.warn("⚠️ peer 在线探测失败（下一轮再试）:", e));
  setTimeout(tick, 10_000);
  setInterval(tick, PROBE_EVERY_MS);
}
