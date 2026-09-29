/**
 * peer E2E 的收方（docs/relay/e2e-design.md §4.1.4、§5.1）：hello 建会话，记录流解开后交给原来的 API 路由。
 * 处理顺序写死，测试按同样的顺序钉（tests/peer-e2e.test.ts）：
 *   1 找会话，没有 → 明文 401 e2e_session；2 解密全部记录，失败 → 明文 400，窗口不动；
 *   3 同一段同步代码里：会话还是它、peer 还在、窗口「查并记」（重放 → 409）、用量没超；
 *   4 这个 rid 唯一一次加密响应；5 内层是普通 Request，路由错误写在加密后的第 0 条里。
 * 依赖全部注入：peer 查询必须同步（第 3 步不许有 await），外层签名的校验由调用方给（它持有重放缓存）。
 */
import { concat, utf8 } from "./e2e/encoding.js";
import { respond } from "./e2e/handshake.js";
import { DIR_REQ, DIR_RES, openAll, RecordError, sealMessage } from "./e2e/records.js";
import { compareE2eKey, verifyE2eKey, type MachineE2eKey, type SignedE2eKey } from "./e2e-machine-key.js";
import type { SessionTable } from "./peer-e2e-sessions.js";
import {
  E2E_CONTENT_TYPE, E2E_HELLO_PATH, E2E_SESSION_TTL_S, e2eError, encodeHelloReply, encodeResponseHead,
  parseHello, parseInnerHead, parseRecordPath, PEER_E2E_LABEL,
} from "./peer-e2e-wire.js";

/** 一个用密钥建立的 peer（peers.json 里带 e2e 字段的记录） */
export interface E2ePeer {
  name: string;
  fp: string;
  /** 带外交换时钉住的 Ed25519 身份公钥 */
  idk: string;
  /** 钉住的签名 E2E 公钥块 */
  ek: SignedE2eKey;
}

export interface ServeDeps {
  myFp: string;
  machine: () => Promise<MachineE2eKey | null>;
  mySignedKey: () => Promise<SignedE2eKey | null>;
  sessions: SessionTable;
  /** 同步：按指纹找 peer（已删除 / 禁用 / 没有密钥的都返回 null） */
  peerByFp: (fp: string) => E2ePeer | null;
  /** 对方 hello 里带来版本更高、验过签的块：落盘替换 */
  pinNewer: (peer: E2ePeer, key: SignedE2eKey) => Promise<void>;
  /** 外层请求的实例签名是否出自这把身份公钥，且不是重放（调用方持有重放缓存） */
  outerSigned: (req: Request, body: Uint8Array, idk: string) => boolean;
  /** 解开后的内层请求交给原路由；peerFp 给路由核对「token 的主人 = 会话的发起方」 */
  dispatch: (inner: Request, peerFp: string) => Promise<Response>;
}

/**
 * 外层已认出的发件人指纹：中继帧取中继入站验过签的 from（request-context 的 relayFrom），直连取 bridge/peer-e2e-route.ts
 * 验过的外层签名钥匙。有值时 hello 的 from、记录所属会话的发起方都必须是它；undefined 只在进程内单测
 */
export interface ServeContext {
  sender?: string;
}

const HELLO_MAX = 4096;
const BODY_MAX = 2 * 1024 * 1024;

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const b = new Uint8Array(await req.arrayBuffer());
  return b.length > max ? null : b;
}

/** 不是 /api/v1/e2e/* → null（交还给原路由） */
export async function serveE2e(req: Request, path: string, d: ServeDeps, ctx: ServeContext): Promise<Response | null> {
  if (!path.startsWith("/api/v1/e2e/")) return null;
  if (req.method !== "POST") return e2eError(405, "e2e_method");
  if (path === E2E_HELLO_PATH) return hello(req, d, ctx);
  const rp = parseRecordPath(path);
  return rp ? record(req, rp.sid, rp.rid, d, ctx) : e2eError(404, "e2e_path");
}

async function hello(req: Request, d: ServeDeps, ctx: ServeContext): Promise<Response> {
  const body = await readCapped(req, HELLO_MAX);
  if (!body) return e2eError(413, "e2e_too_large");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return e2eError(400, "e2e_bad_hello"); // 不是 JSON：和形状不对同一种回答
  }
  const h = parseHello(raw);
  if ("error" in h) return e2eError(400, h.error);
  if (h.to !== d.myFp) return e2eError(400, "e2e_wrong_target");
  if (ctx.sender !== undefined && ctx.sender !== h.from) return e2eError(403, "e2e_peer_mismatch");
  const peer = d.peerByFp(h.from);
  if (!peer) return e2eError(403, "e2e_unknown_peer");
  if (!d.outerSigned(req, body, peer.idk)) return e2eError(401, "e2e_signature");
  const theirs = await verifyE2eKey(peer.idk, h.key);
  if (!theirs) return e2eError(400, "e2e_bad_key");
  const cmp = compareE2eKey(peer.ek, theirs);
  if (cmp === "stale") return e2eError(400, "e2e_key_stale");
  if (cmp === "newer") await d.pinNewer(peer, theirs);
  const [m, mine] = await Promise.all([d.machine(), d.mySignedKey()]);
  if (!m || !mine) return e2eError(503, "e2e_unavailable");
  const r = await respond({ fp: d.myFp, devId: utf8(h.from), label: PEER_E2E_LABEL }, { local: m.pair, remoteStatic: theirs.pubBytes, ce: h.ce }).catch(() => null); // ce 不是合法点
  if (!r) return e2eError(400, "e2e_bad_hello");
  d.sessions.add(h.from, r.sid, r.keys);
  return new Response(encodeHelloReply({ be: r.be, sid: r.sid, ttl: E2E_SESSION_TTL_S, confirm: r.confirm, key: mine }), {
    headers: { "content-type": "application/json" },
  });
}

async function record(req: Request, sid: Uint8Array, rid: bigint, d: ServeDeps, ctx: ServeContext): Promise<Response> {
  // 1. 找会话
  const s = d.sessions.get(sid);
  if (!s) return e2eError(401, "e2e_session");
  if (ctx.sender !== undefined && ctx.sender !== s.peerFp) return e2eError(403, "e2e_peer_mismatch");
  const body = await readCapped(req, BODY_MAX);
  if (!body) return e2eError(413, "e2e_too_large");
  // 2. 解密全部记录（验 tag、要求见到 final）；失败窗口不动，伪造的大 rid 推不动窗口
  let parts: Uint8Array[];
  try {
    parts = await openAll({ key: s.keys.c2b, sid, dir: DIR_REQ, rid, label: PEER_E2E_LABEL }, body);
  } catch (e) {
    if (e instanceof RecordError) return e2eError(400, "e2e_record");
    throw e;
  }
  // 3. 从这里到 dispatch 之前不许有 await：会话还是它、peer 还在、窗口查并记、用量
  if (d.sessions.get(sid) !== s || !d.peerByFp(s.peerFp)) return e2eError(401, "e2e_session");
  if (!s.window.accept(rid)) return e2eError(409, "e2e_replay");
  if (!d.sessions.use(s)) return e2eError(401, "e2e_session");
  // 4、5. 这个 rid 唯一一次加密响应
  const scope = { key: s.keys.b2c, sid, dir: DIR_RES, rid, label: PEER_E2E_LABEL } as const;
  const inner = innerRequest(req, parts);
  const res = inner ? await d.dispatch(inner, s.peerFp) : Response.json({ ok: false, error: "bad inner request" }, { status: 400 });
  const sealed = await sealMessage(scope, utf8(encodeResponseHead(res.status, res.headers)), new Uint8Array(await res.arrayBuffer()));
  return new Response(sealed, { headers: { "content-type": E2E_CONTENT_TYPE } });
}

/** 第 0 条是 {method, path, headers}，其余拼成正文；外层的 URL 只借 origin，路径完全来自内层 */
function innerRequest(outer: Request, parts: Uint8Array[]): Request | null {
  let head;
  try {
    head = parseInnerHead(JSON.parse(new TextDecoder().decode(parts[0])));
  } catch {
    return null; // 第 0 条不是 JSON：按内层请求无效回加密的 400
  }
  if (!head) return null;
  const body = concat(...parts.slice(1));
  const hasBody = head.method !== "GET" && head.method !== "HEAD";
  if (!hasBody && body.length) return null;
  return new Request(new URL(head.path, new URL(outer.url).origin).href, { method: head.method, headers: head.headers, ...(hasBody ? { body } : {}) });
}
