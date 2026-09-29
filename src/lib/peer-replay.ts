import { MAX_SKEW_S } from "./instance-key.js";

/** 条目上限：只收验签通过的请求（authApi 在限速通过后才记），满了拒新请求而不是挤掉旧的 */
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
 * evict = true 的缓存满了挤掉最旧的一条：只给另有兜底、丢一条也不会放行重放的用途（兑换帧，见各自调用处）。
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

  seen(sig: string, ts: string, now: number, peer: string, record = true): ReplayVerdict {
    const n = this.hits(sig, ts, now, peer, record);
    return typeof n === "number" ? n > 1 && "replay" : n;
  }

  /** 这个签名在有效期内是第几次出现（1 = 第一次）；before_start / full 同 seen */
  hits(sig: string, ts: string, now: number, peer: string, record = true): number | "before_start" | "full" {
    const t = Number(ts);
    if (!(t >= this.startS)) return "before_start"; // 那之前见过什么已无从得知
    const key = Buffer.from(sig, "base64url").toString("hex");
    const hit = this.entries.get(key);
    if (hit && hit.exp >= now) return record ? ++hit.n : hit.n + 1;
    if (now >= this.nextSweep) this.sweep(now);
    const peerFull = (this.perPeer.get(peer) ?? 0) >= this.maxPerPeer;
    if (peerFull || this.entries.size >= this.max) {
      if (!this.evict) {
        if (now - this.warnedAt > 60_000) console.warn(`⚠️ [peer-sig] 防重放缓存已满（${peer} 或整体），拒绝新的请求直到有条目过期`);
        this.warnedAt = now;
        return "full";
      }
      if (record) this.dropOldest(peerFull ? peer : null);
    }
    if (!record) return 1;
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

