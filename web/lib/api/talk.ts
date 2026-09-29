/**
 * Chat（bridge local-api/talk.ts，代码名 talk）：人与人的房间、消息、图片、丢进工作台。只给本机的人（owner 与 guest 设备），
 * 集成 token / peer 拿 403。实时靠 SSE talk 事件（只推给房间成员），收到就重拉当前房间与列表。
 */
import { api, apiRaw } from "./client";
import { followEventStream } from "./ledger";

export interface TalkPerson {
  id: string;
  name: string;
  isOwner?: boolean;
  mergedInto?: string | null;
  disabled?: boolean;
}
export interface TalkRoom {
  key: string;
  kind: "dm" | "thread";
  title: string;
  members: TalkPerson[];
  lastAt: number;
  createdAt: number;
}
export interface TalkRef {
  kind: "message" | "task" | "ask" | "doc";
  scope: string;
  id: string;
  title: string;
  open?: boolean;
}
export interface TalkAtt {
  sha256: string;
  mime: string;
  bytes: number;
}
export interface TalkMessage {
  key: string;
  origin: string;
  id: string;
  author: TalkPerson;
  mine: boolean;
  text: string;
  createdAt: number;
  deletedAt: number | null;
  atts: TalkAtt[];
  refs: TalkRef[];
  mentions: TalkPerson[];
}
export interface TalkDrop {
  dropId: string;
  state: "sent" | "held" | "failed";
  agent: string;
  error: string | null;
}

const enc = encodeURIComponent;

export const talkMe = () => api<{ ok: boolean; me: { id: string; isOwner: boolean; fp: string } }>("/talk/me", { timeoutMs: 8000 });
export const talkPeople = () => api<{ ok: boolean; people: TalkPerson[] }>("/talk/people", { timeoutMs: 8000 });
export const talkRooms = () => api<{ ok: boolean; rooms: TalkRoom[] }>("/talk/rooms", { timeoutMs: 8000 });

export function openDm(personId: string): Promise<{ ok: boolean; room: TalkRoom }> {
  return api("/talk/rooms", { method: "POST", json: { kind: "dm", with: personId }, timeoutMs: 10_000 });
}
export function openThread(members: string[], title: string): Promise<{ ok: boolean; room: TalkRoom }> {
  return api("/talk/rooms", { method: "POST", json: { kind: "thread", members, title }, timeoutMs: 10_000 });
}
export function roomMessages(key: string, before?: number): Promise<{ ok: boolean; room: TalkRoom; messages: TalkMessage[] }> {
  return api(`/talk/rooms/${enc(key)}/messages${before ? `?before=${before}` : ""}`, { timeoutMs: 10_000 });
}
export function postMessage(key: string, body: { id: string; text: string; atts?: string[]; refs?: TalkRef[]; mentions?: string[] }): Promise<{ ok: boolean; message: TalkMessage }> {
  return api(`/talk/rooms/${enc(key)}/messages`, { method: "POST", json: body, timeoutMs: 15_000 });
}
export function deleteMessage(key: string, m: Pick<TalkMessage, "origin" | "id">): Promise<{ ok: boolean }> {
  return api(`/talk/rooms/${enc(key)}/messages/${enc(m.origin)}/${enc(m.id)}`, { method: "DELETE", timeoutMs: 10_000 });
}
export function uploadImage(file: Blob): Promise<{ ok: boolean; att: TalkAtt }> {
  return api("/talk/atts", { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" }, timeoutMs: 60_000 });
}
/** 取图走 fetch + blob（凭据是 HttpOnly cookie，token 永不进 URL） */
export const attUrl = (sha: string): string => `/api/v1/talk/atts/${sha}`;
export const fetchAtt = (sha: string): Promise<Response> => apiRaw(`/talk/atts/${sha}`);

export function renamePerson(id: string, displayName: string): Promise<{ ok: boolean }> {
  return api(`/talk/people/${enc(id)}`, { method: "PATCH", json: { displayName }, timeoutMs: 10_000 });
}
export function mergePerson(id: string, into: string): Promise<{ ok: boolean }> {
  return api(`/talk/people/${enc(id)}/merge`, { method: "POST", json: { into }, timeoutMs: 10_000 });
}
export function unmergePerson(id: string): Promise<{ ok: boolean }> {
  return api(`/talk/people/${enc(id)}/unmerge`, { method: "POST", json: {}, timeoutMs: 10_000 });
}

export interface DropBody {
  room: string;
  msgs: string[];
  agent: string;
}
/** 预览：content 就是 agent 会收到的原文（含 Web 用户抬头），确认时回传 sha，中间内容变了 bridge 回 409 */
export function previewDrop(b: DropBody): Promise<{ ok: boolean; content: string; sha: string; agent: string }> {
  return api("/talk/drops/preview", { method: "POST", json: b, timeoutMs: 15_000 });
}
export function commitDrop(b: DropBody & { dropId: string; sha: string }): Promise<{ ok: boolean; drop: TalkDrop }> {
  return api("/talk/drops", { method: "POST", json: b, timeoutMs: 30_000 });
}

/** 能丢给谁：这台设备 scope 里的 agent（GET /agents 已按 scope 过滤） */
export async function dropTargets(): Promise<{ name: string; label: string }[]> {
  const r = await api<{ agents?: { name: string; label?: string | null; status?: string; archived?: boolean }[] }>("/agents", { timeoutMs: 15_000 });
  return (r.agents ?? []).filter((a) => a.status !== "stopped" && !a.archived).map((a) => ({ name: a.name, label: a.label || a.name.replace(/^agent-/, "") }));
}

export function followTalkEvents(opts: { signal: AbortSignal; onOpen: () => void; onTalk: (room: string) => void }): Promise<void> {
  return followEventStream("/events?types=talk", { signal: opts.signal, onOpen: opts.onOpen, onEvent: (e) => e.type === "talk" && opts.onTalk(String(e.data.room ?? "")) });
}

/** 只有 owner：勾选的消息建成台账任务（bridge 经 CLI 写，原文记成任务上的 note）；req 是幂等键，重试不会建两条 */
export interface NewTaskBody {
  room: string;
  msgs: string[];
  project: string;
  id: string;
  title: string;
  kind: string;
  req: string;
}
export function createTask(b: NewTaskBody): Promise<{ ok: boolean; task: { id: string }; noted?: boolean }> {
  return api("/talk/tasks", { method: "POST", json: b, timeoutMs: 90_000 });
}
