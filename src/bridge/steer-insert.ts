/**
 * Pi / ACP 插队逐条记账，明确回复投到后才销账；Stop 提醒和超期回显由 steer-insert-notices 接线。
 * 未确认请求不参加隐式答复，避免把 owner 或其他请求方的收尾推错。账本逐条校验、全局限量，读时也清理过期项。
 */
import { statePath } from "../lib/paths.js";
import { HELD_GIVE_UP_MS } from "./held-queue.js";
import { PersistedMap } from "./persisted-map.js";
import type { Envelope, LocalEndpoint } from "./router.js";

interface InsertEntry { env: Envelope & { from: LocalEndpoint }; at: number; reminded?: boolean }
type Book = Record<string, InsertEntry>;
type Removed = "expired" | "overflow" | "stopped";
export const INSERT_LIMIT = 1_000;
let now = (): number => Date.now();
let onRemoved = (_target: string, _id: string, _e: InsertEntry, _why: Removed): void => {};
let stoppedAt = (_target: string): number | undefined => undefined;
export function configureSteerInsert(d: { now?: () => number; removed?: typeof onRemoved; stoppedAt?: typeof stoppedAt }): void {
  if (d.now) now = d.now;
  if (d.removed) onRemoved = d.removed;
  if (d.stoppedAt) stoppedAt = d.stoppedAt;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && !!v;
function valid(v: unknown, id: string, target: string): v is InsertEntry {
  if (!object(v) || typeof v.at !== "number" || !Number.isFinite(v.at) || v.at < 0) return false;
  if (v.reminded !== undefined && typeof v.reminded !== "boolean") return false;
  const e = v.env;
  if (!object(e) || !object(e.from) || !object(e.to) || !object(e.meta)) return false;
  const r = e.meta.inboundRoute;
  return e.from.kind === "local" && text(e.from.channelId) && (e.from.agentName === undefined || text(e.from.agentName))
    && e.to.kind === "local" && e.to.channelId === target && (e.to.agentName === undefined || text(e.to.agentName))
    && e.intent === "request" && typeof e.content === "string"
    && e.meta.messageId === id && text(id) && text(e.meta.threadId) && text(e.meta.ts) && text(e.meta.triggerKind)
    && object(r) && r.action === "insert" && (r.via === undefined || r.via === "steer") && typeof r.p === "number" && Number.isFinite(r.p) && r.p >= 0 && r.p <= 1;
}
// 外层只验 JSON 表，内部坏条目逐条删，不能因一条损坏丢掉同文件其他请求。
let book = new PersistedMap<Book>(statePath("insert-pending.json"), "插队待确认", () => true);
export const openInsertBook = (path: string | null): void => void (book = new PersistedMap<Book>(path, "插队待确认", () => true));
function put(target: string, entries: [string, InsertEntry][]): void {
  if (entries.length) book.set(target, Object.fromEntries(entries));
  else book.delete(target);
}
/** 每次读取及分钟扫描都跑：先释放回程槽再移除保护，不留一个可被 drain 错推的窗口。 */
export function sweepInserts(): void {
  const all: { target: string; id: string; e: InsertEntry }[] = [];
  const changed = new Set<string>();
  for (const [target, raw] of book) {
    if (!object(raw)) { changed.add(target); console.warn(`⚠️ 插队确认账丢弃坏目标 ${target}`); continue; }
    for (const [id, e] of Object.entries(raw)) {
      if (!valid(e, id, target)) { changed.add(target); console.warn(`⚠️ 插队确认账丢弃坏条目 ${target}/${id}`); }
      else all.push({ target, id, e });
    }
  }
  const stopped = (x: { target: string; e: InsertEntry }) => (stoppedAt(x.target) ?? -Infinity) >= x.e.at;
  const live = all.filter((x) => !stopped(x) && now() - x.e.at < HELD_GIVE_UP_MS).sort((a, b) => b.e.at - a.e.at);
  const keep = new Set(live.slice(0, INSERT_LIMIT));
  for (const x of all) if (!keep.has(x)) {
    onRemoved(x.target, x.id, x.e, stopped(x) ? "stopped" : now() - x.e.at >= HELD_GIVE_UP_MS ? "expired" : "overflow");
    changed.add(x.target);
  }
  if (!changed.size) return;
  const sets: [string, Book][] = [], deletes: string[] = [];
  for (const target of changed) {
    const entries = [...keep].filter((x) => x.target === target).map((x) => [x.id, x.e]);
    if (entries.length) sets.push([target, Object.fromEntries(entries)]);
    else deletes.push(target);
  }
  book.update(sets, deletes);
}
const entries = (target: string): [string, InsertEntry][] => (sweepInserts(), Object.entries(book.get(target) ?? {}));
/** 仅真正插队送达的请求记账；重投同 id 不重置提醒或失效钟。 */
export function noteInsert(env: Envelope, target: string): void {
  if (env.meta.inboundRoute?.action !== "insert" || env.from.kind !== "local" || env.intent !== "request" || env.meta.skipInterAgentWatchdog) return;
  const old = entries(target);
  if (!old.some(([id]) => id === env.meta.messageId)) put(target, [...old, [env.meta.messageId, { env: env as InsertEntry["env"], at: now() }]]);
  sweepInserts();
}
/** 只在明确回给 caller 时忽略它自己的插队保护，投递失败时保护仍在。 */
export function insertUnseenFrom(target: string, exceptCaller?: string, replyAt = Infinity): { fromKind: string; fromChannelId: string; messageId: string }[] {
  return entries(target).filter(([, e]) => e.env.from.channelId !== exceptCaller || e.at >= replyAt)
    .map(([id, e]) => ({ fromKind: "local", fromChannelId: e.env.from.channelId, messageId: id }));
}
/** at 是本次回复帧到达 bridge 的时刻；await 期间才插进来的不能被旧回复销掉。 */
export const insertIdsFrom = (target: string, caller: string, at = Infinity): string[] =>
  entries(target).filter(([, e]) => e.env.from.channelId === caller && e.at < at).map(([id]) => id);
export const insertSnapshot = (target: string): Set<string> => new Set(entries(target).map(([id]) => id));
export function settleInsertReply(target: string, ids: readonly string[]): void {
  if (!ids.length) return;
  // Pi 的迟到作废回执已有专用回显：先按 id 销掉，不能先过期/叫停扫描再重复告知一次。
  const old = Object.entries(book.get(target) ?? {});
  const keep = old.filter(([id]) => !ids.includes(id));
  if (old.length !== keep.length) put(target, keep);
  sweepInserts();
}
/** Stop 取一次提醒，状态落盘；后来的 Stop 不反复唤醒目标。 */
export function takeInsertReminders(target: string, snapshot: ReadonlySet<string>): InsertEntry[] {
  const old = entries(target);
  const picked = old.filter(([id, e]) => snapshot.has(id) && !e.reminded);
  if (picked.length) put(target, old.map(([id, e]) => [id, snapshot.has(id) ? { ...e, reminded: true } : e]));
  return picked.map(([, e]) => e);
}
export const dropInserts = (target: string): void => void book.delete(target);
