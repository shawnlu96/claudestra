/**
 * Chat（代码名 talk）的 HTTP 口，只给本机的人（owner 与 guest 设备）；集成 token、peer 一律 403：
 *   GET    /api/v1/talk/me                                  我是谁（person、是不是 owner）
 *   GET    /api/v1/talk/people                              能 @ / 能开 dm 的人（guest 只看得到 owner 和同房间的人）
 *   PATCH  /api/v1/talk/people/:id                          {displayName}           owner 设备注名
 *   POST   /api/v1/talk/people/:id/merge | /unmerge         {into}                  owner 合并 / 拆开两个 guest
 *   GET    /api/v1/talk/rooms                               我在的房间
 *   POST   /api/v1/talk/rooms                               {kind:"dm", with} | {kind:"thread", members, title}（thread 只有 owner 能建）
 *   GET    /api/v1/talk/rooms/:key/messages?before&limit    一页消息
 *   POST   /api/v1/talk/rooms/:key/messages                 {id:"tm_<uuid>", text, atts?, refs?, mentions?}
 *   DELETE /api/v1/talk/rooms/:key/messages/:origin/:id     作者或 owner 删除（只删本机这份）
 *   POST   /api/v1/talk/atts                                正文 = 图片字节 → {sha256, mime, bytes}
 *   GET    /api/v1/talk/atts/:sha256                        取图（上传者 / 引用它的房间成员）
 *   POST   /api/v1/talk/drops/preview | /drops              丢进工作台：预览（agent 收到的原文 + sha）/ 确认 {dropId, sha, ...}
 *   POST   /api/v1/talk/tasks                               只有 owner：勾选的消息建成台账任务 {room, msgs, project, id, title, kind, req}
 * 实时：SSE talk 事件（只推给房间成员），收到就重拉。
 */
import type { Principal } from "../../lib/principals.js";
import { ensureLocalPerson, isGuestPrincipal, localPrincipalOf, mergePeople, OWNER_PERSON, personPrincipals, setDisplayName, TalkPeopleError, unmergePerson } from "../../lib/talk-people.js";
import { createThread, ensureDm, roomsFor, memberKey } from "../../lib/talk-rooms.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { commitDrop, previewDrop } from "../talk-drop.js";
import { createTaskFromTalk } from "../talk-task.js";
import { directoryFor, meOf, publishTalk, reconcileDropsOnce, rememberMe, roomView, selfFp, talkDb, talkPrincipals, type Me } from "../talk.js";
import { deleteRoomMessage, listRoomMessages, postRoomMessage, readAtt, uploadAtt } from "./talk-msgs.js";

const THREAD_MEMBERS_MAX = 20;

const decode = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    // 非法百分号编码是请求方的错，调用方回 400
    return null;
  }
};

async function body(req: Request): Promise<Record<string, unknown> | Response> {
  const b = await readJsonBody(req);
  if (b === INVALID_JSON) return invalidJsonBody();
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : apiJson(400, { ok: false, error: "JSON object body required" });
}

const peopleError = (e: unknown): Response => {
  if (!(e instanceof TalkPeopleError)) throw e;
  return apiJson(e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400, { ok: false, error: e.message });
};

/** 本机存在且没停用的人：owner，或 principals.json 里在用的 guest */
async function livePerson(id: string): Promise<boolean> {
  if (id === OWNER_PERSON) return true;
  const pid = localPrincipalOf(id);
  if (!pid || !isGuestPrincipal(pid)) return false;
  return (await talkPrincipals()).principals.some((p) => p.id === pid && !p.disabled);
}

const keysOf = (me: Me, personId: string): string[] => personPrincipals(talkDb(), personId).map((p) => memberKey(me.fp, p));

async function createRoom(me: Me, b: Record<string, unknown>): Promise<Response> {
  const principals = await talkPrincipals();
  if (b.kind === "dm") {
    const target = typeof b.with === "string" ? b.with : "";
    // guest 只能和 owner 开 dm：不许借 dm 枚举、骚扰别的 guest
    if (!me.isOwner && target !== OWNER_PERSON) return forbidden("guests can only open a dm with the owner");
    if (!(await livePerson(target))) return apiJson(404, { ok: false, error: "person not found" });
    const theirs = keysOf(me, target);
    if (theirs.some((k) => me.keys.includes(k))) return apiJson(400, { ok: false, error: "cannot dm yourself" });
    rememberMe(me);
    const room = ensureDm(talkDb(), me.keys, theirs, me.authorKey);
    publishTalk(room, "room");
    return apiJson(200, { ok: true, room: roomView(room, me, principals) });
  }
  if (b.kind !== "thread") return apiJson(400, { ok: false, error: 'kind must be "dm" or "thread"' });
  if (!me.isOwner) return forbidden("only the owner can start a group thread");
  const ids = Array.isArray(b.members) ? [...new Set(b.members.filter((x): x is string => typeof x === "string"))] : [];
  if (!ids.length || ids.length > THREAD_MEMBERS_MAX) return apiJson(400, { ok: false, error: `members must list 1..${THREAD_MEMBERS_MAX} people` });
  for (const id of ids) if (!(await livePerson(id))) return apiJson(404, { ok: false, error: `person not found: ${id}` });
  const title = typeof b.title === "string" ? b.title.replace(/[\r\n]+/g, " ").trim().slice(0, 60) : "";
  rememberMe(me);
  const room = createThread(talkDb(), me.fp, me.authorKey, ids.map((id) => keysOf(me, id)[0]), title);
  publishTalk(room, "room");
  return apiJson(201, { ok: true, room: roomView(room, me, principals) });
}

async function peopleRoute(req: Request, me: Me, rest: string[]): Promise<Response> {
  const principals = await talkPrincipals();
  if (!rest.length) {
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
    return apiJson(200, { ok: true, people: directoryFor(me, principals, roomsFor(talkDb(), me.keys)) });
  }
  if (!me.isOwner) return forbidden("only the owner can edit people");
  const id = decode(rest[0]);
  if (!id) return apiJson(400, { ok: false, error: "bad person id" });
  const b = await body(req);
  if (b instanceof Response) return b;
  try {
    if (rest.length === 1 && req.method === "PATCH") {
      if (typeof b.displayName !== "string") return apiJson(400, { ok: false, error: "body {displayName: string}" });
      if (!(await livePerson(id))) return apiJson(404, { ok: false, error: "person not found" });
      ensureLocalPerson(talkDb(), localPrincipalOf(id)!);
      return apiJson(200, { ok: true, displayName: setDisplayName(talkDb(), id, b.displayName) });
    }
    if (rest[1] === "merge" && req.method === "POST") {
      if (typeof b.into !== "string" || !(await livePerson(id)) || !(await livePerson(b.into))) return apiJson(404, { ok: false, error: "person not found" });
      mergePeople(talkDb(), id, b.into);
      return apiJson(200, { ok: true });
    }
    if (rest[1] === "unmerge" && req.method === "POST") {
      unmergePerson(talkDb(), id);
      return apiJson(200, { ok: true });
    }
  } catch (e) {
    return peopleError(e);
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}

async function roomsRoute(req: Request, me: Me, p: Principal, rest: string[], url: URL): Promise<Response> {
  if (!rest.length) {
    if (req.method === "GET") {
      const principals = await talkPrincipals();
      return apiJson(200, { ok: true, rooms: roomsFor(talkDb(), me.keys).map((r) => roomView(r, me, principals)) });
    }
    if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
    const b = await body(req);
    return b instanceof Response ? b : createRoom(me, b);
  }
  const key = decode(rest[0]);
  if (!key || rest[1] !== "messages") return apiJson(404, { ok: false, error: "not found" });
  if (rest.length === 2 && req.method === "GET") return listRoomMessages(me, p, key, url);
  if (rest.length === 2 && req.method === "POST") {
    const b = await body(req);
    return b instanceof Response ? b : postRoomMessage(me, p, key, b);
  }
  if (rest.length === 4 && req.method === "DELETE") {
    const [origin, id] = [decode(rest[2]), decode(rest[3])];
    return origin && id ? deleteRoomMessage(me, key, origin, id) : apiJson(400, { ok: false, error: "bad message key" });
  }
  return apiJson(405, { ok: false, error: "method not allowed" });
}

async function dropsRoute(req: Request, me: Me, p: Principal, rest: string[]): Promise<Response> {
  if (req.method !== "POST" || rest.length > 1 || (rest.length === 1 && rest[0] !== "preview")) return apiJson(405, { ok: false, error: "method not allowed" });
  const b = await body(req);
  if (b instanceof Response) return b;
  reconcileDropsOnce();
  const r = rest[0] === "preview" ? await previewDrop(me, p, b) : await commitDrop(me, p, b);
  if ("status" in r && "error" in r) return apiJson(r.status, { ok: false, error: r.error });
  return apiJson(200, { ok: true, ...(rest[0] === "preview" ? r : { drop: r }) });
}

async function taskRoute(req: Request, me: Me, p: Principal): Promise<Response> {
  if (!me.isOwner) return forbidden("only the owner can create tasks from chat");
  const b = await body(req);
  if (b instanceof Response) return b;
  const r = await createTaskFromTalk(me, p, b);
  return "status" in r && "error" in r ? apiJson(r.status as number, { ok: false, error: r.error }) : apiJson(201, r);
}

export async function handleTalkApi(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (path !== "/talk" && !path.startsWith("/talk/")) return null;
  const me = meOf(principal);
  if (!me) return selfFp() ? forbidden("chat is for people on this machine (owner or guest devices)") : apiJson(503, { ok: false, error: "instance key unavailable" });
  const [section, ...rest] = path.slice("/talk/".length).split("/").filter(Boolean);
  try {
    if (section === "me" && req.method === "GET") return apiJson(200, { ok: true, me: { id: me.personId, isOwner: me.isOwner, fp: me.fp } });
    if (section === "people") return await peopleRoute(req, me, rest);
    if (section === "rooms") return await roomsRoute(req, me, principal, rest, url);
    if (section === "drops") return await dropsRoute(req, me, principal, rest);
    if (section === "tasks" && !rest.length && req.method === "POST") return await taskRoute(req, me, principal);
    if (section === "atts" && !rest.length && req.method === "POST") return await uploadAtt(me, req);
    if (section === "atts" && rest.length === 1 && req.method === "GET") return readAtt(me, principal, rest[0]);
  } catch (e) {
    console.error(`⚠️ talk 接口出错 ${req.method} ${path}: ${(e as Error).message}`);
    return apiJson(503, { ok: false, error: `chat unavailable: ${(e as Error).message}` });
  }
  return apiJson(404, { ok: false, error: "not found" });
}
