/**
 * 跨实例 Chat（talk）协议 v1 的纯函数参考实现：入站帧校验、房间规则、签名回执。只有校验和签名串，没有任何传输代码——
 * 传输（入口、outbox、重投）在二期写；这里先把 docs/talk/protocol.md 的规则钉死，tests/talk-protocol.test.ts 是测试向量。
 * 关键点：origin 永远是按 peer 记录现算的期望指纹，不取帧里的任何字段；dm 的房间 id 由接收方自己重算；
 * 回执自带公钥，发送方先核「公钥指纹 = 对方期望指纹」再验签，两步都过才出队（中继伪造不了 200）。
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { isPublicKey, keyFingerprint } from "./instance-key.js";
import { FP_RE } from "./relay-protocol.js";
import { cleanName } from "./talk-people.js";
import { dmRoomId, memberKey } from "./talk-rooms.js";
import { TALK_MSG_ID_RE, THREAD_ID_RE } from "./talk-schema.js";

const TALK_BODY_MAX_BYTES = 2 * 1024 * 1024;
const TALK_IMAGE_MAX_BYTES = 1024 * 1024;
const TEXT_MAX = 8000;
const REFS_MAX = 5;
const ATTS_MAX = 9;
const THREAD_MEMBERS_MAX = 20;
/** 远端 principal：≤ 64 字符、只许这几类字符，不合格整条拒收（它会进成员键和 people.id） */
const REMOTE_PRINCIPAL_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REF_KINDS = new Set(["message", "task", "ask", "doc"]);
const SHA_RE = /^[0-9a-f]{64}$/;

interface TalkFrame {
  v: 1;
  type: "chat";
  id: string;
  room: { creatorFp: string; id: string; kind: "dm" | "thread" };
  to?: string;
  members?: string[];
  author: { principal: string; name: string };
  text: string;
  createdAt: string;
  refs: { kind: string; title: string }[];
  atts: { sha256: string; mime: string; bytes: number; inline: string }[];
}

export interface InboundContext {
  /** 按 peer 记录现算的期望指纹（算不出 = legacy，调用方在更早一步就拒了） */
  origin: string;
  selfFp: string;
  /** 请求正文字节数（验签之前就量好） */
  bodyBytes: number;
  /** 本机这个 principal 存在并开放了 chat */
  openToChat: (principal: string) => boolean;
}

export type InboundCheck =
  | { ok: true; frame: TalkFrame; room: { creatorFp: string; id: string }; authorKey: string; claimedName: string; localMembers: string[]; mustBeMember: boolean }
  | { ok: false; status: 400 | 413; error: string };

const bad = (error: string): InboundCheck => ({ ok: false, status: 400, error });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function checkAtts(raw: unknown): TalkFrame["atts"] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ATTS_MAX) return `atts must be an array of at most ${ATTS_MAX}`;
  const out: TalkFrame["atts"] = [];
  for (const a of raw) {
    if (!isObj(a) || typeof a.sha256 !== "string" || !SHA_RE.test(a.sha256) || typeof a.mime !== "string" || !MIMES.has(a.mime)) return "att needs sha256 and a png / jpeg / webp mime";
    if (typeof a.inline !== "string" || typeof a.bytes !== "number") return "att needs inline base64 and bytes";
    const buf = Buffer.from(a.inline, "base64");
    if (buf.length !== a.bytes || buf.length > TALK_IMAGE_MAX_BYTES) return `att must be at most ${TALK_IMAGE_MAX_BYTES} bytes and match its declared size`;
    if (createHash("sha256").update(buf).digest("hex") !== a.sha256) return "att sha256 mismatch";
    out.push({ sha256: a.sha256, mime: a.mime, bytes: a.bytes, inline: a.inline });
  }
  return out;
}

function checkRefs(raw: unknown): TalkFrame["refs"] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > REFS_MAX) return `refs must be an array of at most ${REFS_MAX}`;
  const out: TalkFrame["refs"] = [];
  for (const r of raw) {
    // 引用只带 kind 和标题，不带 id：对方点不开我方的东西（台账读门拒 peer）
    if (!isObj(r) || typeof r.kind !== "string" || !REF_KINDS.has(r.kind) || typeof r.title !== "string" || r.title.length > 200) return "ref needs kind and a title of at most 200 chars";
    out.push({ kind: r.kind, title: r.title });
  }
  return out;
}

/**
 * 房间规则：dm 接收方自己重算 id（不采信帧里的）；thread 只收「对方建的」（带 members）或「我方建的且对方是成员」（后者要查库，
 * 这里只标 mustBeMember，调用方判）。对方建的 thread 本机只有列在 members 里、且开放了 chat 的 principal 看得见。
 */
function checkRoom(f: Record<string, unknown>, ctx: InboundContext, authorKey: string): { room: { creatorFp: string; id: string }; localMembers: string[]; mustBeMember: boolean } | string {
  const room = f.room;
  if (!isObj(room) || typeof room.id !== "string" || typeof room.creatorFp !== "string") return "room needs creatorFp and id";
  if (room.kind === "dm") {
    if (room.creatorFp !== "") return "dm creatorFp must be empty";
    if (typeof f.to !== "string" || !REMOTE_PRINCIPAL_RE.test(f.to) || !ctx.openToChat(f.to)) return "dm recipient is not open to chat here";
    const mine = memberKey(ctx.selfFp, f.to);
    return { room: { creatorFp: "", id: dmRoomId(authorKey, mine) }, localMembers: [mine], mustBeMember: false };
  }
  if (room.kind !== "thread" || !THREAD_ID_RE.test(room.id)) return "room kind must be dm or thread";
  const creator = room.creatorFp.toLowerCase();
  if (creator === ctx.selfFp) return { room: { creatorFp: creator, id: room.id }, localMembers: [], mustBeMember: true };
  if (creator !== ctx.origin) return "thread must be created by the sender or by this instance";
  const members = f.members;
  if (!Array.isArray(members) || members.length < 2 || members.length > THREAD_MEMBERS_MAX) return `thread from the sender needs 2..${THREAD_MEMBERS_MAX} members`;
  const keys = [...new Set(members.map(String))];
  const shaped = keys.every((k) => {
    const i = k.indexOf("/");
    return i > 0 && FP_RE.test(k.slice(0, i)) && REMOTE_PRINCIPAL_RE.test(k.slice(i + 1));
  });
  if (!shaped || !keys.includes(authorKey)) return "members must be <fp>/<principal> keys including the author";
  const localMembers = keys.filter((k) => k.startsWith(`${ctx.selfFp}/`) && ctx.openToChat(k.slice(ctx.selfFp.length + 1)));
  if (!localMembers.length) return "no member of this thread is open to chat here";
  return { room: { creatorFp: creator, id: room.id }, localMembers, mustBeMember: false };
}

/** 接收方的入站帧校验（在验签、按 peer 限流之后调）：形状、大小、房间规则。通过后调用方按 (origin, id) INSERT OR IGNORE */
export function checkInboundFrame(raw: unknown, ctx: InboundContext): InboundCheck {
  if (ctx.bodyBytes > TALK_BODY_MAX_BYTES) return { ok: false, status: 413, error: `body must be at most ${TALK_BODY_MAX_BYTES} bytes` };
  if (!isObj(raw) || raw.v !== 1 || raw.type !== "chat") return bad("frame must be {v:1, type:\"chat\"}");
  if (typeof raw.id !== "string" || !TALK_MSG_ID_RE.test(raw.id)) return bad("id must match tm_<uuid>");
  const author = raw.author;
  if (!isObj(author) || typeof author.principal !== "string" || !REMOTE_PRINCIPAL_RE.test(author.principal)) return bad("author.principal must match [A-Za-z0-9:_-]{1,64}");
  const claimedName = cleanName(typeof author.name === "string" ? author.name : "");
  if (typeof raw.text !== "string" || raw.text.length > TEXT_MAX) return bad(`text must be a string of at most ${TEXT_MAX} chars`);
  if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) return bad("createdAt must be an ISO time");
  const refs = checkRefs(raw.refs);
  if (typeof refs === "string") return bad(refs);
  const atts = checkAtts(raw.atts);
  if (typeof atts === "string") return bad(atts);
  if (!raw.text.trim() && !atts.length && !refs.length) return bad("empty message");
  const authorKey = memberKey(ctx.origin, author.principal);
  const room = checkRoom(raw, ctx, authorKey);
  if (typeof room === "string") return bad(room);
  const frame = { ...(raw as unknown as TalkFrame), refs, atts, author: { principal: author.principal, name: claimedName } };
  return { ok: true, frame, authorKey, claimedName, ...room };
}

// ── 签名回执 ──

const TALK_ACK_CONTEXT = "claudestra-talk-ack-v1";

/** 回执签的内容：上下文、消息的 origin 与 id、接收方自己的指纹；offer 类末尾再加转移后的状态（三期） */
export function talkAckMessage(origin: string, id: string, recipientFp: string, state?: string): string {
  return [TALK_ACK_CONTEXT, origin, id, recipientFp, ...(state === undefined ? [] : [state])].join("\n");
}

export interface TalkAck {
  key: string;
  sig: string;
}

export function signTalkAck(privateKey: KeyObject, publicKey: string, msg: string): TalkAck {
  return { key: publicKey, sig: sign(null, Buffer.from(msg, "utf8"), privateKey).toString("base64url") };
}

export type AckVerdict = "ok" | "malformed" | "wrong_key" | "bad_sig";

/**
 * 发送方核回执：先看自带公钥的指纹是不是对方的期望指纹（没钉住公钥也能核），再验签；两步都过才算送达、出队。
 * 签名串里有接收方指纹，别的实例的回执挪不过来；有 origin 与 id，别的消息的回执也挪不过来。
 */
export function verifyTalkAck(ack: unknown, expect: { recipientFp: string; origin: string; id: string; state?: string }): AckVerdict {
  if (!isObj(ack) || !isPublicKey(ack.key) || typeof ack.sig !== "string") return "malformed";
  if (keyFingerprint(ack.key) !== expect.recipientFp) return "wrong_key";
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: ack.key }, format: "jwk" });
    const msg = Buffer.from(talkAckMessage(expect.origin, expect.id, expect.recipientFp, expect.state), "utf8");
    return verify(null, msg, pub, Buffer.from(ack.sig, "base64url")) ? "ok" : "bad_sig";
  } catch {
    return "bad_sig"; // 签名串解不出来和签名对不上是一回事：都不出队
  }
}
