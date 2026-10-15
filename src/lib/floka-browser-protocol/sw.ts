/**
 * Service Worker ↔ 页面的消息与通知 tag（web/public/sw.js 是同一套规则的手写副本：SW 不经打包、web 不 import src，
 * tests/floka-browser-protocol.test.ts 在假 SW 环境里跑 sw.js，对照这里）。
 *   · SW → 页面只发一条消息：type 永远是旧族（旧页面照认），新族类型放在 alias，id 供新页面去重；
 *     旧 SW 发的没有 id / alias，新页面按旧类型认、按内容去重——两种混搭各处理一次。页面侧的双认 + 去重只有一份：
 *     web/lib/sw-inbox.ts（chat.tsx / asks-store.ts 两个监听器调它；类型名与 names.ts 同值，测试钉住）。
 *   · 通知 tag 两族都认；推送 payload 的 proto="floka" 才给新 tag，缺省与现行一样。
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

/** 通知 tag：payload 自带的优先；没带时按 proto 给缺省 */
export const notificationTag = (tag: unknown, proto: unknown): string =>
  typeof tag === "string" && tag ? tag : proto === "floka" ? NEW.notificationTag : OLD.notificationTag;
