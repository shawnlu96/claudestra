/**
 * 入站 peer 请求的验签与放行：authApi 认出 peer token 后调 checkPeerSignature，拒了就 401。
 * 钉住规则在 lib/peer-keys.ts，放行规则（期望指纹、老 peer 截止日）在 lib/peer-trust.ts；
 * 结果落 STATE_DIR/peer-keys.json（bridge 是唯一写者），GET /peers 带出去给 Peer 面板显示。
 * 读正文用 req.clone()：原请求的 body 还要留给后面的路由处理。
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { STATE_DIR } from "../lib/paths.js";
import { writeJsonAtomic } from "../lib/state-file.js";
import { SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { judgeSignature, type PinnedPeerKey } from "../lib/peer-keys.js";
import { readPeers } from "../lib/peers.js";
import { currentPin, peerSigVerdict, recordPeerFp, ReplayCache, type PeerSigVerdict } from "../lib/peer-trust.js";

const PEER_KEYS_PATH = join(STATE_DIR, "peer-keys.json");
let keys: Map<string, PinnedPeerKey> | null = null;
let lastWrite = 0;

function loaded(): Map<string, PinnedPeerKey> {
  if (keys) return keys;
  try {
    keys = new Map(Object.entries((JSON.parse(readFileSync(PEER_KEYS_PATH, "utf8")) as { peers?: Record<string, PinnedPeerKey> }).peers ?? {}));
  } catch {
    keys = new Map(); // 还没钉过任何 peer（文件不存在）或文件坏了：从头来，下一次签名请求重新钉
  }
  return keys;
}

export function peerSignatureState(peer: string): PinnedPeerKey | null {
  return loaded().get(peer) ?? null;
}

const LEGACY_WARN_EVERY_MS = 60 * 60_000;
const legacyWarnedAt = new Map<string, number>();
/** 所有入口（直连、peer 入口、经中继）的 peer 请求共用；authApi 在限速之后才写，拿不到签名的请求碰不到它 */
const replays = new ReplayCache();

/** 验签通过的非 GET/HEAD 请求：这个签名用过 → "replay"；早于本进程启动 → "replay_before_restart"；否则 null */
export function peerReplayReason(once: { sig: string; ts: string }): "replay" | "replay_before_restart" | null {
  return replays.verdict(once.sig, once.ts, Date.now());
}

export async function checkPeerSignature(req: Request, url: URL, peer: string): Promise<PeerSigVerdict> {
  if (!peer || peer.startsWith("invite:")) return { allow: true, legacy: false }; // 未兑换的邀请 token：还没有对方记录可比
  const rec = (await readPeers()).httpPeers?.find((p) => p.name === peer);
  const recordFp = recordPeerFp(rec);
  const hdr = { key: req.headers.get(SIG_HEADERS.key), ts: req.headers.get(SIG_HEADERS.ts), sig: req.headers.get(SIG_HEADERS.sig) };
  let body = new Uint8Array();
  try {
    if (hdr.sig && req.body) body = new Uint8Array(await req.clone().arrayBuffer());
  } catch (e) {
    return { allow: false, reason: `body unreadable: ${(e as Error).message}` };
  }
  const path = url.pathname + url.search;
  const prev = currentPin(loaded().get(peer), rec);
  const next = judgeSignature(prev, hdr, (pk) => verifySigned(pk, { method: req.method, path, ts: hdr.ts!, sig: hdr.sig!, body }), new Date().toISOString(), recordFp);
  const result = next.lastCheck!.result;
  const verdict = peerSigVerdict(result, !!(recordFp || prev?.publicKey), Date.now());
  if (!verdict.allow) console.warn(`🚫 [peer-sig] ${peer}: ${verdict.reason}，拒绝`);
  else if (verdict.legacy && Date.now() - (legacyWarnedAt.get(peer) ?? 0) > LEGACY_WARN_EVERY_MS) {
    legacyWarnedAt.set(peer, Date.now());
    console.warn(`⚠️ [peer-sig] ${peer}: ${result}，没有记录过对方指纹，截止日前放行（PEER_LEGACY_DEADLINE，默认见 lib/peer-trust.ts）`);
  }
  await persist(peer, loaded().get(peer), next);
  const idempotent = req.method === "GET" || req.method === "HEAD";
  return verdict.allow && result === "ok" && !idempotent ? { ...verdict, once: { sig: hdr.sig!, ts: hdr.ts! } } : verdict;
}

/** 对方每分钟探测、每 30s 轮询都会进来：结果或钉住的钥匙变了才立刻写，否则一分钟最多写一次；写失败不影响这次判定 */
async function persist(peer: string, prev: PinnedPeerKey | undefined, next: PinnedPeerKey): Promise<void> {
  loaded().set(peer, next);
  if (prev?.lastCheck?.result === next.lastCheck?.result && prev?.publicKey === next.publicKey && Date.now() - lastWrite < 60_000) return;
  lastWrite = Date.now();
  try {
    await writeJsonAtomic(PEER_KEYS_PATH, { updatedAt: new Date().toISOString(), peers: Object.fromEntries(loaded()) });
  } catch (e) {
    console.warn(`[peer-sig] ${peer} 验签结果落盘失败（这次判定已生效，下次再写）: ${(e as Error).message}`);
  }
}
