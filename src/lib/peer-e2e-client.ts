/**
 * peer E2E 的发起方（docs/relay/e2e-design.md §5.1）：对一个用密钥建立的 peer，所有请求都包进会话发出去。
 * 按「中继是攻击者」写，任何一处都不回退明文：
 *   - 只有明文 401 e2e_session 会触发重新握手并重发一次；重发用同一份内层字节（同一个内层签名）。
 *     这个 401 中继也能伪造：原请求其实已被处理时，收方的内层重放缓存会认出同一个签名、拒掉重发，不会处理两次。
 *   - 其它任何状态、解不开、confirm 对不上、对方公钥块旧了 → 抛 E2eError，由调用方报错，绝不换明文重试。
 * 传输（拼基址、外层实例签名、走中继或直连）由调用方注入，所以这里能在测试里配一个作恶的中继来钉住这些规则。
 */
import { concat, utf8 } from "./e2e/encoding.js";
import { finish, type SessionKeys } from "./e2e/handshake.js";
import { generateEcdh } from "./e2e/primitives.js";
import { DIR_REQ, DIR_RES, openAll, sealMessage } from "./e2e/records.js";
import { remoteCode } from "./remote-text.js";
import { compareE2eKey, verifyE2eKey, type MachineE2eKey, type SignedE2eKey } from "./e2e-machine-key.js";
import type { E2ePeer } from "./peer-e2e-serve.js";
import {
  E2E_CONTENT_TYPE, E2E_HELLO_PATH, E2E_SESSION_TTL_S, encodeHello, encodeInnerHead, INNER_REPLAY_REASONS, parseHelloReply, parseResponseHead,
  PEER_E2E_LABEL, recordPath, E2E_BODY_MAX,
} from "./peer-e2e-wire.js";

export class E2eError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "E2eError";
  }
}

export interface ClientDeps {
  myFp: string;
  /** 现在钉着的对方记录（每次握手现读，轮换后能拿到新块） */
  peer: () => E2ePeer;
  machine: () => Promise<MachineE2eKey | null>;
  mySignedKey: () => Promise<SignedE2eKey | null>;
  pinNewer: (peer: E2ePeer, key: SignedE2eKey) => Promise<void>;
  /** 外层传输：path 是 /api/v1/e2e/…，调用方负责基址、外层实例签名和中继 / 直连 */
  post: (path: string, body: Uint8Array, contentType: string) => Promise<Response>;
  now?: () => number;
}

interface ClientSession {
  sid: Uint8Array;
  keys: SessionKeys;
  nextRid: bigint;
  expiresAt: number;
}

const RID_CAP = 1n << 31n;
const TTL_MIN_S = 60;
/** 离对方报的到期还有这么久就提前换会话，免得请求在路上撞上到期 */
const EXPIRY_MARGIN_MS = 60_000;
const NO_BODY_STATUS = new Set([204, 205, 304]);
const RETRY = Symbol("retry");

async function codeOf(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { code?: unknown } | null; // 错误体不是 JSON（中继或老版本的错误页）：按状态码报
  return remoteCode(j?.code, `e2e_http_${res.status}`); // 明文错误体中继能伪造（lib/remote-text.ts）
}

/**
 * 重握手后原样重发的那一次才调：内层响应已认证，reason 可信，对方重启过（没处理，可重发）与已处理过（不能重发）分开报，
 * 调用方把这句话原样回给发消息的一方。第一次发就被拒的不走这里：那是时钟慢了、同一秒发了两条一样的，照原响应交给 peerAuthHint
 */
function throwIfInnerReplay(payload: Uint8Array): void {
  let j: { code?: unknown; reason?: unknown } | null = null;
  try {
    j = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return; // 不是 JSON 的 401：不是验签拒绝，原样交给调用方
  }
  if (j?.code !== "peer_signature") return;
  if (j.reason === INNER_REPLAY_REASONS.restarted) throw new E2eError("e2e_peer_restarted", "对方重启过，请重发");
  if (j.reason === INNER_REPLAY_REASONS.duplicate) throw new E2eError("e2e_duplicate", "对方已经处理过这条（回复在路上丢了），不要重发");
}

export class PeerE2eClient {
  private session: ClientSession | null = null;
  private pending: Promise<ClientSession> | null = null;
  private readonly now: () => number;
  constructor(private readonly d: ClientDeps) {
    this.now = d.now ?? Date.now;
  }

  /** 发一个内层请求；返回的是解开后的内层响应 */
  async fetch(method: string, path: string, headers: Headers | Record<string, string>, body: Uint8Array = new Uint8Array(0)): Promise<Response> {
    const head = utf8(encodeInnerHead(method, path, headers));
    const first = await this.send(head, body, false);
    return first === RETRY ? ((await this.send(head, body, true)) as Response) : first;
  }

  /** 丢掉当前会话（peer 被删除、换钥匙时由调用方调） */
  reset(): void {
    this.session = null;
  }

  private async send(head: Uint8Array, body: Uint8Array, isRetry: boolean): Promise<Response | typeof RETRY> {
    const s = await this.ensure();
    const rid = s.nextRid++;
    const stream = await sealMessage({ key: s.keys.c2b, sid: s.sid, dir: DIR_REQ, rid, label: PEER_E2E_LABEL }, head, body);
    // 跳过的 rid 不碍事：收方的窗口只拒重复与过旧的
    if (stream.length > E2E_BODY_MAX) throw new E2eError("e2e_too_large", `request is ${stream.length} bytes, over the peer's ${E2E_BODY_MAX}-byte limit; not sent`);
    const res = await this.d.post(recordPath(s.sid, rid), stream, E2E_CONTENT_TYPE);
    if (res.status !== 200 || res.headers.get("content-type") !== E2E_CONTENT_TYPE) {
      const code = await codeOf(res);
      if (res.status !== 401 || code !== "e2e_session") throw new E2eError(code, "peer did not answer with a record stream");
      if (this.session === s) this.session = null;
      if (isRetry) throw new E2eError(code, "peer rejected a fresh session");
      return RETRY;
    }
    let parts: Uint8Array[];
    try {
      parts = await openAll({ key: s.keys.b2c, sid: s.sid, dir: DIR_RES, rid, label: PEER_E2E_LABEL }, new Uint8Array(await res.arrayBuffer()));
    } catch {
      throw new E2eError("e2e_record", "response failed authentication"); // 不区分截断还是被改：都说明路上有人动过
    }
    let rh;
    try {
      rh = parseResponseHead(JSON.parse(new TextDecoder().decode(parts[0])));
    } catch {
      rh = null; // 解得开却不是 JSON：对方实现有问题，按坏响应处理
    }
    if (!rh) throw new E2eError("e2e_record", "malformed response head");
    const payload = NO_BODY_STATUS.has(rh.status) ? null : concat(...parts.slice(1));
    if (isRetry && rh.status === 401 && payload) throwIfInnerReplay(payload);
    return new Response(payload, { status: rh.status, headers: rh.headers });
  }

  private ensure(): Promise<ClientSession> {
    const s = this.session;
    if (s && s.expiresAt > this.now() && s.nextRid < RID_CAP) return Promise.resolve(s);
    this.session = null;
    this.pending ??= this.handshake().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async handshake(): Promise<ClientSession> {
    const peer = this.d.peer();
    const [m, mine] = await Promise.all([this.d.machine(), this.d.mySignedKey()]);
    if (!m || !mine) throw new E2eError("e2e_unavailable", "local E2E key unavailable");
    const eph = await generateEcdh();
    const res = await this.d.post(E2E_HELLO_PATH, utf8(encodeHello({ from: this.d.myFp, to: peer.fp, ce: eph.pub, key: mine })), "application/json");
    if (res.status !== 200) throw new E2eError(await codeOf(res), "handshake refused");
    const r = parseHelloReply(await res.json().catch(() => null)); // 不是 JSON 就是形状不对，下一行统一抛 e2e_bad_reply
    if (!r) throw new E2eError("e2e_bad_reply", "malformed handshake reply");
    const theirs = await verifyE2eKey(peer.idk, r.key);
    if (!theirs) throw new E2eError("e2e_bad_key", "peer key block not signed by the pinned identity");
    const cmp = compareE2eKey(peer.ek, theirs);
    if (cmp === "stale") throw new E2eError("e2e_key_stale", "peer presented an older key block");
    const keys = await finish(
      { fp: peer.fp, devId: utf8(this.d.myFp), label: PEER_E2E_LABEL },
      { local: m.pair, ephemeral: eph, remoteStatic: theirs.pubBytes, be: r.be, sid: r.sid, confirm: r.confirm },
    );
    if (!keys) throw new E2eError("e2e_confirm", "handshake confirm mismatch (peer lacks its pinned key, or the reply was tampered)");
    if (cmp === "newer") await this.d.pinNewer(peer, theirs); // confirm 过了才钉：证明对面确实持有这把新钥匙
    const ttl = Math.min(Math.max(r.ttl, TTL_MIN_S), E2E_SESSION_TTL_S); // ttl 不在 th 里，中继能改：夹住，最多只影响换会话的频率
    const s = { sid: r.sid, keys, nextRid: 1n, expiresAt: this.now() + ttl * 1000 - EXPIRY_MARGIN_MS };
    this.session = s;
    return s;
  }
}
