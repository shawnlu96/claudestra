/**
 * 入站 peer 请求的验签（只记录、不拦截）：authApi 认出 peer token 后调 notePeerSignature。
 * 规则在 lib/peer-keys.ts；结果落 STATE_DIR/peer-keys.json（bridge 是唯一写者），GET /peers 带出去给 Peer 面板显示。
 * 读正文用 req.clone()：原请求的 body 还要留给后面的路由处理。
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { STATE_DIR } from "../lib/paths.js";
import { writeJsonAtomic } from "../lib/state-file.js";
import { SIG_HEADERS, verifySigned } from "../lib/instance-key.js";
import { judgeSignature, type PinnedPeerKey } from "../lib/peer-keys.js";

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

export async function notePeerSignature(req: Request, url: URL, peer: string): Promise<void> {
  if (!peer || peer.startsWith("invite:")) return;
  try {
    const hdr = { key: req.headers.get(SIG_HEADERS.key), ts: req.headers.get(SIG_HEADERS.ts), sig: req.headers.get(SIG_HEADERS.sig) };
    const body = hdr.sig && req.body ? new Uint8Array(await req.clone().arrayBuffer()) : new Uint8Array();
    const path = url.pathname + url.search;
    const next = judgeSignature(loaded().get(peer), hdr, (pk) => verifySigned(pk, { method: req.method, path, ts: hdr.ts!, sig: hdr.sig!, body }), new Date().toISOString());
    const prev = loaded().get(peer);
    loaded().set(peer, next);
    const result = next.lastCheck?.result;
    if (result !== "ok" && result !== "unsigned") console.warn(`⚠️ [peer-sig] ${peer}: ${result}`);
    // 对方每分钟探测、每 30s 轮询都会进来：结果或钉住的钥匙变了才立刻写，否则一分钟最多写一次
    if (prev?.lastCheck?.result === result && prev?.publicKey === next.publicKey && Date.now() - lastWrite < 60_000) return;
    lastWrite = Date.now();
    await writeJsonAtomic(PEER_KEYS_PATH, { updatedAt: new Date().toISOString(), peers: Object.fromEntries(loaded()) });
  } catch (e) {
    console.warn(`[peer-sig] ${peer} 验签记录失败（不影响请求本身）: ${(e as Error).message}`);
  }
}
