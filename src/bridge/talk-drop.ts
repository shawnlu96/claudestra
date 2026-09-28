/**
 * 「丢进工作台」：勾选几条 Chat 消息交给一个 agent。这是人与人的内容进 agent 上下文的唯一入口（设计稿 §2.5 第 1 行）。
 * - 身份：以发起人自己的 Web 身份投（和他在工作台里直接发消息同一个 api 端点），不冒充 owner；目标只能是他 scope 里的本机 agent。
 * - 逐字一致：预览和确认都经 buildDrop → renderApiInbound，确认时重算 sha，不一致回 409（中间有人删了消息 / 改了名）。
 * - 不抢占、不丢：intent 用 notification，目标在线且空闲才直接送；忙、压缩中、不在线就进押后队列，等空闲再送（held-flush 不会对
 *   notification 抢占）。押后的结局经 held-queue 的 onHeldSettled 回写 drops（talk.ts 顶层挂的监听）。
 */
import { tokenIdOf, agentInScope, isOwnerPrincipal, type Principal, type PrincipalsFile } from "../lib/principals.js";
import { attPath, getAtt } from "../lib/talk-atts.js";
import { contentSha, renderDropBody, type DropLine } from "../lib/talk-drop-render.js";
import { claimDrop, getDrop, type DropRow } from "../lib/talk-drops.js";
import { getMessage, type TalkMessage } from "../lib/talk-messages.js";
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

async function resolveAgent(principal: Principal, raw: unknown): Promise<{ name: string; channelId: string } | DropError> {
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
  return {
    author: nameOf(personOfKey(m.authorKey, me.fp), principals), external: m.origin !== me.fp, msgKey: `${m.origin}/${m.id}`,
    at: m.createdAt, text: m.text, attPaths, refs: m.refs.map((r) => ({ kind: r.kind, title: r.title })),
  };
}

/** 预览与确认共用：校验房间 / 消息 / agent，拼出 agent 会收到的完整正文 */
async function buildDrop(me: Me, principal: Principal, b: Record<string, unknown>): Promise<Built | DropError> {
  const ref = typeof b.room === "string" ? parseRoomKey(b.room) : null;
  const db = talkDb();
  const room = ref ? getRoom(db, ref) : null;
  if (!room || !isMember(db, room, me.keys)) return { status: 404, error: "room not found" };
  const msgs = pickMessages(me, room, b.msgs);
  if (!Array.isArray(msgs)) return msgs;
  const agent = await resolveAgent(principal, b.agent);
  if ("status" in agent) return agent;
  const principals = await talkPrincipals();
  const by = nameOf(me.personId, principals);
  const from: ApiUserEndpoint = { kind: "api", tokenId: tokenIdOf(principal), name: by, ...(isOwnerPrincipal(principal) ? { owner: true as const } : {}) };
  const body = renderDropBody({ by, roomTitle: String(roomView(room, me, principals).title), lines: msgs.map((m) => lineOf(m, me, principals)) });
  const content = renderApiInbound({ from, content: body });
  return { room, msgs, agent, from, body, content, sha: contentSha(content) };
}

async function sendOrHold(env: Envelope, agent: { name: string; channelId: string }): Promise<"sent" | "held"> {
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
  let state: "sent" | "held";
  try {
    state = await sendOrHold(env, built.agent);
  } catch (e) {
    console.error(`⚠️ 丢进工作台投递出错，进押后队列: ${(e as Error).message}`);
    asksDeps()?.hold(env);
    state = "held";
  }
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
