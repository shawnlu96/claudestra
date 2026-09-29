/**
 * 「丢进工作台」：勾选几条 Chat 消息交给一个 agent。这是人与人的内容进 agent 上下文的唯一入口（docs/talk/README.md「封闭清单」）。
 * - 身份：以发起人自己的 Web 身份投（和发起人在工作台里直接发消息同一个 api 端点），不冒充 owner；目标只能是发起人 scope 里的本机 agent。
 * - 逐字一致：预览和确认都经 buildDrop → renderApiInbound，确认时重算 sha，不一致回 409（中间有人删了消息 / 改了名）。
 * - 不抢占、不丢：intent 用 notification，目标在线且空闲才直接送；忙、压缩中、不在线就进押后队列，等空闲再送（held-flush 不会对
 *   notification 抢占）。押后的结局经 held-queue 的 onHeldSettled 回写 drops（talk.ts 顶层挂的监听）。
 */
import { tokenIdOf, agentInScope, isOwnerPrincipal, type Principal, type PrincipalsFile } from "../lib/principals.js";
import { attPath, getAtt } from "../lib/talk-atts.js";
import { contentSha, renderDropBody, type DropInput, type DropLine } from "../lib/talk-drop-render.js";
import { claimDrop, getDrop, type DropRow } from "../lib/talk-drops.js";
import { getMessage, type TalkMessage } from "../lib/talk-messages.js";
import { OWNER_PERSON } from "../lib/talk-people.js";
import { getRoom, isMember, parseRoomKey, type Room } from "../lib/talk-rooms.js";
import { DROP_ID_RE } from "../lib/talk-schema.js";
import { asksDeps, registry } from "./asks.js";
import { newThreadId, renderApiInbound, type ApiUserEndpoint, type Envelope, type LocalEndpoint } from "./router.js";
import { DROP_MSG_PREFIX, nameOf, personOfKey, publishTalk, roomView, settleDrop, talkAttDir, talkDb, talkPrincipals, type Me } from "./talk.js";
import { probeTurn } from "./turn-probe.js";

const DROP_MAX_MSGS = 50;

export type DropError = { status: 400 | 403 | 404 | 409 | 503; error: string };
interface Built {
  room: Room;
  msgs: TalkMessage[];
  agent: { name: string; channelId: string };
  from: ApiUserEndpoint;
  body: string;
  content: string;
  sha: string;
}

export async function resolveAgent(principal: Principal, raw: unknown): Promise<{ name: string; channelId: string } | DropError> {
  if (typeof raw !== "string" || !raw) return { status: 400, error: "agent required" };
  const bare = raw.replace(/^agent-/, "");
  const d = asksDeps();
  if (!d) return { status: 503, error: "bridge not ready" };
  if (bare === "master") {
    return agentInScope(principal, "master") ? { name: "master", channelId: d.controlChannelId } : { status: 403, error: "agent not in your scope" };
  }
  const reg = (await registry()).find((a) => (a.name === raw || a.name === `agent-${bare}`) && a.status === "active" && a.channelId);
  if (!reg || !agentInScope(principal, reg.name)) return { status: 403, error: "agent not in your scope" };
  return { name: reg.name, channelId: reg.channelId! };
}

function pickMessages(me: Me, room: Room, raw: unknown): TalkMessage[] | DropError {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > DROP_MAX_MSGS) return { status: 400, error: `msgs must list 1..${DROP_MAX_MSGS} "<origin>/<id>"` };
  const db = talkDb();
  const out: TalkMessage[] = [];
  for (const k of new Set(raw as unknown[])) {
    const s = typeof k === "string" ? k : "";
    const slash = s.lastIndexOf("/");
    const m = slash > 0 ? getMessage(db, s.slice(0, slash), s.slice(slash + 1)) : null;
    if (!m || m.room.creatorFp !== room.creatorFp || m.room.id !== room.id) return { status: 400, error: `message not in this room: ${s}` };
    if (m.deletedAt) return { status: 409, error: `message was deleted: ${s}` };
    out.push(m);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

function lineOf(m: TalkMessage, me: Me, principals: PrincipalsFile): DropLine {
  const db = talkDb();
  const attPaths = m.atts.map((sha) => getAtt(db, sha)).filter((a) => a !== null).map((a) => attPath(talkAttDir(), a!));
  const person = personOfKey(m.authorKey, me.fp);
  return {
    author: nameOf(person, principals), external: m.origin !== me.fp, owner: person === OWNER_PERSON, msgKey: `${m.origin}/${m.id}`,
    at: m.createdAt, text: m.text, attPaths, refs: m.refs.map((r) => ({ kind: r.kind, title: r.title })),
  };
}

/** 预览与确认共用：校验房间 / 消息 / agent，拼出 agent 会收到的完整正文 */
/** 房间、勾选的消息与它们渲染前的样子（丢进工作台与「新建任务」共用）：不是成员 404，消息不在这个房间 / 已删 400 / 409 */
export async function buildLines(me: Me, _p: Principal, b: Record<string, unknown>): Promise<{ room: Room; picked: TalkMessage[]; msgs: string[]; excerpt: DropInput } | DropError> {
  const ref = typeof b.room === "string" ? parseRoomKey(b.room) : null;
  const db = talkDb();
  const room = ref ? getRoom(db, ref) : null;
  if (!room || !isMember(db, room, me.keys)) return { status: 404, error: "room not found" };
  const picked = pickMessages(me, room, b.msgs);
  if (!Array.isArray(picked)) return picked;
  const principals = await talkPrincipals();
  const by = nameOf(me.personId, principals);
  const excerpt = { by, room: { kind: room.kind, title: String(roomView(room, me, principals).title) }, lines: picked.map((m) => lineOf(m, me, principals)) };
  return { room, picked, msgs: picked.map((m) => `${m.origin}/${m.id}`), excerpt };
}

async function buildDrop(me: Me, principal: Principal, b: Record<string, unknown>): Promise<Built | DropError> {
  const lines = await buildLines(me, principal, b);
  if ("status" in lines) return lines;
  const agent = await resolveAgent(principal, b.agent);
  if ("status" in agent) return agent;
  const from: ApiUserEndpoint = { kind: "api", tokenId: tokenIdOf(principal), name: lines.excerpt.by, ...(isOwnerPrincipal(principal) ? { owner: true as const } : {}) };
  const body = renderDropBody(lines.excerpt);
  const content = renderApiInbound({ from, content: body });
  return { room: lines.room, msgs: lines.picked, agent, from, body, content, sha: contentSha(content) };
}

async function trySend(env: Envelope, agent: { name: string; channelId: string }): Promise<"sent" | "held"> {
  const d = asksDeps()!;
  const live = d.clients.get(agent.channelId);
  if (live) {
    const t = await probeTurn(agent.channelId, agent.name, d.controlChannelId).catch((e) => {
      console.warn(`⚠️ 丢进工作台判忙失败，按忙处理进押后队列: ${(e as Error).message}`);
      return null;
    });
    const idle = t !== null && t.main !== "busy" && t.main !== "compacting";
    if (idle) {
      const r = await d.deliver({ ...env, to: { ...(env.to as LocalEndpoint), ws: live.ws, cwd: live.cwd } });
      if (r.outcome.kind === "sent") return r.outcome.note === "queued" ? "held" : "sent";
    }
  }
  d.hold(env);
  return "held";
}

/** 在线且空闲才直接送，否则进押后队列；投递本身出错也进押后队列（丢进工作台与粘贴外部文字共用，what 只进日志） */
export async function sendOrHold(env: Envelope, agent: { name: string; channelId: string }, what: string): Promise<"sent" | "held"> {
  try {
    return await trySend(env, agent);
  } catch (e) {
    console.error(`⚠️ ${what}投递出错，进押后队列: ${(e as Error).message}`);
    asksDeps()?.hold(env);
    return "held";
  }
}

/**
 * 确认：同一个 dropId 只投一次（先占位再投）；别人的 dropId 回 409。返回这条 drop 的当前记录。
 */
export async function commitDrop(me: Me, principal: Principal, b: Record<string, unknown>): Promise<DropRow | DropError> {
  if (typeof b.dropId !== "string" || !DROP_ID_RE.test(b.dropId)) return { status: 400, error: "dropId must match td_<uuid>" };
  const db = talkDb();
  const existing = getDrop(db, b.dropId);
  if (existing) return existing.principal === me.principalId ? existing : { status: 409, error: "dropId already used" };
  const built = await buildDrop(me, principal, b);
  if ("status" in built) return built;
  if (b.sha !== built.sha) return { status: 409, error: "preview is stale: preview again" };
  const now = Date.now();
  const messageId = `${DROP_MSG_PREFIX}${now}_${b.dropId.slice(3, 11)}`;
  const claimed = claimDrop(db, {
    dropId: b.dropId, principal: me.principalId, personId: me.personId, agent: built.agent.name, roomFp: built.room.creatorFp, roomId: built.room.id,
    msgIds: built.msgs.map((m) => `${m.origin}/${m.id}`), contentSha: built.sha, messageId, createdAt: now,
  });
  if (!claimed) return getDrop(db, b.dropId)!;
  const env: Envelope = {
    from: built.from,
    to: { kind: "local", agentName: built.agent.name, channelId: built.agent.channelId, ws: asksDeps()?.clients.get(built.agent.channelId)?.ws as LocalEndpoint["ws"] },
    intent: "notification",
    content: built.body,
    meta: { messageId, triggerKind: "system", ts: new Date(now).toISOString(), threadId: newThreadId(), skipInterAgentWatchdog: true },
  };
  const state = await sendOrHold(env, built.agent, "丢进工作台");
  if (state === "sent") settleDrop(messageId, "sent");
  else publishTalk(built.room, "drop", { dropId: b.dropId, state });
  console.log(`📥 丢进工作台 ${b.dropId}：${me.personId} → ${built.agent.name}（${built.msgs.length} 条，${state}）`);
  return getDrop(db, b.dropId)!;
}

/** 预览的返回：完整正文（含 Web 用户抬头）与 sha，网页原样显示，确认时回传 sha */
export async function previewDrop(me: Me, principal: Principal, b: Record<string, unknown>): Promise<{ content: string; sha: string; agent: string } | DropError> {
  const built = await buildDrop(me, principal, b);
  return "status" in built ? built : { content: built.content, sha: built.sha, agent: built.agent.name };
}
