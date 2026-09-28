/**
 * talk（界面叫 Chat）在 bridge 里的运行时：库句柄、「请求方是谁」、名字目录、SSE。人与人的消息**不进任何 agent 的上下文**，
 * 只有「丢进工作台」（talk-drop.ts）会投给 agent——这是封闭清单，别的路径加投递要先改设计稿 §2.5。
 * 谁能用：本机 owner（含 Discord 上的 owner、旧 web-ui token）和 guest 设备；集成 token、peer 一律不是人，403。
 * 读权限只有一个判定：查看者名下的成员键（合并过的人有多个）在不在房间成员里（lib/talk-rooms.ts isMember）。
 */
import type { Database } from "bun:sqlite";
import { instanceKeySync, keyFingerprint } from "../lib/instance-key.js";
import { isOwnerPrincipal, readPrincipals, type Principal, type PrincipalsFile } from "../lib/principals.js";
import { ensureLocalPerson, getPerson, isGuestPrincipal, localPrincipalOf, OWNER_PERSON, OWNER_PRINCIPAL, personAliases, personIdOf, personPrincipals } from "../lib/talk-people.js";
import { memberKey, principalOfKey, roomKey, type Room, type RoomRef } from "../lib/talk-rooms.js";
import { openTalk, TALK_ATT_DIR } from "../lib/talk-schema.js";
import { webDb } from "./local-api/db.js";
import { failOrphanHeld, settleDropByMessage, type DropState } from "../lib/talk-drops.js";
import { emitEvent } from "./event-bus.js";
import { heldMessageIds, onHeldSettled } from "./held-queue.js";

interface TalkEnv {
  dbPath?: string;
  attDir: string;
  fp: () => string | null;
  principals: () => Promise<PrincipalsFile>;
  ownerNickname: () => string;
}

const ownerNickname = (): string => {
  try {
    return (webDb().prepare("SELECT nickname FROM user_profile WHERE id = 1").get() as { nickname: string } | null)?.nickname ?? "";
  } catch (e) {
    console.error(`⚠️ talk：读 owner 昵称失败，按默认名显示: ${(e as Error).message}`);
    return "";
  }
};
const DEFAULT_ENV: TalkEnv = {
  attDir: TALK_ATT_DIR,
  fp: () => {
    const k = instanceKeySync();
    return k ? keyFingerprint(k.publicKey) : null;
  },
  principals: () => readPrincipals(),
  ownerNickname,
};
let env = DEFAULT_ENV;

export function setTalkForTest(e: Partial<TalkEnv> | undefined): void {
  env = e ? { ...DEFAULT_ENV, ...e } : DEFAULT_ENV;
}

export const talkDb = (): Database => openTalk(env.dbPath);
export const talkAttDir = (): string => env.attDir;
/** 本机指纹：拿不到实例密钥时 talk 整体不可用（成员键、消息 origin 都靠它），调用方回 503 */
export const selfFp = (): string | null => env.fp();
export const talkPrincipals = (): Promise<PrincipalsFile> => env.principals();

export interface Me {
  /** 发请求的凭据所属 principal（owner 的所有来源都归一成 owner:self） */
  principalId: string;
  /** 规范 person id（合并过的 guest 是它并入的那个人） */
  personId: string;
  /** 名下所有成员键 */
  keys: string[];
  /** 发消息时的作者键：用本机规范 principal，读侧按人显示 */
  authorKey: string;
  isOwner: boolean;
  fp: string;
}

/** 请求方 → 人；不是人（集成 token、peer、停用的）返回 null。只读：people 行由会写库的入口经 rememberMe 建 */
export function meOf(p: Principal): Me | null {
  if (p.disabled || p.peer) return null;
  const isOwner = isOwnerPrincipal(p);
  const principalId = isOwner ? OWNER_PRINCIPAL : isGuestPrincipal(p.id) ? p.id : null;
  const fp = selfFp();
  if (!principalId || !fp) return null;
  const db = talkDb();
  const personId = personAliases(db, personIdOf(principalId))[0];
  const keys = personPrincipals(db, personId).map((x) => memberKey(fp, x));
  return { principalId, personId, keys, authorKey: memberKey(fp, localPrincipalOf(personId) ?? principalId), isOwner, fp };
}

/** 发消息、建房这类写入口先记下这个人（people 行幂等建） */
export function rememberMe(me: Me): void {
  ensureLocalPerson(talkDb(), me.principalId);
}

/** 成员键 → 本地 person id（一期只有本机的人；二期远端是 remote:<fp>/<principal>） */
export function personOfKey(key: string, fp: string): string {
  return key.startsWith(`${fp}/`) ? personIdOf(principalOfKey(key)) : `remote:${key}`;
}

/** 显示名：owner 设的备注名优先；否则 owner 用网页昵称，guest 用配对时起的名字；都没有就用 id 尾巴 */
export function nameOf(personId: string, principals: PrincipalsFile): string {
  const row = getPerson(talkDb(), personId);
  if (row?.displayName) return row.displayName;
  if (personId === OWNER_PERSON) return env.ownerNickname() || "Owner";
  const pid = localPrincipalOf(personId);
  const p = pid ? principals.principals.find((x) => x.id === pid) : undefined;
  return p?.name || personId.slice(-8);
}

export interface PersonView {
  id: string;
  name: string;
  isOwner: boolean;
  mergedInto: string | null;
  /** owner 看得到：这个人名下的 guest 设备都被停用了 */
  disabled?: boolean;
}

/**
 * 可以 @、可以开 dm 的人。owner 看得到本机所有 guest；guest 只看得到 owner 和跟自己同在一个房间的人（不能枚举别的 guest）。
 */
export function directoryFor(me: Me, principals: PrincipalsFile, rooms: readonly Room[]): PersonView[] {
  const db = talkDb();
  const ids = new Set<string>([OWNER_PERSON]);
  if (me.isOwner) {
    for (const p of principals.principals) if (isGuestPrincipal(p.id) && !p.disabled) ids.add(personAliases(db, personIdOf(p.id))[0]);
  } else {
    for (const r of rooms) for (const k of r.members) ids.add(personAliases(db, personOfKey(k, me.fp))[0]);
  }
  return [...ids].map((id) => {
    const pid = localPrincipalOf(id);
    const disabled = me.isOwner && pid && isGuestPrincipal(pid) ? !principals.principals.some((p) => p.id === pid && !p.disabled) : undefined;
    return { id, name: nameOf(id, principals), isOwner: id === OWNER_PERSON, mergedInto: getPerson(db, id)?.mergedInto ?? null, ...(disabled ? { disabled } : {}) };
  });
}

/** 房间在网页上的样子：成员换成人，dm 的标题是对方的名字 */
export function roomView(r: Room, me: Me, principals: PrincipalsFile): Record<string, unknown> {
  const db = talkDb();
  const people = [...new Set(r.members.map((k) => personAliases(db, personOfKey(k, me.fp))[0]))];
  const others = people.filter((id) => id !== me.personId);
  const title = r.kind === "dm" ? others.map((id) => nameOf(id, principals)).join("、") || nameOf(me.personId, principals) : r.title || people.map((id) => nameOf(id, principals)).join("、");
  return { key: roomKey(r), kind: r.kind, title, members: people.map((id) => ({ id, name: nameOf(id, principals) })), lastAt: r.lastAt, createdAt: r.createdAt };
}

export type TalkEventWhat = "message" | "delete" | "room" | "drop";

/** SSE：只带房间键、成员键和发生了什么，网页收到就重拉；只推给房间成员（talkEventAllowed） */
export function publishTalk(room: RoomRef & { members: readonly string[] }, what: TalkEventWhat, extra: Record<string, unknown> = {}): void {
  emitEvent({ agent: "", chatId: "", type: "talk", data: { room: roomKey(room), members: [...room.members], what, ...extra } }, { transient: true });
}

/** /api/v1/events 逐条过滤里 talk 事件的门（bridge/ledger-feed.ts 调）：查看者名下有成员键在事件的 members 里 */
export function talkEventAllowed(p: Principal, data: Record<string, unknown>): boolean {
  const members = Array.isArray(data.members) ? (data.members as unknown[]) : [];
  if (!members.length) return false;
  try {
    const me = meOf(p);
    return !!me && me.keys.some((k) => members.includes(k));
  } catch (e) {
    console.error(`⚠️ talk：SSE 过滤时解析身份失败，这条不推: ${(e as Error).message}`);
    return false;
  }
}

// ── 丢进工作台的状态回写（投递本身在 talk-drop.ts）──

/** drop 投递信封的 messageId 前缀：押后队列的结局按它认出是不是 drop */
export const DROP_MSG_PREFIX = "talkdrop_";

/** 按投递信封改 drop 状态并推 SSE；已是终态的不动 */
export function settleDrop(messageId: string, state: Exclude<DropState, "held">, error: string | null = null): void {
  const d = settleDropByMessage(talkDb(), messageId, state, error);
  if (d) publishTalk({ creatorFp: d.roomFp, id: d.roomId, members: roomMembers(d.roomFp, d.roomId) }, "drop", { dropId: d.dropId, state: d.state });
}

function roomMembers(roomFp: string, roomId: string): string[] {
  return (talkDb().prepare("SELECT memberKey FROM members WHERE roomFp = ? AND roomId = ?").all(roomFp, roomId) as { memberKey: string }[]).map((r) => r.memberKey);
}

// 模块加载即挂（api-routes → ledger-feed → 这里，bridge 启动时就在）：重启后押后队列里的 drop 被冲刷时也能回写
onHeldSettled((e, outcome) => {
  if (!e.meta.messageId.startsWith(DROP_MSG_PREFIX)) return;
  if (outcome === "delivered") settleDrop(e.meta.messageId, "sent");
  else settleDrop(e.meta.messageId, "failed", outcome === "gave-up" ? "排了 24 小时仍没送到（对方一直不空闲或不在线）" : "目标 agent 已被清理");
});

let orphansChecked = false;
/** 本进程第一次碰 drops 之前（同步，先于任何新占位）：占了位却已不在押后队列里的标 failed，别让界面一直显示「排队中」 */
export function reconcileDropsOnce(heldPath?: string): void {
  if (orphansChecked) return;
  orphansChecked = true;
  for (const d of failOrphanHeld(talkDb(), heldMessageIds(heldPath))) {
    publishTalk({ creatorFp: d.roomFp, id: d.roomId, members: roomMembers(d.roomFp, d.roomId) }, "drop", { dropId: d.dropId, state: d.state });
  }
}
