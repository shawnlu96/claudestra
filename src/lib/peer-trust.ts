/**
 * 入站 peer 请求「是不是那个 peer 本人」的判定（纯逻辑；接线在 bridge/peer-signature.ts 与 bridge/relay-link.ts，
 * 单测 tests/peer-trust.test.ts）。peer token 只是 Bearer，经中继或任何反代都可能被旁人看到，
 * 所以身份最终落在实例签名上：签名钥匙的指纹必须等于本机为这个 peer 记下的指纹（期望指纹）。
 *   期望指纹 = peers.json 的 fp（邀请 / 兑换时记下）→ relay://<fp> 基址里的 fp → peer-keys.json 钉住的指纹；
 *   三样都没有的老 peer 截止日前放行并告警，之后同样拒绝。
 */
import { join } from "node:path";
import { readPeers, relayPeerFingerprint, type HttpPeer } from "./peers.js";
import type { PinnedPeerKey } from "./peer-keys.js";
import { STATE_DIR } from "./paths.js";
import { readJsonLenient } from "./state-file.js";
import { findByBearer, readPrincipals } from "./principals.js";
import { repoEnvVar } from "./env-file.js";
import { isRedeemRequest } from "./relay-protocol.js";

/** 签名时间戳允许 ±300 秒（lib/instance-key.ts），一个签名最多在 600 秒里有效：去重窗口不能短于它 */
const REPLAY_TTL_MS = 10 * 60_000;
/** 条目上限：authApi 那份在限速之后才写（每个 peer 每分钟最多 120 条），满了挤掉最老的 */
const REPLAY_MAX_ENTRIES = 50_000;
/** 本进程启动时刻（秒）：缓存不落盘，重启前签出的非 GET 请求一律当重放 */
const PROCESS_START_S = Math.floor(Date.now() / 1000);

/** seen 的结果：false = 第一次见；replay = 见过（或可能见过、记录已被挤掉）；before_start = 签名时间早于本进程启动 */
export type ReplayVerdict = false | "replay" | "before_start";

/**
 * 非幂等方法的签名在窗口内只认一次（签名含时间戳与正文哈希，同一签名 = 同一请求）。键是解码后的签名字节，
 * 不是原串——同一签名不能靠换一种 base64url 写法变成新键（验签那边也只认规范写法，两头都防）。
 * 满了挤掉最老的条目时记下它的签名时间（floorTs）：不晚于它的签名可能见过、已无记录，一律当重放——
 * 被灌满时误拒这一小段，而不是放过重放。
 * 中继 peer 帧（bridge/relay-inbound.ts）与 authApi 的 peer 验签（bridge/peer-signature.ts）各持一份：
 * 经中继来的请求两份各见一次不算重放，截获后换一条路重放则会撞上 authApi 那份。
 */
export class ReplayCache {
  private readonly seenAt = new Map<string, { at: number; ts: number }>();
  private floorTs = -Infinity;
  constructor(
    private readonly ttlMs = REPLAY_TTL_MS,
    private readonly max = REPLAY_MAX_ENTRIES,
    private readonly startS = PROCESS_START_S,
  ) {}

  seen(sig: string, ts: string, now: number): ReplayVerdict {
    const t = Number(ts);
    if (!(t >= this.startS)) return "before_start"; // 那之前见过什么已无从得知
    if (t <= this.floorTs) return "replay";
    for (const [k, e] of this.seenAt) {
      if (now - e.at <= this.ttlMs) break; // 按插入顺序过期，遇到第一条没过期的就停
      this.seenAt.delete(k);
    }
    const key = Buffer.from(sig, "base64url").toString("hex");
    if (this.seenAt.has(key)) return "replay";
    if (this.seenAt.size >= this.max) {
      const [oldest, e] = this.seenAt.entries().next().value!;
      this.seenAt.delete(oldest);
      this.floorTs = Math.max(this.floorTs, e.ts);
    }
    this.seenAt.set(key, { at: now, ts: t });
    return false;
  }
}

/** 没有任何期望指纹的老 peer（签名功能之前建立、又从没签过名）默认放行到这一刻；doctor 会报还剩几个 */
export const LEGACY_PEER_DEADLINE = "2026-11-01T00:00:00Z";

/** 实际截止日：环境变量 / .env 的 PEER_LEGACY_DEADLINE（任何 Date.parse 认得的日期）可以提前或推后；解析不了用默认 */
export function legacyPeerDeadline(raw = repoEnvVar("PEER_LEGACY_DEADLINE").trim()): string {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : LEGACY_PEER_DEADLINE;
}

let deadlineMemo = { at: -Infinity, value: LEGACY_PEER_DEADLINE };
/** 验签路径用：.env 是同步读的，一分钟最多读一次 */
function currentLegacyDeadline(now: number): string {
  if (now - deadlineMemo.at > 60_000) deadlineMemo = { at: now, value: legacyPeerDeadline() };
  return deadlineMemo.value;
}

type PeerAnchorRecord = { fp?: string; baseUrl?: string };

/** peers.json 这条记录自带的指纹（邀请 / 兑换记下的 fp，或 relay:// 基址里的）；都没有返回 null */
export function recordPeerFp(rec: PeerAnchorRecord | null | undefined): string | null {
  const fp = rec?.fp?.trim().toLowerCase() || (rec?.baseUrl ? relayPeerFingerprint(rec.baseUrl) : null);
  return fp || null;
}

/**
 * 钉住的钥匙早于这条 peer 记录的建立时间 = 属于之前同名的那个对方（删掉后同名重加），不再作数：
 * 新记录要么带 fp（邀请 / 兑换签名得来），要么按老 peer 重新钉。manager 删 peer 时不必跨进程改 peer-keys.json。
 */
export function currentPin<T extends { pinnedAt?: string }>(pin: T | undefined, rec: { addedAt?: string } | undefined): T | undefined {
  return pin?.pinnedAt && rec?.addedAt && pin.pinnedAt < rec.addedAt ? undefined : pin;
}

/** 期望指纹：记录自带的优先，其次是 TOFU 钉住的 */
export function expectedPeerFp(rec: PeerAnchorRecord | null | undefined, pinnedFp: string | null | undefined): string | null {
  return recordPeerFp(rec) ?? (pinnedFp?.toLowerCase() || null);
}

/** peer-keys.json 里的钉住记录（bridge 是唯一写者；这里只读，给 manager 与 doctor 用） */
export async function readPeerPins(): Promise<Record<string, PinnedPeerKey>> {
  const file = await readJsonLenient<{ peers?: Record<string, PinnedPeerKey> }>(join(STATE_DIR, "peer-keys.json"), {}, { who: "peer-keys" });
  return file.peers ?? {};
}

/** 合并判定（lib/peers.ts isSameRedeemer / isSameInviter）用：每条记录现在的期望指纹，没有返回 null */
export async function peerAnchorOf(): Promise<(p: HttpPeer) => string | null> {
  const pins = await readPeerPins();
  return (p) => expectedPeerFp(p, currentPin(pins[p.name], p)?.fingerprint);
}

/** once：验签通过的非 GET/HEAD 请求要在限速之后再过一次防重放（bridge/api-auth.ts） */
export type PeerSigVerdict = { allow: true; legacy: boolean; once?: { sig: string; ts: string } } | { allow: false; reason: string };

/**
 * 验签结果 → 放不放行。有期望指纹（anchored）时只认 ok；没有时截止日前一律放行（legacy，调用方告警），
 * 截止日后按 unanchored 拒——那时还没签过名的 peer 要重新邀请。
 */
export function peerSigVerdict(result: string, anchored: boolean, now: number, deadline?: string): PeerSigVerdict {
  if (anchored) return result === "ok" ? { allow: true, legacy: false } : { allow: false, reason: result };
  if (result === "ok") return { allow: true, legacy: false };
  return now < Date.parse(deadline ?? currentLegacyDeadline(now)) ? { allow: true, legacy: true } : { allow: false, reason: "unanchored" };
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

/**
 * 对方回 401/403 时给调用方的一句提示。code=peer_signature 是「对方不认本机的签名」，重新握手（换 token）解决不了，
 * 按 reason 分开说；其余仍是 token / scope 问题。body 是对方回的 JSON（可能为空）。
 */
export function peerAuthHint(raw: unknown): string {
  const body = (raw && typeof raw === "object" ? raw : {}) as { code?: unknown; reason?: unknown };
  if (body.code !== "peer_signature") return "token 无效或已被对方 revoke——联系对方确认，或重新握手";
  if (body.reason === "replay") return "这条请求被对方当成了重放（同一个签名用了两次）——不要原样重发，稍后重新发一条即可";
  if (body.reason === "before_start") return "对方 bridge 刚重启，这条请求的签名时间早于它启动（本机时钟比对方慢）——先校准本机时间，再重新发";
  if (body.reason === "stale") return "两台机器时钟差超过 5 分钟，签名被判过期——先校准两边的系统时间";
  return "对方认不出本机的签名钥匙（本机重装过，或对方记下的指纹不是本机）——请对方删掉这个 peer 后重新给你发一张邀请";
}
