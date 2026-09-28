/**
 * Chat 的消息与附件接口（local-api/talk.ts 分发到这里）。读写前都先过 isMember：不是房间成员一律 404（不透露房间存在）。
 * 发消息不进任何 agent 的上下文；@ 只是结构化存 person id，对 owner 的 @ 才推送（推送订阅目前只登记 owner 的设备）。
 */
import { canReadLedger } from "../../lib/devices.js";
import { agentInScope, type Principal, type PrincipalsFile } from "../../lib/principals.js";
import { attPath, attsUsableBy, canReadAtt, getAtt, removeUnreferenced, saveAtt, ATT_MAX_BYTES } from "../../lib/talk-atts.js";
import { deleteMessage, getMessage, insertMessage, listMessages, parseDraft, type TalkMessage, type TalkRef } from "../../lib/talk-messages.js";
import { OWNER_PERSON, personAliases } from "../../lib/talk-people.js";
import { getRoom, isMember, parseRoomKey, type Room } from "../../lib/talk-rooms.js";
import { apiJson } from "../api-respond.js";
import { pushOwnerNotice } from "../push/init.js";
import { nameOf, personOfKey, publishTalk, rememberMe, roomView, talkAttDir, talkDb, talkPrincipals, type Me } from "../talk.js";

const notFound = (): Response => apiJson(404, { ok: false, error: "room not found" });

function roomFor(me: Me, key: string): Room | null {
  const ref = parseRoomKey(key);
  const db = talkDb();
  const room = ref ? getRoom(db, ref) : null;
  return room && isMember(db, room, me.keys) ? room : null;
}

/** 引用卡片打开时的实时校验：查看者现在还有没有权限点开（没有就只显示快照标题） */
function refOpen(p: Principal, r: TalkRef): boolean {
  if (r.kind === "message") return agentInScope(p, r.scope);
  return canReadLedger(p);
}

const canonical = (key: string, me: Me): string => personAliases(talkDb(), personOfKey(key, me.fp))[0];

function messageView(m: TalkMessage, me: Me, p: Principal, principals: PrincipalsFile): Record<string, unknown> {
  const author = canonical(m.authorKey, me);
  const db = talkDb();
  return {
    key: `${m.origin}/${m.id}`, origin: m.origin, id: m.id, author: { id: author, name: nameOf(author, principals) }, mine: author === me.personId,
    text: m.text, createdAt: m.createdAt, deletedAt: m.deletedAt,
    atts: m.atts.map((sha) => getAtt(db, sha)).filter((a) => a !== null).map((a) => ({ sha256: a!.sha256, mime: a!.mime, bytes: a!.bytes })),
    refs: m.refs.map((r) => ({ ...r, open: refOpen(p, r) })),
    mentions: m.mentions.map((id) => ({ id, name: nameOf(id, principals) })),
  };
}

export async function listRoomMessages(me: Me, p: Principal, key: string, url: URL): Promise<Response> {
  const room = roomFor(me, key);
  if (!room) return notFound();
  const before = Number(url.searchParams.get("before")) || undefined;
  const limit = Number(url.searchParams.get("limit")) || undefined;
  const principals = await talkPrincipals();
  const messages = listMessages(talkDb(), room, { before, limit }).map((m) => messageView(m, me, p, principals));
  return apiJson(200, { ok: true, room: roomView(room, me, principals), messages });
}

export async function postRoomMessage(me: Me, p: Principal, key: string, body: Record<string, unknown>): Promise<Response> {
  const room = roomFor(me, key);
  if (!room) return notFound();
  const draft = parseDraft(body);
  if (typeof draft === "string") return apiJson(400, { ok: false, error: draft });
  const db = talkDb();
  const people = new Set(room.members.map((k) => canonical(k, me)));
  const bad = draft.mentions.find((id) => !people.has(personAliases(db, id)[0]));
  if (bad) return apiJson(400, { ok: false, error: `mention is not in this room: ${bad}` });
  if (!attsUsableBy(db, draft.atts, me.keys, () => canReadLedger(p))) return apiJson(400, { ok: false, error: "unknown attachment: upload it first" });
  rememberMe(me);
  const mentions = draft.mentions.map((id) => personAliases(db, id)[0]);
  const m = { origin: me.fp, id: draft.id, room, authorKey: me.authorKey, text: draft.text, atts: draft.atts, refs: draft.refs, mentions, createdAt: Date.now() };
  const inserted = insertMessage(db, m);
  const principals = await talkPrincipals();
  const saved = getMessage(db, me.fp, draft.id);
  if (!saved) return apiJson(400, { ok: false, error: "message rejected by schema" });
  if (!inserted) {
    // 重发同一个 id：同一作者就当成功（网络重试），别人的 id 冲突回 409；都不再触发推送 / SSE
    if (saved.authorKey !== me.authorKey) return apiJson(409, { ok: false, error: "message id already used" });
    return apiJson(200, { ok: true, duplicate: true, message: messageView(saved, me, p, principals) });
  }
  publishTalk(room, "message", { msg: `${m.origin}/${m.id}` });
  if (m.mentions.includes(OWNER_PERSON) && me.personId !== OWNER_PERSON) {
    const title = String(roomView(room, me, principals).title);
    pushOwnerNotice(`${nameOf(me.personId, principals)} @ 了你（Chat · ${title}）`, m.text.slice(0, 120) || "[图片]", `/talk?room=${encodeURIComponent(key)}`);
  }
  return apiJson(201, { ok: true, message: messageView(saved, me, p, principals) });
}

/** 删除：作者本人或 owner；只清本机这一份（不同步给别的实例） */
export function deleteRoomMessage(me: Me, key: string, origin: string, id: string): Response {
  const room = roomFor(me, key);
  if (!room) return notFound();
  const db = talkDb();
  const m = getMessage(db, origin, id);
  if (!m || m.room.creatorFp !== room.creatorFp || m.room.id !== room.id) return apiJson(404, { ok: false, error: "message not found" });
  if (!me.isOwner && canonical(m.authorKey, me) !== me.personId) return apiJson(403, { ok: false, error: "only the author or the owner can delete" });
  const orphans = deleteMessage(db, origin, id);
  if (orphans === null) return apiJson(200, { ok: true, already: true });
  removeUnreferenced(db, talkAttDir(), orphans);
  publishTalk(room, "delete", { msg: `${origin}/${id}` });
  return apiJson(200, { ok: true });
}

/** 上传一张图：正文就是图片字节。类型只按文件头认，剥元数据后按内容寻址存盘 */
export async function uploadAtt(me: Me, req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > ATT_MAX_BYTES) return apiJson(413, { ok: false, error: `image must be at most ${ATT_MAX_BYTES} bytes` });
  const bytes = new Uint8Array(await req.arrayBuffer());
  rememberMe(me);
  const r = saveAtt(talkDb(), talkAttDir(), bytes, me.authorKey);
  if (!r.ok) {
    const status = r.code === "too_large" ? 413 : 415;
    return apiJson(status, { ok: false, error: r.code === "too_large" ? "image too large" : r.code === "unsupported" ? "only png / jpeg / webp images" : "image is corrupt" });
  }
  return apiJson(201, { ok: true, att: r.att });
}

export function readAtt(me: Me, p: Principal, sha: string): Response {
  const db = talkDb();
  const att = /^[0-9a-f]{64}$/.test(sha) ? getAtt(db, sha) : null;
  if (!att || !canReadAtt(db, sha, me.keys, () => canReadLedger(p))) return apiJson(404, { ok: false, error: "attachment not found" });
  return new Response(Bun.file(attPath(talkAttDir(), att)), {
    headers: { "Content-Type": att.mime, "Cache-Control": "private, max-age=604800, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" },
  });
}
