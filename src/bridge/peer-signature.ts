/**
 * 入站 peer 请求的验签与放行：authApi 认出 peer token 后调 checkPeerSignature，拒了就 401；放行的判完重放再 commit。
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
import { LogThrottle } from "../lib/log-throttle.js";
import { currentPin, inviteTokenVerdict, peerSigVerdict, recordPeerFp, ReplayCache, type PeerOnce, type PeerSigVerdict, type ReplayVerdict } from "../lib/peer-trust.js";

const PEER_KEYS_PATH = join(STATE_DIR, "peer-keys.json");
let keys: Map<string, PinnedPeerKey> | null = null;
/** 启动时算作刚写过：进程起来后的第一次失败也要等一分钟才补写 */
let lastWrite = Date.now();

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
/** 所有入口（直连、peer 入口、经中继）的 peer 请求共用；只收验签通过的请求，按 peer 分桶（lib/peer-trust.ts） */
const replays = new ReplayCache();
/**
 * GET/HEAD 的签名计次：正牌 peer 同一秒对同一路径发两次，签名一模一样，所以重复的不拒，只是第二次起不扣成功限速桶，
 * 重放截获的 GET 就耗不掉对方的额度；同一签名超过 GET_REPEAT_MAX 次才按重放拒。满了挤掉最旧的：丢一条只是那条签名
 * 再出现时多扣一次额度，不会放行任何本该拒的请求。
 */
const getRepeats = new ReplayCache(undefined, undefined, undefined, undefined, true);
const GET_REPEAT_MAX = 5;

/** 验签通过的请求判重放：reject 非 false = 拒（值是原因）；charge = 要不要扣成功限速桶 */
export function peerReplayVerdict(once: PeerOnce, peer: string): { reject: ReplayVerdict; charge: boolean } {
  if (!once.idempotent) return { reject: replays.seen(once.sig, once.ts, Date.now(), peer), charge: true };
  const n = getRepeats.hits(once.sig, once.ts, Date.now(), peer);
  // 签于本进程启动之前的 GET：之前见没见过无从得知，按第一次放行扣额度（拒了会让时钟慢的对端重启后轮询失败）
  if (typeof n !== "number") return { reject: n === "before_start" ? false : n, charge: true };
  return { reject: n > GET_REPEAT_MAX && "replay", charge: n === 1 };
}

/** 放行时带 commit：调用方判完重放再调，钉住 / 验签结果这时才记——重放的请求不留任何痕迹 */
export type PeerCheck = (Extract<PeerSigVerdict, { allow: true }> & { commit(): Promise<void> }) | Extract<PeerSigVerdict, { allow: false }>;
const nothing = async (): Promise<void> => {};

export async function checkPeerSignature(req: Request, url: URL, peer: string): Promise<PeerCheck> {
  if (!peer) return { allow: true, legacy: false, commit: nothing };
  const data = await readPeers();
  if (peer.startsWith("invite:")) { // 未兑换的邀请 token：还没有对方记录可比，只看邀请本身还在不在、是不是只读
    const v = inviteTokenVerdict(req.method, peer.slice("invite:".length), data.pendingInvites ?? [], Date.now());
    return v.allow ? { ...v, commit: nothing } : rejected(peer, v, undefined);
  }
  const rec = data.httpPeers?.find((p) => p.name === peer);
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
  const check = (pk: string) => verifySigned(pk, { method: req.method, path, ts: hdr.ts!, sig: hdr.sig!, body });
  const next = judgeSignature(prev, hdr, check, new Date().toISOString(), recordFp, rec?.publicKey ?? null);
  const result = next.lastCheck!.result;
  const verdict = peerSigVerdict(result, !!(recordFp || prev?.publicKey || rec?.publicKey), Date.now());
  if (!verdict.allow) return rejected(peer, verdict, next.lastCheck);
  if (verdict.legacy && Date.now() - (legacyWarnedAt.get(peer) ?? 0) > LEGACY_WARN_EVERY_MS) {
    legacyWarnedAt.set(peer, Date.now());
    console.warn(`⚠️ [peer-sig] ${peer}: ${result}，没有记录过对方指纹，截止日前放行（PEER_LEGACY_DEADLINE，默认见 lib/peer-trust.ts）`);
  }
  const idempotent = req.method === "GET" || req.method === "HEAD";
  const once = result === "ok" ? { once: { sig: hdr.sig!, ts: hdr.ts!, idempotent } } : {};
  return { ...verdict, ...once, commit: () => persist(peer, next) };
}

const rejectLog = new LogThrottle();
/**
 * 拒绝：结果只记进内存（lastCheck，钉住的钥匙不动），由定时器一分钟最多补写一次——doctor 读的是文件，持续失败要能落到盘上。
 * 日志每个 peer 每分钟最多一行，附上这期间被拒的条数：拿着 token 连发坏签名刷不满日志。
 */
function rejected(peer: string, v: Extract<PeerSigVerdict, { allow: false }>, check: PinnedPeerKey["lastCheck"]): PeerCheck {
  if (check) {
    loaded().set(peer, { ...loaded().get(peer), lastCheck: check });
    scheduleFlush(peer);
  }
  const log = rejectLog.take(peer);
  if (log) console.warn(`🚫 [peer-sig] ${log.key}: ${v.reason}，拒绝${log.muted ? `（上一分钟另有 ${log.muted} 条被拒）` : ""}`);
  return v;
}

/** 钉住的钥匙变了立刻写；其余（结果没变的 ok、老 peer 的 unsigned）等定时器一分钟最多补写一次。写失败不影响这次判定 */
async function persist(peer: string, next: PinnedPeerKey): Promise<void> {
  const prev = loaded().get(peer);
  loaded().set(peer, next);
  if (prev?.publicKey !== next.publicKey && next.lastCheck?.result === "ok") return flush(peer);
  scheduleFlush(peer);
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleFlush(peer: string): void {
  flushTimer ??= setTimeout(() => void flush(peer), Math.min(60_000, Math.max(0, 60_000 - (Date.now() - lastWrite))));
  flushTimer.unref?.();
}

async function flush(peer: string): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  lastWrite = Date.now();
  try {
    await writeJsonAtomic(PEER_KEYS_PATH, { updatedAt: new Date().toISOString(), peers: Object.fromEntries(loaded()) });
  } catch (e) {
    console.warn(`[peer-sig] ${peer} 验签结果落盘失败（这次判定已生效，下次再写）: ${(e as Error).message}`);
  }
}
