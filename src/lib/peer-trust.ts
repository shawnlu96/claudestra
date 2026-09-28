/**
 * 入站 peer 请求「是不是那个 peer 本人」的判定（纯逻辑；接线在 bridge/peer-signature.ts 与 bridge/relay-link.ts，
 * 单测 tests/peer-trust.test.ts）。peer token 只是 Bearer，经中继或任何反代都可能被旁人看到，
 * 所以身份最终落在实例签名上：签名钥匙的指纹必须等于本机为这个 peer 记下的指纹（期望指纹）。
 *   期望指纹 = peers.json 的 fp（邀请 / 兑换时记下）→ relay://<fp> 基址里的 fp → peer-keys.json 钉住的指纹；
 *   三样都没有的老 peer 截止日前放行并告警，之后同样拒绝。
 */
import { readPeers, relayPeerFingerprint } from "./peers.js";
import { findByBearer, readPrincipals } from "./principals.js";
import { isRedeemRequest } from "./relay-protocol.js";

/** 签名时间戳允许 ±300 秒（lib/instance-key.ts），一个签名最多在 600 秒里有效：去重窗口不能短于它 */
const REPLAY_TTL_MS = 10 * 60_000;

/**
 * 非幂等方法的签名在窗口内只认一次（签名含时间戳与正文哈希，同一 sig = 同一请求），过期条目随调用清掉。
 * 中继 peer 帧（bridge/relay-inbound.ts）与 authApi 的 peer 验签（bridge/peer-signature.ts）各持一份：
 * 经中继来的请求两份各见一次不算重放，截获后换一条路重放则会撞上 authApi 那份。
 */
export class ReplayCache {
  private readonly seenAt = new Map<string, number>();
  constructor(private readonly ttlMs = REPLAY_TTL_MS) {}

  /** true = 见过（重放） */
  seen(sig: string, now: number): boolean {
    for (const [k, t] of this.seenAt) if (now - t > this.ttlMs) this.seenAt.delete(k);
    if (this.seenAt.has(sig)) return true;
    this.seenAt.set(sig, now);
    return false;
  }
}

/** 没有任何期望指纹的老 peer（签名功能之前建立、又从没签过名）放行到这一刻；doctor 会报还剩几个 */
export const LEGACY_PEER_DEADLINE = "2026-11-01T00:00:00Z";

type PeerAnchorRecord = { fp?: string; baseUrl?: string };

/** peers.json 这条记录自带的指纹（邀请 / 兑换记下的 fp，或 relay:// 基址里的）；都没有返回 null */
export function recordPeerFp(rec: PeerAnchorRecord | null | undefined): string | null {
  const fp = rec?.fp?.trim().toLowerCase() || (rec?.baseUrl ? relayPeerFingerprint(rec.baseUrl) : null);
  return fp || null;
}

/** 期望指纹：记录自带的优先，其次是 TOFU 钉住的 */
export function expectedPeerFp(rec: PeerAnchorRecord | null | undefined, pinnedFp: string | null | undefined): string | null {
  return recordPeerFp(rec) ?? (pinnedFp?.toLowerCase() || null);
}

export type PeerSigVerdict = { allow: true; legacy: boolean } | { allow: false; reason: string };

/**
 * 验签结果 → 放不放行。有期望指纹（anchored）时只认 ok；没有时截止日前一律放行（legacy，调用方告警），
 * 截止日后按 unanchored 拒——那时还没签过名的 peer 要重新邀请。
 */
export function peerSigVerdict(result: string, anchored: boolean, now: number, deadline = LEGACY_PEER_DEADLINE): PeerSigVerdict {
  if (anchored) return result === "ok" ? { allow: true, legacy: false } : { allow: false, reason: result };
  if (result === "ok") return { allow: true, legacy: false };
  return now < Date.parse(deadline) ? { allow: true, legacy: true } : { allow: false, reason: "unanchored" };
}

/** 中继 req 帧里的 peer 凭据：Bearer，或（与 authApi 同口径）GET /api/v1/events 的 ?token= */
export function frameBearer(method: string, path: string, headers: Record<string, string>): string {
  const m = (headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (m?.[1]?.trim()) return m[1].trim();
  try {
    const u = new URL(path, "http://x");
    return method.toUpperCase() === "GET" && u.pathname === "/api/v1/events" ? u.searchParams.get("token") || "" : "";
  } catch {
    return ""; // 路径解析不了：没有查询串 token 可取，后面的路由会按路径本身拒掉
  }
}

export interface RelayPeerView {
  /** 本机联系人：peers.json 里未禁用且有期望指纹的记录 */
  contacts: ReadonlySet<string>;
  /** 这个 Bearer 属于哪个 peer、那个 peer 的期望指纹；不是有效 peer token 返回 null */
  bearerOwner(secret: string): { peer: string; fp: string | null } | null;
}

/**
 * 经中继进来、验签已过的 peer 请求还要满足：兑换邀请之外，from 必须是本机联系人；带了 token 的，
 * token 的主人的期望指纹必须就是 from——签名只证明「from 本人发的」，不证明 token 是他的。返回拒绝原因或 null。
 */
export function relayPeerRefusal(from: string, req: { method: string; path: string; headers: Record<string, string> }, view: RelayPeerView): string | null {
  const redeem = isRedeemRequest(req.method, req.path);
  if (!redeem && !view.contacts.has(from)) return "sender is not a contact of this instance";
  const secret = frameBearer(req.method, req.path, req.headers);
  if (!secret) return null;
  const owner = view.bearerOwner(secret);
  if (!owner) return "token is not a peer token of this instance";
  return owner.fp === from ? null : "token does not belong to the sender";
}

/** 现读 peers.json + principals.json 拼出 RelayPeerView（每个中继 peer 请求一次，两个文件都很小） */
export async function loadRelayPeerView(): Promise<RelayPeerView> {
  const [peers, file] = await Promise.all([readPeers(), readPrincipals()]);
  const live = (peers.httpPeers ?? []).filter((p) => !p.disabled);
  const fpOf = new Map(live.map((p) => [p.name, recordPeerFp(p)]));
  return {
    contacts: new Set(live.map(recordPeerFp).filter((fp): fp is string => !!fp)),
    bearerOwner: (secret) => {
      const p = findByBearer(file, secret);
      return p?.peer ? { peer: p.peer, fp: fpOf.get(p.peer) ?? null } : null;
    },
  };
}
