/**
 * 入站 peer 请求「是不是那个 peer 本人」的判定（纯逻辑；接线在 bridge/peer-signature.ts 与 bridge/relay-link.ts，
 * 单测 tests/peer-trust.test.ts）。peer token 只是 Bearer，经中继或任何反代都可能被旁人看到，
 * 所以身份最终落在实例签名上：签名钥匙的指纹必须等于本机为这个 peer 记下的指纹（期望指纹）。
 *   期望指纹 = peers.json 的 fp（邀请 / 兑换时记下）→ relay://<fp> 基址里的 fp → peer-keys.json 钉住的指纹；
 *   三样都没有的老 peer 截止日前放行并告警，之后同样拒绝。
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { MAX_SKEW_S, SIG_HEADERS } from "./instance-key.js";
import { REPO_ROOT } from "./repo-root.js";
import { inviteExpired, readPeers, relayPeerFingerprint, type HttpPeer, type PendingInvite } from "./peers.js";
import type { PinnedPeerKey } from "./peer-keys.js";
import { STATE_DIR } from "./paths.js";
import { readJsonLenient } from "./state-file.js";
import { findByBearer, readPrincipals } from "./principals.js";
import { repoEnvVar } from "./env-file.js";
import { isRedeemRequest } from "./relay-protocol.js";

/** 条目上限：只收验签通过的请求（authApi 那份还在限速之后），满了拒新请求而不是挤掉旧的 */
const REPLAY_MAX_ENTRIES = 50_000;
/** 每个 peer 的条目上限：限速后一个 peer 在签名有效期内最多约 1200 条，超了只拒它自己，别的 peer 不受影响 */
const REPLAY_MAX_PER_PEER = 2_000;
/** 本进程启动时刻（秒）：缓存不落盘，重启前签出的非 GET 请求一律当重放 */
const PROCESS_START_S = Math.floor(Date.now() / 1000);

/** seen 的结果：false = 第一次见；replay = 见过；before_start = 签名时间早于本进程启动；full = 这个 peer（或整体）满了，拒这一条 */
export type ReplayVerdict = false | "replay" | "before_start" | "full";

/**
 * 非幂等方法的签名在有效期内只认一次（签名含时间戳与正文哈希，同一签名 = 同一请求）。键是解码后的签名字节，
 * 不是原串——同一签名不能靠换一种 base64url 写法变成新键（验签那边也只认规范写法，两头都防）。
 * 条目留到签名本身过期（签名时间 + MAX_SKEW_S），之后验签就会判 stale，不必再记。
 * 满了默认 fail-closed：拒新请求并告警，绝不挤掉还没过期的条目（挤掉等于放行那条签名的重放）。
 * evict = true 的缓存满了挤掉最旧的一条：只给另有兜底、丢一条也不会放行重放的用途（兑换帧、GET 计次，见各自调用处）。
 * 按 peer 分桶计数：一个 peer 灌满只拒它自己。中继 peer 帧（bridge/relay-inbound.ts，按发件人指纹分）与
 * authApi（bridge/peer-signature.ts，按 peer 名分）各持一份：经中继来的请求两份各见一次不算重放，
 * 截获后换一条路重放则会撞上 authApi 那份。
 */
export class ReplayCache {
  private readonly entries = new Map<string, { exp: number; peer: string; n: number }>();
  private readonly perPeer = new Map<string, number>();
  private nextSweep = 0;
  private warnedAt = -Infinity;
  constructor(
    private readonly max = REPLAY_MAX_ENTRIES,
    private readonly startS = PROCESS_START_S,
    private readonly validMs = (MAX_SKEW_S + 1) * 1000,
    private readonly maxPerPeer = REPLAY_MAX_PER_PEER,
    private readonly evict = false,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  seen(sig: string, ts: string, now: number, peer: string): ReplayVerdict {
    const n = this.hits(sig, ts, now, peer);
    return typeof n === "number" ? n > 1 && "replay" : n;
  }

  /** 这个签名在有效期内是第几次出现（1 = 第一次）；before_start / full 同 seen */
  hits(sig: string, ts: string, now: number, peer: string): number | "before_start" | "full" {
    const t = Number(ts);
    if (!(t >= this.startS)) return "before_start"; // 那之前见过什么已无从得知
    const key = Buffer.from(sig, "base64url").toString("hex");
    const hit = this.entries.get(key);
    if (hit && hit.exp >= now) return ++hit.n;
    if (now >= this.nextSweep) this.sweep(now);
    const peerFull = (this.perPeer.get(peer) ?? 0) >= this.maxPerPeer;
    if (peerFull || this.entries.size >= this.max) {
      if (!this.evict) {
        if (now - this.warnedAt > 60_000) console.warn(`⚠️ [peer-sig] 防重放缓存已满（${peer} 或整体），拒绝新的非 GET 请求直到有条目过期`);
        this.warnedAt = now;
        return "full";
      }
      this.dropOldest(peerFull ? peer : null);
    }
    this.entries.set(key, { exp: t * 1000 + this.validMs, peer, n: 1 });
    this.perPeer.set(peer, (this.perPeer.get(peer) ?? 0) + 1);
    return 1;
  }

  /** 挤掉最早记下的一条（peer 给了就只在它自己的条目里挑） */
  private dropOldest(peer: string | null): void {
    for (const [k, e] of this.entries) {
      if (peer !== null && e.peer !== peer) continue;
      this.remove(k, e);
      return;
    }
  }

  private remove(k: string, e: { peer: string }): void {
    this.entries.delete(k);
    const n = (this.perPeer.get(e.peer) ?? 1) - 1;
    if (n > 0) this.perPeer.set(e.peer, n);
    else this.perPeer.delete(e.peer);
  }

  /** 删掉签名已过期的条目；一秒最多扫一次（满了也不例外，灌满的人拖不慢判定） */
  private sweep(now: number): void {
    this.nextSweep = now + 1000;
    for (const [k, e] of this.entries) if (e.exp < now) this.remove(k, e);
  }
}

/** 没有任何期望指纹的老 peer（签名功能之前建立、又从没签过名）默认放行到这一刻；doctor 会报还剩几个 */
export const LEGACY_PEER_DEADLINE = "2026-11-01T00:00:00Z";

/** 实际截止日：环境变量 / .env 的 PEER_LEGACY_DEADLINE（任何 Date.parse 认得的日期）可以提前或推后；解析不了用默认 */
export function legacyPeerDeadline(raw = repoEnvVar("PEER_LEGACY_DEADLINE").trim()): string {
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : LEGACY_PEER_DEADLINE;
}

let deadlineMemo: { mtime: number; value: string } | null = null;
/** 验签路径用：.env 读一次缓存起来，文件改过（mtime 变了）才重读 */
function currentLegacyDeadline(): string {
  let mtime = -1;
  try {
    mtime = statSync(join(REPO_ROOT, ".env")).mtimeMs;
  } catch {
    mtime = -1; // 没有 .env：只看环境变量与默认值，缓存照样有效
  }
  if (deadlineMemo?.mtime !== mtime) deadlineMemo = { mtime, value: legacyPeerDeadline() };
  return deadlineMemo.value;
}

/** 截止日还没到：没有期望指纹的老 peer 仍放行、加入邀请时仍可按自报实例 id 合并 */
export function legacyStillOpen(now = Date.now()): boolean {
  return now < Date.parse(currentLegacyDeadline());
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

/** once：验签通过的请求在扣限速之前再过一次防重放（bridge/peer-signature.ts peerReplayVerdict；GET/HEAD 只计次） */
export type PeerOnce = { sig: string; ts: string; idempotent: boolean };
export type PeerSigVerdict = { allow: true; legacy: boolean; once?: PeerOnce } | { allow: false; reason: string };

/**
 * 验签结果 → 放不放行。有期望指纹（anchored）时只认 ok；没有时截止日前一律放行（签名对得上就由调用方钉住，
 * 不签名的算 legacy、调用方告警），截止日后一律按 unanchored 拒——连签名对得上的也拒：那时还没钉住的 peer，
 * 谁先拿着 token 签名谁就会被钉成它，只能重新邀请。
 */
export function peerSigVerdict(result: string, anchored: boolean, now: number, deadline?: string): PeerSigVerdict {
  if (anchored) return result === "ok" ? { allow: true, legacy: false } : { allow: false, reason: result };
  if (now >= Date.parse(deadline ?? currentLegacyDeadline())) return { allow: false, reason: "unanchored" };
  return { allow: true, legacy: result !== "ok" };
}

/**
 * 兑换前的邀请 token（principal.peer = invite:<邀请 id>）：邀请必须还在、没过期（用时就判，不等清扫），
 * 而且只许 GET/HEAD——加入前的预览只读 agent 列表，正式调用要等兑换后换成对方的名字、验签。
 */
export function inviteTokenVerdict(method: string, inviteId: string, invites: PendingInvite[], now: number): PeerSigVerdict {
  const inv = invites.find((i) => i.id === inviteId);
  if (!inv || inviteExpired(inv, now)) return { allow: false, reason: "invite_expired" };
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" ? { allow: true, legacy: false } : { allow: false, reason: "invite_read_only" };
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
  /** 这个联系人记下的完整公钥（签名兑换 / 持钥证明得来）；没记返回 null，只按指纹认 */
  keyOf?(fp: string): string | null;
  /** 这个 Bearer 属于哪个 peer、那个 peer 的期望指纹；不是有效 peer token 返回 null */
  bearerOwner(secret: string): { peer: string; fp: string | null } | null;
}

/**
 * 经中继进来、验签已过的 peer 请求还要满足：兑换邀请之外，from 必须是本机联系人、必须带 peer token（不认浏览器凭据），
 * 记了完整公钥的联系人签名钥匙必须就是那把（指纹只有 64 位）；token 的主人的期望指纹必须就是 from——
 * 签名只证明「from 本人发的」，不证明 token 是他的。返回拒绝原因或 null。
 */
export function relayPeerRefusal(from: string, req: { method: string; path: string; headers: Record<string, string> }, view: RelayPeerView): string | null {
  const redeem = isRedeemRequest(req.method, req.path);
  if (!redeem && !view.contacts.has(from)) return "sender is not a contact of this instance";
  const recorded = view.keyOf?.(from);
  if (recorded && req.headers[SIG_HEADERS.key] !== recorded) return "signing key is not the one recorded for this contact";
  const secret = frameBearer(req.method, req.path, req.headers);
  if (!secret) return redeem ? null : "peer requests must carry the peer's token";
  const owner = view.bearerOwner(secret);
  if (!owner) return "token is not a peer token of this instance";
  return owner.fp === from ? null : "token does not belong to the sender";
}

/** 现读 peers.json + principals.json 拼出 RelayPeerView（每个中继 peer 请求一次，两个文件都很小） */
export async function loadRelayPeerView(): Promise<RelayPeerView> {
  const [peers, file] = await Promise.all([readPeers(), readPrincipals()]);
  const live = (peers.httpPeers ?? []).filter((p) => !p.disabled);
  const fpOf = new Map(live.map((p) => [p.name, recordPeerFp(p)]));
  const keys = new Map(live.filter((p) => p.publicKey).map((p) => [recordPeerFp(p), p.publicKey!]));
  return {
    contacts: new Set(live.map(recordPeerFp).filter((fp): fp is string => !!fp)),
    keyOf: (fp) => keys.get(fp) ?? null,
    bearerOwner: (secret) => {
      const p = findByBearer(file, secret);
      return p?.peer ? { peer: p.peer, fp: fpOf.get(p.peer) ?? null } : null;
    },
  };
}
