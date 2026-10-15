/**
 * Service Worker ↔ 页面的消息与通知 tag（web/public/sw.js 是同一套规则的手写副本：SW 不经打包、web 不 import src，
 * tests/floka-browser-protocol.test.ts 在假 SW 环境里跑 sw.js，对照这里）。
 *   · SW → 页面只发一条消息：type 永远是旧族（旧页面照认），新族类型放在 alias，id 供新页面去重；
 *     旧 SW 发的没有 id / alias，新页面按旧类型认、按内容去重——两种混搭各处理一次。
 *   · 通知 tag 两族都认；推送 payload 的 proto="floka" 才给新 tag，缺省与现行一样。
 *   · 去重只靠内存，不假设已有 CacheStorage。
 */
import { BROWSER_NAMES } from "./names.js";

export type SwOpen = { kind: "agent"; agent: string; fp: string } | { kind: "ask"; ask: string; fp: string };
export interface SwMessage { type: string; alias?: string; id?: string; agent?: string; ask?: string; fp: string }

const OLD = BROWSER_NAMES.claudestra, NEW = BROWSER_NAMES.floka;

/** proto 缺省 = 旧 SW 的消息原样；proto=floka 补 alias + id */
export function swOpenMessage(o: SwOpen, proto: "" | "floka", id = ""): SwMessage {
  const base: SwMessage = o.kind === "ask" ? { type: OLD.openAsk, ask: o.ask, fp: o.fp } : { type: OLD.openAgent, agent: o.agent, fp: o.fp };
  if (proto !== "floka") return base;
  return { ...base, alias: o.kind === "ask" ? NEW.openAsk : NEW.openAgent, ...(id ? { id } : {}) };
}

/** 新页面收 SW 消息：两族类型都认，同一条（id 相同，或没 id 时内容相同且 2 秒内）只处理一次 */
export class SwMessageInbox {
  private readonly seen = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly windowMs = 2000) {}
  accept(raw: unknown): SwOpen | null {
    const d = raw as Partial<SwMessage> | null;
    if (!d || typeof d !== "object" || typeof d.type !== "string") return null;
    const kind = d.type === OLD.openAgent || d.type === NEW.openAgent ? "agent" : d.type === OLD.openAsk || d.type === NEW.openAsk ? "ask" : null;
    if (!kind) return null;
    const fp = typeof d.fp === "string" ? d.fp : "";
    const open: SwOpen | null = kind === "agent" ? (d.agent ? { kind, agent: String(d.agent), fp } : null) : (d.ask ? { kind, ask: String(d.ask), fp } : null);
    if (!open) return null;
    const key = typeof d.id === "string" && d.id ? `id:${d.id}` : `c:${JSON.stringify(open)}`;
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at > this.windowMs && k.startsWith("c:")) this.seen.delete(k);
    if (this.seen.has(key)) return null;
    if (this.seen.size >= 200) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(key, t);
    return open;
  }
}

/** 通知 tag：payload 自带的优先；没带时按 proto 给缺省 */
export const notificationTag = (tag: unknown, proto: unknown): string =>
  typeof tag === "string" && tag ? tag : proto === "floka" ? NEW.notificationTag : OLD.notificationTag;
