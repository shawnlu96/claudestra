/**
 * 收方的 peer E2E 会话表（docs/relay/e2e-design.md §4.1.3）：只在内存里，bridge 重启即全部作废——
 * 禁止持久化，所以不存在「重放窗口没跟会话一起落盘」。TTL 24 小时或 2^31 个请求，先到为准；
 * 每个发起方最多 16 个会话，超出按最久未用淘汰：重放合法的 hello 只会挤掉这个发起方自己的旧会话，不会无限增长。
 */
import type { SessionKeys } from "./e2e/handshake.js";
import { toB64url } from "./e2e/encoding.js";
import { ReplayWindow } from "./e2e/replay-window.js";

export interface PeerSession {
  sid: Uint8Array;
  /** 发起方身份指纹（hello 里的 from，已按钉住的身份公钥验过签） */
  peerFp: string;
  keys: SessionKeys;
  window: ReplayWindow;
  expiresAt: number;
  lastUsed: number;
  used: number;
}

export interface SessionLimits {
  ttlMs: number;
  perPeer: number;
  maxRequests: number;
}

const DEFAULTS: SessionLimits = { ttlMs: 24 * 3600_000, perPeer: 16, maxRequests: 2 ** 31 };

export class SessionTable {
  private readonly bySid = new Map<string, PeerSession>();
  private readonly limits: SessionLimits;
  constructor(limits: Partial<SessionLimits> = {}, private readonly now: () => number = Date.now) {
    this.limits = { ...DEFAULTS, ...limits };
  }

  add(peerFp: string, sid: Uint8Array, keys: SessionKeys): PeerSession {
    const t = this.now();
    const s: PeerSession = { sid, peerFp, keys, window: new ReplayWindow(), expiresAt: t + this.limits.ttlMs, lastUsed: t, used: 0 };
    const mine = [...this.bySid.entries()].filter(([, x]) => x.peerFp === peerFp).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - this.limits.perPeer + 1))) this.bySid.delete(k);
    this.bySid.set(toB64url(sid), s);
    return s;
  }

  /** 活着的会话；过期的顺手删掉。同步，§4.1.4 第 3 步要在同一段同步代码里再查一次 */
  get(sid: Uint8Array): PeerSession | undefined {
    const k = toB64url(sid);
    const s = this.bySid.get(k);
    if (s && s.expiresAt <= this.now()) {
      this.bySid.delete(k);
      return undefined;
    }
    return s;
  }

  /** 记一次用量；超过上限 → 删掉会话并返回 false（发起方收到 e2e_session 后重新握手） */
  use(s: PeerSession): boolean {
    s.lastUsed = this.now();
    if (++s.used > this.limits.maxRequests) {
      this.bySid.delete(toB64url(s.sid));
      return false;
    }
    return true;
  }

  /** peer 被删除 / 禁用 / 换钥匙：它的会话立即作废 */
  dropPeer(peerFp: string): void {
    for (const [k, s] of this.bySid) if (s.peerFp === peerFp) this.bySid.delete(k);
  }

  get size(): number {
    return this.bySid.size;
  }
}
